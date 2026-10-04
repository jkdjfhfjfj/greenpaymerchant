import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import {
  db,
  emailDeliverySettingsTable,
  financialNotificationEventsTable,
  merchantsTable,
  merchantInvoicesTable,
  merchantTeamInvitationsTable,
  merchantTeamMembersTable,
  paymentLinksTable,
  payoutsTable,
  supportDeliveryOutboxTable,
  supportMessagesTable,
  supportTicketsTable,
  transactionalEmailOutboxTable,
  refundsTable,
  transactionsTable,
  walletPayoutRequestsTable,
  userNotificationsTable,
  type TransactionalEmailOutbox,
} from "@workspace/db";
import {
  financialPayoutTransitionIsCurrent,
  processFinancialNotificationAttempt,
} from "./financial-notification-events";
import { getActiveClerkSecretKey } from "./clerk-config";
export {
  persistFinancialNotificationEvent,
  processFinancialNotificationAttempt,
  type FinancialNotificationEventInput,
  type FinancialNotificationTx,
} from "./financial-notification-events";
import { invoiceOutstandingAmount } from "./merchant-business-tools";
import { assertMerchantActionEnabled } from "./merchant-action-controls";
import { CUSTOMER_REIMBURSED_REFUND_STATUSES } from "./payment-safety";
import { minorToDecimal } from "./wallet-math";
import {
  hasMailtrapToken,
  mailtrapToken,
  MailtrapConfigurationError,
  submitMailtrapEmail,
} from "./mailtrap-provider";
import { ApiError } from "./api-error";
import { credentialVaultReady, decryptSecret, encryptSecret } from "./secret-crypto";
import {
  renderTransactionalEmail,
  type TransactionalEmailPayload,
  type TransactionalTemplate,
} from "./transactional-email-templates";

const LEASE_MS = 60_000;
const FINANCIAL_EVENT_LEASE_MS = 60_000;
const MAX_BACKOFF_MS = 60 * 60 * 1000;
const LEGACY_SUPPORT_ID_OFFSET = 1_000_000_000;

export type TransactionalPurpose =
  | "payment_receipt"
  | "payment_success"
  | "payment_failure"
  | "payout_update"
  | "invoice_reminder"
  | "payment_link_reminder"
  | "payment_failure_recovery"
  | "support_reply"
  | "support_receipt"
  | "merchant_account_update"
  | "team_invitation"
  | "admin_test"
  | "admin_broadcast";

export type EmailDeliveryState = "queued" | "sending" | "sent" | "failed" | "uncertain";

export type FinancialNotificationEvent = typeof financialNotificationEventsTable.$inferSelect;

export type EnqueueTransactionalEmailInput = {
  eventKey: string;
  purpose: TransactionalPurpose;
  recipientEmail: string;
  template: TransactionalTemplate;
  subject?: string;
  payload: TransactionalEmailPayload;
  sendAfter?: Date;
};

export type EnqueueTransactionalEmailResult = {
  id: number;
  deliveryState: EmailDeliveryState | "unconfigured";
};

export type PaymentTransitionNotice = {
  transaction: {
    id: number;
    reference: string;
    merchantId: number | null;
    amount: string | number;
    currency: string;
    status: string;
    customerEmail: string;
    customerName: string | null;
  };
  transition: "success" | "failed";
  authoritativeFacts: {
    reference: string;
    amount: string | number;
    currency: string;
    status: "success" | "failed";
  };
};

export type PayoutTransitionNotice = {
  payout: {
    id: number;
    merchantId: number | null;
    reference: string;
    amount: string | number;
    currency: string;
    status: string;
  };
  previousStatus: string;
};

function normalizedEmail(value: string): string {
  return value.trim().toLowerCase();
}

function isEmail(value: string): boolean {
  return value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function stateOf(row: TransactionalEmailOutbox): EmailDeliveryState {
  return row.deliveryState as EmailDeliveryState;
}

export async function enqueueTransactionalEmail(
  input: EnqueueTransactionalEmailInput,
): Promise<EnqueueTransactionalEmailResult> {
  const eventKey = input.eventKey.trim();
  const recipientEmail = normalizedEmail(input.recipientEmail);
  if (!eventKey || eventKey.length > 240) throw new Error("Transactional email needs a stable event key of at most 240 characters.");
  if (!isEmail(recipientEmail)) throw new Error("Transactional email recipient is not a valid email address.");
  if (!input.subject?.trim() && !input.template) throw new Error("Transactional email needs a subject and template.");
  if (input.sendAfter && Number.isNaN(input.sendAfter.getTime())) throw new Error("Scheduled transactional email time must be valid.");

  const content = renderTransactionalEmail(input.template, input.payload);
  const [created] = await db.insert(transactionalEmailOutboxTable).values({
    eventKey,
    purpose: input.purpose,
    recipientEmail,
    template: input.template,
    subject: input.subject?.trim().slice(0, 200) || content.subject.slice(0, 200),
    payload: input.payload,
    deliveryState: "queued",
    nextAttemptAt: input.sendAfter && input.sendAfter.getTime() > Date.now() ? input.sendAfter : null,
    updatedAt: new Date(),
  }).onConflictDoNothing({ target: transactionalEmailOutboxTable.eventKey }).returning();
  if (created) return { id: created.id, deliveryState: stateOf(created) };

  const [existing] = await db.select().from(transactionalEmailOutboxTable)
    .where(eq(transactionalEmailOutboxTable.eventKey, eventKey)).limit(1);
  if (!existing) throw new Error("Transactional email deduplication record was not available after insert.");
  if (normalizedEmail(existing.recipientEmail) !== recipientEmail || existing.purpose !== input.purpose) {
    throw new Error("Transactional email event key was reused for different recipient or purpose facts.");
  }
  return { id: existing.id, deliveryState: stateOf(existing) };
}

export async function enqueueTransactionalEmailBatch(
  inputs: EnqueueTransactionalEmailInput[],
): Promise<{ queued: number }> {
  if (inputs.length > 10_000) throw new Error("A single email broadcast cannot exceed 10,000 recipients.");
  const seenEventKeys = new Set<string>();
  const rows = inputs.map((input) => {
    const eventKey = input.eventKey.trim();
    const recipientEmail = normalizedEmail(input.recipientEmail);
    if (!eventKey || eventKey.length > 240) throw new Error("Transactional email needs a stable event key of at most 240 characters.");
    if (!isEmail(recipientEmail)) throw new Error("Transactional email recipient is not a valid email address.");
    if (seenEventKeys.has(eventKey)) throw new Error("Transactional email batch contains duplicate event keys.");
    if (input.sendAfter && Number.isNaN(input.sendAfter.getTime())) throw new Error("Scheduled transactional email time must be valid.");
    seenEventKeys.add(eventKey);
    const content = renderTransactionalEmail(input.template, input.payload);
    return {
      eventKey,
      purpose: input.purpose,
      recipientEmail,
      template: input.template,
      subject: input.subject?.trim().slice(0, 200) || content.subject.slice(0, 200),
      payload: input.payload,
      deliveryState: "queued",
      nextAttemptAt: input.sendAfter && input.sendAfter.getTime() > Date.now() ? input.sendAfter : null,
      updatedAt: new Date(),
    };
  });
  let queued = 0;
  for (let offset = 0; offset < rows.length; offset += 250) {
    const created = await db.insert(transactionalEmailOutboxTable)
      .values(rows.slice(offset, offset + 250))
      .onConflictDoNothing({ target: transactionalEmailOutboxTable.eventKey })
      .returning({ id: transactionalEmailOutboxTable.id });
    queued += created.length;
  }
  return { queued };
}

type DeliverySettings = {
  enabled: boolean;
  fromEmail: string | null;
  senderVerified: boolean;
  tokenConfigured: boolean;
  tokenManagedInSettings: boolean;
  ready: boolean;
};

export async function getMailtrapDeliverySettings(): Promise<DeliverySettings> {
  const [stored] = await db.select().from(emailDeliverySettingsTable)
    .where(eq(emailDeliverySettingsTable.id, 1)).limit(1);
  const fromEmail = stored?.fromEmail?.trim() || process.env.FROM_EMAIL?.trim() || null;
  const senderVerified = Boolean(stored?.senderVerifiedAt);
  const tokenManagedInSettings = Boolean(stored?.encryptedMailtrapToken);
  const tokenConfigured = tokenManagedInSettings ? credentialVaultReady() : hasMailtrapToken();
  const enabled = stored?.enabled ?? false;
  return {
    enabled,
    fromEmail,
    senderVerified,
    tokenConfigured,
    tokenManagedInSettings,
    ready: enabled && senderVerified && Boolean(fromEmail && isEmail(fromEmail)) && tokenConfigured,
  };
}

async function configuredMailtrapToken(): Promise<string | null> {
  const [stored] = await db.select({
    encryptedMailtrapToken: emailDeliverySettingsTable.encryptedMailtrapToken,
  }).from(emailDeliverySettingsTable)
    .where(eq(emailDeliverySettingsTable.id, 1)).limit(1);
  if (stored?.encryptedMailtrapToken) return decryptSecret(stored.encryptedMailtrapToken);
  return mailtrapToken();
}

function configuredOfficialBaseUrl(): string | null {
  // Email links only use an explicit deployment URL. Runtime Replit hostnames
  // are intentionally not used because they may be temporary development URLs.
  const configured = process.env.PUBLIC_APP_URL?.trim();
  if (!configured) return null;
  try {
    const url = new URL(configured);
    if (url.protocol !== "https:" || ["localhost", "127.0.0.1"].includes(url.hostname) ||
      url.hostname.endsWith(".replit.dev") || url.hostname.endsWith(".repl.co")) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

function officialStatusUrl(reference: string): string | null {
  const baseUrl = configuredOfficialBaseUrl();
  return baseUrl ? `${baseUrl}/status/${encodeURIComponent(reference)}` : null;
}

async function saveInAppNotice(input: {
  userId: string;
  eventKey: string;
  type: string;
  title: string;
  body: string;
  href: string;
}): Promise<void> {
  await db.insert(userNotificationsTable).values(input).onConflictDoNothing();
}

async function merchantRecipients(merchantId: number): Promise<Array<{
  userId: string;
  email: string | null;
  role: "owner" | "finance";
}>> {
  const [merchant] = await db.select({
    ownerClerkId: merchantsTable.ownerClerkId,
    businessName: merchantsTable.businessName,
  }).from(merchantsTable).where(eq(merchantsTable.id, merchantId)).limit(1);
  if (!merchant) throw new Error(`Merchant ${merchantId} disappeared while resolving financial notification recipients.`);
  const ownerEmail = await verifiedClerkEmailForNotification(merchant.ownerClerkId);
  const finance = await db.select({
    userId: merchantTeamMembersTable.clerkUserId,
    email: merchantTeamMembersTable.email,
  }).from(merchantTeamMembersTable).where(and(
    eq(merchantTeamMembersTable.merchantId, merchantId),
    eq(merchantTeamMembersTable.role, "finance"),
    eq(merchantTeamMembersTable.active, true),
  ));
  return [
    { userId: merchant.ownerClerkId, email: ownerEmail, role: "owner" as const },
    ...finance.map((member) => ({
      userId: member.userId,
      email: isEmail(member.email) ? normalizedEmail(member.email) : null,
      role: "finance" as const,
    })),
  ];
}

async function verifiedClerkEmailForNotification(userId: string): Promise<string | null> {
  const secret = getActiveClerkSecretKey();
  if (!secret) throw new Error("Active Clerk server credentials are required to resolve verified merchant notification email addresses.");
  let response: Response;
  try {
    response = await fetch(`https://api.clerk.com/v1/users/${encodeURIComponent(userId)}`, {
      headers: { Authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    throw new Error("Clerk recipient lookup failed; financial notification processing will retry.");
  }
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`Clerk recipient lookup returned HTTP ${response.status}; financial notification processing will retry.`);
  }
  let user: {
    primary_email_address_id?: string;
    email_addresses?: Array<{ id?: string; email_address?: string; verification?: { status?: string } }>;
  };
  try {
    user = await response.json() as typeof user;
  } catch {
    throw new Error("Clerk recipient lookup returned invalid user data; financial notification processing will retry.");
  }
  const primary = user.email_addresses?.find((item) => item.id === user.primary_email_address_id);
  if (primary?.verification?.status !== "verified" || !primary.email_address) return null;
  return normalizedEmail(primary.email_address);
}

function sameAmount(a: string | number, b: string | number): boolean {
  const canonical = (value: string | number): string => {
    const raw = String(value).trim();
    const parts = raw.match(/^([+-]?)(\d+)(?:\.(\d+))?$/);
    if (!parts) return raw;
    const integer = parts[2].replace(/^0+(?=\d)/, "");
    const fraction = (parts[3] ?? "").replace(/0+$/, "");
    return `${parts[1]}${integer}${fraction ? `.${fraction}` : ""}`;
  };
  return canonical(a) === canonical(b);
}

/**
 * Called only after markTransactionStatus committed a real transition.
 * A customer receipt additionally re-reads and matches the exact confirmed
 * transaction facts; merchant notices use trusted owner/finance addresses.
 */
export async function notifyPaymentTransition(input: PaymentTransitionNotice): Promise<void> {
  const { transaction, authoritativeFacts, transition } = input;
  if (transaction.status !== transition || authoritativeFacts.status !== transition ||
    transaction.reference !== authoritativeFacts.reference ||
    !sameAmount(transaction.amount, authoritativeFacts.amount) ||
    transaction.currency.toUpperCase() !== authoritativeFacts.currency.toUpperCase()) {
    throw new Error("Payment notification facts do not match the committed transaction transition.");
  }
  const [persisted] = await db.select().from(transactionsTable)
    .where(and(
      eq(transactionsTable.id, transaction.id),
      eq(transactionsTable.reference, authoritativeFacts.reference),
    )).limit(1);
  if (!persisted || !sameAmount(persisted.amount, authoritativeFacts.amount) ||
    persisted.currency.toUpperCase() !== authoritativeFacts.currency.toUpperCase()) {
    throw new Error("Payment notification facts no longer match the authoritative transaction record.");
  }
  if (persisted.status !== transition) {
    const [source] = await db.select({
      id: financialNotificationEventsTable.id,
      amount: financialNotificationEventsTable.amount,
      currency: financialNotificationEventsTable.currency,
    }).from(financialNotificationEventsTable)
      .where(and(
        eq(financialNotificationEventsTable.transactionId, transaction.id),
        eq(financialNotificationEventsTable.eventType, transition === "success" ? "payment.success" : "payment.failed"),
        eq(financialNotificationEventsTable.reference, authoritativeFacts.reference),
        eq(financialNotificationEventsTable.status, transition),
      )).limit(1);
    if (!source || !sameAmount(source.amount, authoritativeFacts.amount) ||
      source.currency.toUpperCase() !== authoritativeFacts.currency.toUpperCase()) {
      throw new Error("Payment transition changed without a matching committed financial notification source event.");
    }
  }

  const eventSuffix = transition === "success" ? "success" : "failed";
  const purpose: TransactionalPurpose = transition === "success" ? "payment_success" : "payment_failure";
  const template: TransactionalTemplate = transition === "success" ? "payment_success" : "payment_failure";
  const businessName = transaction.merchantId
    ? (await db.select({ name: merchantsTable.businessName }).from(merchantsTable)
      .where(eq(merchantsTable.id, transaction.merchantId)).limit(1))[0]?.name ?? "Your business"
    : "Your business";
  const merchantNotice = transition === "success"
    ? { type: "payment_confirmed", title: "Payment confirmed", body: `Payment ${transaction.reference} has been confirmed.` }
    : { type: "payment_failed", title: "Payment failed", body: `Payment ${transaction.reference} was not completed.` };

  let merchantNotificationError: unknown;
  if (transaction.merchantId !== null) {
    const recipients = await merchantRecipients(transaction.merchantId);
    const merchantResults = await Promise.allSettled(recipients.map(async (recipient) => {
      const noticeKey = `payment:${transaction.reference}:${eventSuffix}`;
      await saveInAppNotice({
        userId: recipient.userId,
        eventKey: noticeKey,
        type: merchantNotice.type,
        title: merchantNotice.title,
        body: merchantNotice.body,
        href: "/merchant/transactions",
      });
      if (recipient.email) {
        await enqueueTransactionalEmail({
          eventKey: `${noticeKey}:merchant:${recipient.userId}`,
          purpose,
          recipientEmail: recipient.email,
          template,
          payload: {
            businessName,
            reference: transaction.reference,
            amount: persisted.amount,
            currency: persisted.currency,
          },
        });
      }
    }));
    merchantNotificationError = merchantResults.find((result) => result.status === "rejected")?.reason;
  }

  let customerEnqueueError: unknown;
  if (transition === "success" && isEmail(transaction.customerEmail)) {
    try {
      await enqueueTransactionalEmail({
        eventKey: `payment:${transaction.reference}:customer-receipt`,
        purpose: "payment_receipt",
        recipientEmail: transaction.customerEmail,
        template: "payment_receipt",
        payload: {
          reference: persisted.reference,
          amount: persisted.amount,
          currency: persisted.currency,
          customerName: transaction.customerName,
          receiptUrl: officialStatusUrl(persisted.reference),
        },
      });
    } catch (error) {
      customerEnqueueError = error;
    }
  }
  if (customerEnqueueError) throw customerEnqueueError;
  if (merchantNotificationError) throw merchantNotificationError;
}

/** Call only from the worker that committed an actual payout status change. */
export async function notifyPayoutTransition(input: PayoutTransitionNotice): Promise<void> {
  const { payout, previousStatus } = input;
  if (previousStatus === payout.status || payout.merchantId === null) {
    throw new Error("Payout notifier requires a committed status change for a merchant payout.");
  }
  const [persisted] = await db.select().from(payoutsTable)
    .where(and(
      eq(payoutsTable.id, payout.id),
      eq(payoutsTable.reference, payout.reference),
    )).limit(1);
  if (!persisted || persisted.merchantId !== payout.merchantId ||
    !sameAmount(persisted.amount, payout.amount) ||
    persisted.currency.toUpperCase() !== payout.currency.toUpperCase()) {
    throw new Error("Payout notification facts do not match the authoritative payout record.");
  }
  if (persisted.status !== payout.status) {
    const [source] = await db.select({
      id: financialNotificationEventsTable.id,
      amount: financialNotificationEventsTable.amount,
      currency: financialNotificationEventsTable.currency,
    }).from(financialNotificationEventsTable)
      .where(and(
        eq(financialNotificationEventsTable.payoutId, payout.id),
        eq(financialNotificationEventsTable.eventType, "payout.transition"),
        eq(financialNotificationEventsTable.reference, payout.reference),
        eq(financialNotificationEventsTable.previousStatus, previousStatus),
        eq(financialNotificationEventsTable.status, payout.status),
      )).limit(1);
    if (!source || !sameAmount(source.amount, payout.amount) ||
      source.currency.toUpperCase() !== payout.currency.toUpperCase()) {
      throw new Error("Payout transition changed without a matching committed financial notification source event.");
    }
    return;
  }
  const [merchant] = await db.select({ name: merchantsTable.businessName }).from(merchantsTable)
    .where(eq(merchantsTable.id, payout.merchantId)).limit(1);
  const recipients = await merchantRecipients(payout.merchantId);
  const eventKey = `payout:${payout.reference}:${payout.status}`;
  await Promise.all(recipients.map(async (recipient) => {
    await saveInAppNotice({
      userId: recipient.userId,
      eventKey,
      type: "payout_update",
      title: "Payout status updated",
      body: `Payout ${payout.reference} is ${payout.status}.`,
      href: "/merchant/payouts",
    });
    if (recipient.email) {
      await enqueueTransactionalEmail({
        eventKey: `${eventKey}:merchant:${recipient.userId}`,
        purpose: "payout_update",
        recipientEmail: recipient.email,
        template: "payout_update",
        payload: {
          businessName: merchant?.name ?? "Your business",
          reference: payout.reference,
          status: payout.status,
          amount: persisted.amount,
          currency: persisted.currency,
        },
      });
    }
  }));
}

/**
 * Wallet payout state notifications are separate from legacy/platform payouts.
 * This helper is called only after the reserving/decision transaction commits;
 * it re-reads the wallet request before writing stable-deduped notices.
 */
export async function notifyWalletPayoutTransition(input: PayoutTransitionNotice): Promise<void> {
  const { payout, previousStatus } = input;
  if (previousStatus === payout.status || payout.merchantId === null) {
    throw new Error("Wallet payout notifier requires a committed status change for a merchant wallet payout.");
  }
  const [persisted] = await db.select().from(walletPayoutRequestsTable)
    .where(and(
      eq(walletPayoutRequestsTable.id, payout.id),
      eq(walletPayoutRequestsTable.reference, payout.reference),
    )).limit(1);
  if (!persisted || persisted.merchantId !== payout.merchantId ||
    minorToDecimal(persisted.amountMinor) !== String(payout.amount).trim() ||
    persisted.currency.toUpperCase() !== payout.currency.toUpperCase()) {
    throw new Error("Wallet payout notification facts do not match the authoritative committed request.");
  }
  if (persisted.status !== payout.status) {
    const [source] = await db.select({
      id: financialNotificationEventsTable.id,
      amount: financialNotificationEventsTable.amount,
      currency: financialNotificationEventsTable.currency,
    }).from(financialNotificationEventsTable).where(and(
      eq(financialNotificationEventsTable.walletPayoutRequestId, payout.id),
      eq(financialNotificationEventsTable.eventType, "wallet_payout.transition"),
      eq(financialNotificationEventsTable.reference, payout.reference),
      eq(financialNotificationEventsTable.previousStatus, previousStatus),
      eq(financialNotificationEventsTable.status, payout.status),
    )).limit(1);
    if (!source || !sameAmount(source.amount, payout.amount) ||
      source.currency.toUpperCase() !== payout.currency.toUpperCase()) {
      throw new Error("Wallet payout transition changed without a matching committed financial notification source event.");
    }
    return;
  }
  const [merchant] = await db.select({ name: merchantsTable.businessName }).from(merchantsTable)
    .where(eq(merchantsTable.id, payout.merchantId)).limit(1);
  const recipients = await merchantRecipients(payout.merchantId);
  const eventKey = `wallet-payout:${payout.reference}:${payout.status}`;
  const amount = minorToDecimal(persisted.amountMinor);
  await Promise.all(recipients.map(async (recipient) => {
    await saveInAppNotice({
      userId: recipient.userId,
      eventKey,
      type: "payout_update",
      title: "Wallet payout status updated",
      body: `Wallet payout ${payout.reference} is ${payout.status}.`,
      href: "/merchant/payouts",
    });
    if (recipient.email) {
      await enqueueTransactionalEmail({
        eventKey: `${eventKey}:merchant:${recipient.userId}`,
        purpose: "payout_update",
        recipientEmail: recipient.email,
        template: "payout_update",
        payload: {
          businessName: merchant?.name ?? "Your business",
          reference: payout.reference,
          status: payout.status,
          amount,
          currency: persisted.currency,
        },
      });
    }
  }));
}

/** Integration hook for invitation writers; never call from invitation reads. */
export async function notifyTeamInvitation(input: {
  invitationId: number;
  merchantId: number;
  recipientEmail: string;
  inviteUrl: string;
  role: string;
  expiresAt: Date;
  inviterName?: string;
}): Promise<void> {
  if (!Number.isSafeInteger(input.invitationId) || input.invitationId < 1) {
    throw new Error("Team invitation notification requires its persisted invitation id.");
  }
  if (input.role !== "finance" && input.role !== "viewer") {
    throw new Error("Team invitation requires a supported persisted merchant role.");
  }
  const [merchant] = await db.select({ name: merchantsTable.businessName }).from(merchantsTable)
    .where(eq(merchantsTable.id, input.merchantId)).limit(1);
  const [invitation] = await db.select().from(merchantTeamInvitationsTable)
    .where(and(
      eq(merchantTeamInvitationsTable.id, input.invitationId),
      eq(merchantTeamInvitationsTable.merchantId, input.merchantId),
      eq(merchantTeamInvitationsTable.email, normalizedEmail(input.recipientEmail)),
      eq(merchantTeamInvitationsTable.role, input.role),
      isNull(merchantTeamInvitationsTable.acceptedAt),
      isNull(merchantTeamInvitationsTable.revokedAt),
    )).limit(1);
  if (!merchant || !invitation || !isEmail(normalizedEmail(input.recipientEmail)) ||
    invitation.expiresAt.getTime() !== input.expiresAt.getTime() || invitation.expiresAt <= new Date()) {
    throw new Error("Team invitation has no trusted merchant or valid persisted recipient address.");
  }
  const expectedOrigin = configuredOfficialBaseUrl();
  let inviteUrl: URL;
  try {
    inviteUrl = new URL(input.inviteUrl);
  } catch {
    throw new Error("Team invitation URL is invalid.");
  }
  if (!expectedOrigin || inviteUrl.protocol !== "https:" || inviteUrl.origin !== expectedOrigin) {
    throw new Error("Team invitation email requires the known official HTTPS deployment URL; development links are not sent.");
  }
  const token = inviteUrl.searchParams.get("token");
  if (!token || createHash("sha256").update(token).digest("hex") !== invitation.tokenHash) {
    throw new Error("Team invitation URL does not match the persisted invitation token.");
  }
  await enqueueTransactionalEmail({
    eventKey: `team-invitation:${input.invitationId}`,
    purpose: "team_invitation",
    recipientEmail: input.recipientEmail,
    template: "team_invitation",
    payload: {
      businessName: merchant.name,
      inviteUrl: inviteUrl.toString(),
      role: input.role,
      expiresAt: input.expiresAt.toISOString(),
      inviterName: input.inviterName ?? "A Greenpay administrator",
    },
  });
}

export async function saveAdminEmailDeliverySettings(input: {
  enabled?: boolean;
  fromEmail?: string;
  senderVerified?: boolean;
  apiToken?: string;
  clearApiToken?: boolean;
  actorId: string;
}): Promise<void> {
  if (input.apiToken !== undefined && input.clearApiToken === true) {
    throw new Error("Provide a new Mailtrap key or remove the saved key, not both.");
  }
  const apiToken = input.apiToken?.trim();
  if (input.apiToken !== undefined && !apiToken) {
    throw new Error("Enter a non-empty Mailtrap API key.");
  }
  const [current] = await db.select().from(emailDeliverySettingsTable)
    .where(eq(emailDeliverySettingsTable.id, 1)).limit(1);
  const encryptedMailtrapToken = input.clearApiToken === true
    ? null
    : apiToken
      ? encryptSecret(apiToken)
      : current?.encryptedMailtrapToken ?? null;
  const fromEmail = input.fromEmail === undefined ? current?.fromEmail ?? null : normalizedEmail(input.fromEmail);
  if (input.fromEmail !== undefined && !isEmail(fromEmail ?? "")) {
    throw new Error("Enter a valid sender email address.");
  }
  if (input.fromEmail !== undefined && input.senderVerified !== true) {
    throw new Error("Confirm that this sender is verified in Mailtrap before saving it.");
  }
  const senderVerifiedAt = input.fromEmail !== undefined
    ? new Date()
    : current?.senderVerifiedAt ?? null;
  const senderVerifiedBy = input.fromEmail !== undefined
    ? input.actorId
    : current?.senderVerifiedBy ?? null;
  const enabled = input.enabled ?? current?.enabled ?? false;
  if (enabled && !(fromEmail && senderVerifiedAt)) {
    throw new Error("Configure and confirm a verified Mailtrap sender before enabling transactional email.");
  }
  await db.insert(emailDeliverySettingsTable).values({
    id: 1,
    enabled,
    fromEmail,
    encryptedMailtrapToken,
    senderVerifiedAt,
    senderVerifiedBy,
    updatedBy: input.actorId,
    updatedAt: new Date(),
  }).onConflictDoUpdate({
    target: emailDeliverySettingsTable.id,
    set: {
      enabled,
      fromEmail,
      encryptedMailtrapToken,
      senderVerifiedAt,
      senderVerifiedBy,
      updatedBy: input.actorId,
      updatedAt: new Date(),
    },
  });
}

export async function getEmailDeliveryCounts(): Promise<{
  queued: number; sending: number; sent: number; failed: number; uncertain: number; heldForReview: number;
}> {
  const [row] = await db.select({
    queued: sql<number>`count(*) filter (where ${transactionalEmailOutboxTable.deliveryState} = 'queued')::int`,
    sending: sql<number>`count(*) filter (where ${transactionalEmailOutboxTable.deliveryState} = 'sending')::int`,
    sent: sql<number>`count(*) filter (where ${transactionalEmailOutboxTable.deliveryState} = 'sent')::int`,
    failed: sql<number>`count(*) filter (where ${transactionalEmailOutboxTable.deliveryState} = 'failed')::int`,
    uncertain: sql<number>`count(*) filter (where ${transactionalEmailOutboxTable.deliveryState} = 'uncertain')::int`,
  }).from(transactionalEmailOutboxTable);
  const [held] = await db.select({ count: sql<number>`count(*)::int` })
    .from(supportDeliveryOutboxTable).where(eq(supportDeliveryOutboxTable.deliveryState, "unconfigured"));
  return {
    queued: Number(row?.queued ?? 0),
    sending: Number(row?.sending ?? 0),
    sent: Number(row?.sent ?? 0),
    failed: Number(row?.failed ?? 0),
    uncertain: Number(row?.uncertain ?? 0),
    heldForReview: Number(held?.count ?? 0),
  };
}

function nextBackoff(attempts: number): Date {
  const delay = Math.min(5_000 * (2 ** Math.max(0, attempts - 1)), MAX_BACKOFF_MS);
  return new Date(Date.now() + delay);
}

async function recoverExpiredLeases(now = new Date()): Promise<number> {
  const recovered = await db.update(transactionalEmailOutboxTable).set({
    deliveryState: "uncertain",
    retryable: false,
    leaseOwner: null,
    leaseUntil: null,
    lastError: "Worker lease expired after provider submission may have begun. Automatic resubmission is held for review.",
    updatedAt: now,
  }).where(and(
    eq(transactionalEmailOutboxTable.deliveryState, "sending"),
    lte(transactionalEmailOutboxTable.leaseUntil, now),
  )).returning({ payload: transactionalEmailOutboxTable.payload });
  await Promise.all(recovered.map((row) => updateLinkedSupportDelivery(row, "uncertain")));
  return recovered.length;
}

type ClaimOptions = { id?: number; explicit?: boolean };

async function claimEmail(owner: string, options: ClaimOptions = {}): Promise<TransactionalEmailOutbox | null> {
  const now = new Date();
  return db.transaction(async (tx) => {
    const dueFailed = and(
      eq(transactionalEmailOutboxTable.deliveryState, "failed"),
      eq(transactionalEmailOutboxTable.retryable, true),
      or(isNull(transactionalEmailOutboxTable.nextAttemptAt), lte(transactionalEmailOutboxTable.nextAttemptAt, now)),
    );
    const dueQueued = and(
      eq(transactionalEmailOutboxTable.deliveryState, "queued"),
      or(isNull(transactionalEmailOutboxTable.nextAttemptAt), lte(transactionalEmailOutboxTable.nextAttemptAt, now)),
    );
    const candidates = await tx.select().from(transactionalEmailOutboxTable).where(and(
      options.id === undefined ? undefined : eq(transactionalEmailOutboxTable.id, options.id),
      or(dueQueued, dueFailed),
    )).orderBy(asc(transactionalEmailOutboxTable.createdAt))
      .limit(1).for("update", { skipLocked: true });
    const candidate = candidates[0];
    if (!candidate) return null;
    const [claimed] = await tx.update(transactionalEmailOutboxTable).set({
      deliveryState: "sending",
      attempts: candidate.attempts + 1,
      leaseOwner: owner,
      leaseUntil: new Date(now.getTime() + LEASE_MS),
      lastError: null,
      nextAttemptAt: null,
      updatedAt: now,
    }).where(and(
      eq(transactionalEmailOutboxTable.id, candidate.id),
      or(dueQueued, dueFailed),
    )).returning();
    return claimed ?? null;
  });
}

async function updateOwnedOutbox(
  row: TransactionalEmailOutbox,
  leaseOwner: string,
  update: Partial<typeof transactionalEmailOutboxTable.$inferInsert>,
): Promise<void> {
  await db.update(transactionalEmailOutboxTable).set({
    ...update,
    leaseOwner: null,
    leaseUntil: null,
    updatedAt: new Date(),
  }).where(and(
    eq(transactionalEmailOutboxTable.id, row.id),
    eq(transactionalEmailOutboxTable.deliveryState, "sending"),
    eq(transactionalEmailOutboxTable.leaseOwner, leaseOwner),
  ));
  await updateLinkedSupportDelivery(row, String(update.deliveryState ?? "sending"));
}

async function updateLinkedSupportDelivery(
  row: Pick<TransactionalEmailOutbox, "payload">,
  state: string,
): Promise<void> {
  const messageId = Number(row.payload.messageId);
  const ticketId = Number(row.payload.ticketId);
  if (!Number.isSafeInteger(messageId) || messageId < 1) return;
  await db.update(supportMessagesTable).set({
    emailDeliveryState: state,
  }).where(eq(supportMessagesTable.id, messageId));
  if (Number.isSafeInteger(ticketId) && ticketId > 0) {
    await db.update(supportTicketsTable).set({
      emailDeliveryState: state,
    }).where(eq(supportTicketsTable.id, ticketId));
  }
}

async function submitClaimed(row: TransactionalEmailOutbox, leaseOwner: string): Promise<EmailDeliveryState> {
  await updateLinkedSupportDelivery(row, "sending");
  let payload = row.payload as TransactionalEmailPayload;
  if (row.template === "invoice_reminder") {
    const invoiceId = Number(payload.invoiceId);
    const merchantId = Number(payload.merchantId);
    const expectedAmount = Number(payload.amount);
    const officialBase = configuredOfficialBaseUrl();
    const [invoice] = Number.isSafeInteger(invoiceId) && invoiceId > 0 && Number.isSafeInteger(merchantId) && merchantId > 0
      ? await db.select().from(merchantInvoicesTable).where(and(
        eq(merchantInvoicesTable.id, invoiceId),
        eq(merchantInvoicesTable.merchantId, merchantId),
        eq(merchantInvoicesTable.customerEmail, row.recipientEmail),
      )).limit(1)
      : [];
    const [merchant] = Number.isSafeInteger(merchantId) && merchantId > 0
      ? await db.select({ businessName: merchantsTable.businessName }).from(merchantsTable)
        .where(eq(merchantsTable.id, merchantId)).limit(1)
      : [];
    let actionError: string | null = null;
    if (invoice && merchant) {
      try {
        await assertMerchantActionEnabled(merchantId, "invoices");
        await assertMerchantActionEnabled(merchantId, "reminders");
      } catch (error) {
        actionError = error instanceof Error
          ? error.message
          : "Invoice reminder actions are disabled for this merchant.";
      }
    }
    let outstanding = 0;
    let paymentUrl: string | null = null;
    if (!actionError && invoice?.paymentLinkId && merchant && officialBase && ["sent", "partially_paid"].includes(invoice.status)) {
      const [link] = await db.select().from(paymentLinksTable).where(and(
        eq(paymentLinksTable.id, invoice.paymentLinkId),
        eq(paymentLinksTable.merchantId, merchantId),
        eq(paymentLinksTable.status, "active"),
      )).limit(1);
      const [pending] = await db.select({ id: transactionsTable.id }).from(transactionsTable).where(and(
        eq(transactionsTable.merchantId, merchantId),
        eq(transactionsTable.paymentLinkId, invoice.paymentLinkId),
        eq(transactionsTable.status, "pending"),
      )).limit(1);
      if (link && !pending && (!link.expiresAt || link.expiresAt > new Date())) {
        const collectedRows = await db.select().from(transactionsTable).where(and(
          eq(transactionsTable.merchantId, merchantId),
          eq(transactionsTable.paymentLinkId, invoice.paymentLinkId),
          inArray(transactionsTable.status, ["success", "refunded"]),
        ));
        const collected = collectedRows.reduce((sum, transaction) => sum + (transaction.paidAt ? Number(transaction.amount) : 0), 0);
        let refunded = 0;
        for (const transaction of collectedRows) {
          const confirmedRefunds = await db.select({ amount: refundsTable.amount }).from(refundsTable).where(and(
            eq(refundsTable.originalReference, transaction.reference),
            inArray(refundsTable.status, [...CUSTOMER_REIMBURSED_REFUND_STATUSES]),
          ));
          refunded += confirmedRefunds.reduce((sum, refund) => sum + Number(refund.amount), 0);
        }
        outstanding = invoiceOutstandingAmount(invoice.total, Math.max(0, Math.min(invoice.total, collected - refunded)));
        const expectedLink = new URL(`/pay/${encodeURIComponent(link.slug)}`, officialBase).toString();
        const linkMatches = link.amountType === "fixed" &&
          link.currency.toUpperCase() === invoice.currency.toUpperCase() &&
          Number(link.amount) === outstanding &&
          Number(invoice.paymentLinkAmount ?? link.amount) === outstanding;
        const factsMatch = payload.invoiceReference === invoice.reference &&
          String(payload.currency).toUpperCase() === invoice.currency.toUpperCase() &&
          String(payload.dueDate) === invoice.dueDate &&
          Number.isFinite(expectedAmount) && expectedAmount.toFixed(2) === outstanding.toFixed(2);
        if (linkMatches && factsMatch) paymentUrl = expectedLink;
      }
    }
    if (!invoice || !merchant || actionError || !paymentUrl || outstanding <= 0) {
      await updateOwnedOutbox(row, leaseOwner, {
        deliveryState: "failed",
        retryable: false,
        lastError: actionError ?? "Invoice, outstanding balance, or official payment link changed before the reminder could be delivered; the email was held without sending.",
      });
      return "failed";
    }
    payload = {
      ...payload,
      businessName: merchant.businessName,
      customerName: invoice.customerName,
      invoiceReference: invoice.reference,
      amount: outstanding.toFixed(2),
      currency: invoice.currency,
      dueDate: invoice.dueDate,
      paymentUrl,
    };
  }
  const settings = await getMailtrapDeliverySettings();
  if (!settings.fromEmail || !settings.senderVerified || !settings.tokenConfigured) {
    await updateOwnedOutbox(row, leaseOwner, {
      deliveryState: "failed",
      retryable: false,
      lastError: !settings.tokenConfigured
        ? "Mailtrap credentials are missing. Add a key in Email Delivery settings or configure MAILTRAP_API_TOKEN (or MAILTRAP_API_KEY) on the server before retrying."
        : "A Mailtrap sender must be configured and explicitly confirmed before retrying.",
    });
    return "failed";
  }
  let apiToken: string | null;
  try {
    apiToken = await configuredMailtrapToken();
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    await updateOwnedOutbox(row, leaseOwner, {
      deliveryState: "failed",
      retryable: false,
      lastError: "The saved Mailtrap API key could not be decrypted. Replace or remove it in Email Delivery settings.",
    });
    return "failed";
  }
  if (!apiToken) {
    await updateOwnedOutbox(row, leaseOwner, {
      deliveryState: "failed",
      retryable: false,
      lastError: "Mailtrap credentials are missing. Add a key in Email Delivery settings or configure a server environment variable.",
    });
    return "failed";
  }
  const content = renderTransactionalEmail(row.template, payload);
  const result = await submitMailtrapEmail({
    fromEmail: settings.fromEmail,
    fromName: "Greenpay",
    toEmail: row.recipientEmail,
    subject: row.subject || content.subject,
    text: content.text,
    html: content.html,
    category: row.purpose,
  }, { apiToken });
  if (result.kind === "accepted") {
    await updateOwnedOutbox(row, leaseOwner, {
      deliveryState: "sent",
      retryable: false,
      providerMessageId: result.messageId,
      sentAt: new Date(),
      lastError: null,
    });
    return "sent";
  }
  if (result.kind === "uncertain") {
    await updateOwnedOutbox(row, leaseOwner, {
      deliveryState: "uncertain",
      retryable: false,
      lastError: result.message.slice(0, 1000),
    });
    return "uncertain";
  }
  await updateOwnedOutbox(row, leaseOwner, {
    deliveryState: "failed",
    retryable: result.retryable,
    nextAttemptAt: result.retryable
      ? new Date(Date.now() + Math.max(result.retryAfterMs ?? 0, nextBackoff(row.attempts).getTime() - Date.now()))
      : null,
    lastError: result.message.slice(0, 1000),
  });
  return "failed";
}

async function claimAndSubmit(options: ClaimOptions = {}): Promise<{
  id: number;
  deliveryState: EmailDeliveryState;
} | null> {
  const settings = await getMailtrapDeliverySettings();
  if (!options.explicit && !settings.ready) return null;
  if (!settings.tokenConfigured) {
    throw new MailtrapConfigurationError(
      "Mailtrap email delivery is not configured. Add a key in Email Delivery settings or set MAILTRAP_API_TOKEN (or MAILTRAP_API_KEY) on the API server.",
    );
  }
  if (!settings.fromEmail || !settings.senderVerified) {
    throw new MailtrapConfigurationError(
      "Configure and confirm a verified FROM_EMAIL sender in admin email-delivery settings before sending.",
    );
  }
  const leaseOwner = randomUUID();
  const row = await claimEmail(leaseOwner, options);
  if (!row) return null;
  return { id: row.id, deliveryState: await submitClaimed(row, leaseOwner) };
}

export async function dispatchQueuedTransactionalEmails(limit = 10): Promise<number> {
  const settings = await getMailtrapDeliverySettings();
  await recoverExpiredLeases();
  if (!settings.ready) return 0;
  let processed = 0;
  for (let index = 0; index < Math.min(100, Math.max(1, Math.trunc(limit))); index += 1) {
    const result = await claimAndSubmit();
    if (!result) break;
    processed += 1;
  }
  return processed;
}

async function recoverExpiredFinancialEventLeases(now = new Date()): Promise<number> {
  const recovered = await db.update(financialNotificationEventsTable).set({
    deliveryState: "queued",
    leaseOwner: null,
    leaseUntil: null,
    nextAttemptAt: now,
    lastError: "Notification processor lease expired; idempotent event processing will resume.",
    updatedAt: now,
  }).where(and(
    eq(financialNotificationEventsTable.deliveryState, "processing"),
    lte(financialNotificationEventsTable.leaseUntil, now),
  )).returning({ id: financialNotificationEventsTable.id });
  return recovered.length;
}

async function claimFinancialNotificationEvent(owner: string): Promise<FinancialNotificationEvent | null> {
  const now = new Date();
  return db.transaction(async (tx) => {
    const [candidate] = await tx.select().from(financialNotificationEventsTable).where(and(
      eq(financialNotificationEventsTable.deliveryState, "queued"),
      or(isNull(financialNotificationEventsTable.nextAttemptAt), lte(financialNotificationEventsTable.nextAttemptAt, now)),
    )).orderBy(asc(financialNotificationEventsTable.createdAt))
      .limit(1).for("update", { skipLocked: true });
    if (!candidate) return null;
    const [claimed] = await tx.update(financialNotificationEventsTable).set({
      deliveryState: "processing",
      attempts: candidate.attempts + 1,
      leaseOwner: owner,
      leaseUntil: new Date(now.getTime() + FINANCIAL_EVENT_LEASE_MS),
      nextAttemptAt: null,
      lastError: null,
      updatedAt: now,
    }).where(and(
      eq(financialNotificationEventsTable.id, candidate.id),
      eq(financialNotificationEventsTable.deliveryState, "queued"),
    )).returning();
    return claimed ?? null;
  });
}

async function deliverFinancialNotificationEvent(event: FinancialNotificationEvent): Promise<void> {
  if (event.eventType === "payment.success" || event.eventType === "payment.failed") {
    const transition = event.eventType === "payment.success" ? "success" : "failed";
    if (event.transactionId === null || event.status !== transition) {
      throw new Error("Financial payment notification source event is incomplete.");
    }
    const [transaction] = await db.select().from(transactionsTable).where(and(
      eq(transactionsTable.id, event.transactionId),
      eq(transactionsTable.reference, event.reference),
    )).limit(1);
    if (!transaction || !sameAmount(transaction.amount, event.amount) ||
      transaction.currency.toUpperCase() !== event.currency.toUpperCase()) {
      throw new Error("Financial payment notification could not match its source transaction.");
    }
    await notifyPaymentTransition({
      transaction: {
        id: transaction.id,
        reference: event.reference,
        merchantId: transaction.merchantId,
        amount: event.amount,
        currency: event.currency,
        status: transition,
        customerEmail: transaction.customerEmail,
        customerName: transaction.customerName,
      },
      transition,
      authoritativeFacts: {
        reference: event.reference,
        amount: event.amount,
        currency: event.currency,
        status: transition,
      },
    });
    return;
  }
  if (event.eventType === "payout.transition") {
    if (event.payoutId === null || !event.previousStatus || event.previousStatus === event.status) {
      throw new Error("Financial payout notification source event is incomplete.");
    }
    const [payout] = await db.select().from(payoutsTable).where(and(
      eq(payoutsTable.id, event.payoutId),
      eq(payoutsTable.reference, event.reference),
    )).limit(1);
    if (!payout || payout.merchantId === null || !sameAmount(payout.amount, event.amount) ||
      payout.currency.toUpperCase() !== event.currency.toUpperCase()) {
      throw new Error("Financial payout notification could not match its source payout.");
    }
    if (!financialPayoutTransitionIsCurrent(event.status, payout.status)) return;
    await notifyPayoutTransition({
      payout: {
        id: payout.id,
        merchantId: payout.merchantId,
        reference: event.reference,
        amount: event.amount,
        currency: event.currency,
        status: event.status,
      },
      previousStatus: event.previousStatus,
    });
    return;
  }
  if (event.eventType === "wallet_payout.transition") {
    if (event.walletPayoutRequestId === null || !event.previousStatus || event.previousStatus === event.status) {
      throw new Error("Financial wallet payout notification source event is incomplete.");
    }
    const [payout] = await db.select().from(walletPayoutRequestsTable).where(and(
      eq(walletPayoutRequestsTable.id, event.walletPayoutRequestId),
      eq(walletPayoutRequestsTable.reference, event.reference),
    )).limit(1);
    if (!payout || payout.merchantId === null ||
      minorToDecimal(payout.amountMinor) !== String(event.amount).trim() ||
      payout.currency.toUpperCase() !== event.currency.toUpperCase()) {
      throw new Error("Financial wallet payout notification could not match its source payout.");
    }
    if (!financialPayoutTransitionIsCurrent(event.status, payout.status)) return;
    await notifyWalletPayoutTransition({
      payout: {
        id: payout.id,
        merchantId: payout.merchantId,
        reference: event.reference,
        amount: event.amount,
        currency: event.currency,
        status: event.status,
      },
      previousStatus: event.previousStatus,
    });
    return;
  }
  throw new Error(`Unsupported financial notification event type: ${event.eventType}`);
}

export async function processFinancialNotificationEvents(limit = 25): Promise<{
  processed: number;
  retried: number;
}> {
  await recoverExpiredFinancialEventLeases();
  let processed = 0;
  let retried = 0;
  const boundedLimit = Math.min(100, Math.max(1, Math.trunc(limit)));
  for (let index = 0; index < boundedLimit; index += 1) {
    const owner = randomUUID();
    const event = await claimFinancialNotificationEvent(owner);
    if (!event) break;
    const outcome = await processFinancialNotificationAttempt(event, {
      deliver: deliverFinancialNotificationEvent,
      complete: async (claimedEvent) => {
        const [completed] = await db.update(financialNotificationEventsTable).set({
          deliveryState: "processed",
          processedAt: new Date(),
          leaseOwner: null,
          leaseUntil: null,
          lastError: null,
          updatedAt: new Date(),
        }).where(and(
          eq(financialNotificationEventsTable.id, claimedEvent.id),
          eq(financialNotificationEventsTable.deliveryState, "processing"),
          eq(financialNotificationEventsTable.leaseOwner, owner),
        )).returning({ id: financialNotificationEventsTable.id });
        return Boolean(completed);
      },
      scheduleRetry: async (claimedEvent, error) => {
        const now = new Date();
        const delay = Math.min(5_000 * (2 ** Math.max(0, claimedEvent.attempts - 1)), MAX_BACKOFF_MS);
        const message = error instanceof Error ? error.message : "Unknown financial notification processing failure.";
        const [scheduled] = await db.update(financialNotificationEventsTable).set({
          deliveryState: "queued",
          nextAttemptAt: new Date(now.getTime() + delay),
          leaseOwner: null,
          leaseUntil: null,
          lastError: message.slice(0, 1000),
          updatedAt: now,
        }).where(and(
          eq(financialNotificationEventsTable.id, claimedEvent.id),
          eq(financialNotificationEventsTable.deliveryState, "processing"),
          eq(financialNotificationEventsTable.leaseOwner, owner),
        )).returning({ id: financialNotificationEventsTable.id });
        return Boolean(scheduled);
      },
    });
    if (outcome === "processed") processed += 1;
    else retried += 1;
  }
  return { processed, retried };
}

export async function sendExplicitAdminEmailTest(input: {
  recipientEmail: string;
  actorId: string;
}): Promise<{ accepted: boolean; deliveryState: EmailDeliveryState; detail: string }> {
  const settings = await getMailtrapDeliverySettings();
  if (!settings.tokenConfigured) {
    throw new MailtrapConfigurationError(
      "Mailtrap email delivery is not configured. Set MAILTRAP_API_TOKEN (or MAILTRAP_API_KEY) on the API server.",
    );
  }
  if (!settings.fromEmail || !settings.senderVerified) {
    throw new MailtrapConfigurationError(
      "Configure and confirm a verified FROM_EMAIL sender in admin email-delivery settings before sending a test.",
    );
  }
  const now = new Date();
  const queued = await enqueueTransactionalEmail({
    eventKey: `admin-test:${input.actorId}:${randomUUID()}`,
    purpose: "admin_test",
    recipientEmail: input.recipientEmail,
    template: "admin_test",
    payload: { requestedAt: now.toISOString() },
  });
  const result = await claimAndSubmit({ id: queued.id, explicit: true });
  if (!result) throw new Error("The explicit email test was queued but could not be claimed.");
  const [item] = await db.select().from(transactionalEmailOutboxTable)
    .where(eq(transactionalEmailOutboxTable.id, result.id)).limit(1);
  return {
    accepted: result.deliveryState === "sent",
    deliveryState: result.deliveryState,
    detail: result.deliveryState === "sent"
      ? "Mailtrap accepted the test message."
      : item?.lastError ?? `Test send ended with ${result.deliveryState}.`,
  };
}

export async function retryTransactionalEmail(id: number): Promise<TransactionalEmailOutbox | null> {
  const [item] = await db.update(transactionalEmailOutboxTable).set({
    deliveryState: "queued",
    retryable: true,
    nextAttemptAt: null,
    leaseOwner: null,
    leaseUntil: null,
    lastError: null,
    updatedAt: new Date(),
  }).where(and(
    eq(transactionalEmailOutboxTable.id, id),
    eq(transactionalEmailOutboxTable.deliveryState, "failed"),
  )).returning();
  return item ?? null;
}

export async function listTransactionalEmailOutbox(input: {
  page: number;
  perPage: number;
  deliveryState?: string;
  purpose?: string;
  search?: string;
}) {
  const filters = [];
  if (input.deliveryState) filters.push(eq(transactionalEmailOutboxTable.deliveryState, input.deliveryState));
  if (input.purpose) filters.push(eq(transactionalEmailOutboxTable.purpose, input.purpose));
  if (input.search) {
    const search = `%${input.search.trim().slice(0, 120).replace(/[\\%_]/g, "\\$&")}%`;
    filters.push(or(
      sql`${transactionalEmailOutboxTable.eventKey} ILIKE ${search}`,
      sql`${transactionalEmailOutboxTable.recipientEmail} ILIKE ${search}`,
      sql`${transactionalEmailOutboxTable.purpose} ILIKE ${search}`,
    )!);
  }
  const where = filters.length ? and(...filters) : undefined;
  const [totalRow] = await db.select({ count: sql<number>`count(*)::int` })
    .from(transactionalEmailOutboxTable).where(where);
  const items = await db.select().from(transactionalEmailOutboxTable).where(where)
    .orderBy(sql`${transactionalEmailOutboxTable.createdAt} DESC`)
    .limit(input.perPage).offset((input.page - 1) * input.perPage);
  const legacy = await listLegacySupportOutbox();
  return {
    items: items.map(outboxItemDto),
    legacyHeld: legacy,
    total: Number(totalRow?.count ?? 0),
    page: input.page,
    perPage: input.perPage,
  };
}

function outboxItemDto(row: TransactionalEmailOutbox) {
  return {
    id: row.id,
    eventKey: row.eventKey,
    purpose: row.purpose,
    recipientEmail: row.recipientEmail,
    deliveryState: row.deliveryState,
    attempts: row.attempts,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    nextAttemptAt: row.nextAttemptAt,
    lastError: row.lastError,
    heldForReview: false,
  };
}

async function listLegacySupportOutbox() {
  const rows = await db.select().from(supportDeliveryOutboxTable)
    .where(eq(supportDeliveryOutboxTable.deliveryState, "unconfigured"))
    .orderBy(asc(supportDeliveryOutboxTable.createdAt));
  return rows.map((row) => ({
    id: row.id,
    eventKey: row.eventKey,
    purpose: row.purpose,
    recipientEmail: row.recipientEmail,
    deliveryState: "unconfigured" as const,
    createdAt: row.createdAt,
    heldForReview: true as const,
  }));
}

function jsonString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export async function reviewAndRequeueLegacySupportEmail(input: {
  id: number;
  actorId: string;
  reviewed: true;
}): Promise<TransactionalEmailOutbox | null> {
  if (!input.reviewed) throw new Error("Explicitly review the legacy support email before requeueing.");
  const [legacy] = await db.select().from(supportDeliveryOutboxTable)
    .where(eq(supportDeliveryOutboxTable.id, input.id)).limit(1);
  if (!legacy || legacy.deliveryState !== "unconfigured") return null;
  const [ticket] = await db.select().from(supportTicketsTable)
    .where(eq(supportTicketsTable.id, legacy.ticketId)).limit(1);
  if (!ticket) throw new Error("The legacy support email has no matching support ticket.");
  const messageId = Number(legacy.payload.messageId);
  const [message] = Number.isSafeInteger(messageId)
    ? await db.select().from(supportMessagesTable).where(eq(supportMessagesTable.id, messageId)).limit(1)
    : [];
  if (!message) throw new Error("The legacy support email has no matching support message.");
  const isReply = legacy.purpose === "message_reply";
  const purpose: TransactionalPurpose = isReply ? "support_reply" : "support_receipt";
  const template: TransactionalTemplate = purpose;
  const queued = await enqueueTransactionalEmail({
    eventKey: `legacy-support:${legacy.eventKey}`,
    purpose,
    recipientEmail: legacy.recipientEmail,
    template,
    payload: {
      ticketReference: ticket.reference,
      subject: ticket.subject,
      body: message.body,
    },
  });
  await db.update(supportDeliveryOutboxTable).set({
    deliveryState: "queued",
    reviewedBy: input.actorId,
    reviewedAt: new Date(),
  }).where(and(
    eq(supportDeliveryOutboxTable.id, legacy.id),
    eq(supportDeliveryOutboxTable.deliveryState, "unconfigured"),
  ));
  await updateLinkedSupportDelivery({
    payload: {
      ticketId: ticket.id,
      messageId: message.id,
    },
  }, "queued");
  const [item] = await db.select().from(transactionalEmailOutboxTable)
    .where(eq(transactionalEmailOutboxTable.id, queued.id)).limit(1);
  return item ?? null;
}

export async function getTransactionalEmailById(id: number): Promise<TransactionalEmailOutbox | null> {
  const [item] = await db.select().from(transactionalEmailOutboxTable)
    .where(eq(transactionalEmailOutboxTable.id, id)).limit(1);
  return item ?? null;
}

export function legacySupportIdFromDisplayId(displayId: number): number | null {
  if (!Number.isSafeInteger(displayId) || displayId <= LEGACY_SUPPORT_ID_OFFSET) return null;
  return displayId - LEGACY_SUPPORT_ID_OFFSET;
}
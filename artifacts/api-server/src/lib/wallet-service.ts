import {
  createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes,
  randomUUID, timingSafeEqual,
} from "node:crypto";
import { and, desc, eq, gte, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { COLLECTION_CURRENCIES } from "@workspace/api-zod";
import {
  adminAuditLogTable, db, feeSchedulesTable, merchantsTable, merchantWalletsTable,
  platformSettingsTable, refundsTable, settlementsTable, transactionsTable, walletConversionsTable,
  walletFxRatesTable, walletJournalEntriesTable, walletJournalsTable,
  walletPayoutRequestsTable, walletSettlementConfirmationsTable, walletRefundAdjustmentsTable,
  walletPayoutDestinationsTable, walletPayoutDestinationVersionsTable,
  walletPayoutDestinationChangeRequestsTable,
  type MerchantWalletRecord, type WalletPayoutRequestRecord,
  type WalletPayoutDestinationChangeRequestRecord, type WalletPayoutDestinationVersionRecord,
} from "@workspace/db";
import { persistFinancialNotificationEvent } from "./financial-notification-events";
import {
  ApiError, asObject, assertSupportedCurrency, numberValue, payzaApiRequest,
  payzaPayoutMethods, providerIsConfigured, stringValue,
} from "./greenpay-provider";
import {
  assertMerchantMayPayout, assertPlatformEnabled, enforceVerificationLimit,
} from "./platform";
import {
  assertMerchantActionEnabled, getMerchantActionControls,
  type MerchantActionControlsSnapshot,
} from "./merchant-action-controls";
import { CUSTOMER_REIMBURSED_REFUND_STATUSES, OPEN_REFUND_RESERVATION_STATUSES } from "./payment-safety";
import {
  calculateWalletConversion, canApplyWalletRefundAdjustment, canReserveWalletFunds,
  combineWalletFxMarkupBps, decimalToMinor, decimalToScaled, eligibleSettlementFunding,
  minorToDecimal, minorToNumber, roundDivide, WALLET_RATE_SCALE,
  payoutNeedsSecondApproval, payoutProviderOutcome, proportionalNetRefundReversal, shouldReleasePayoutHold,
} from "./wallet-math";
import { providerCredential } from "./credential-runtime";
import {
  fetchWalletFxRateBatchCandidate, fetchWalletFxRateCandidate, sourcePublicationDateIsFresh,
} from "./wallet-fx-rates";

const FX_CACHE_MS = 6 * 60 * 60 * 1000;
const FX_QUOTE_TTL_MS = 2 * 60 * 1000;

type WalletQuoteToken = {
  version: 1;
  merchantId: number;
  idempotencyKey: string;
  fromCurrency: string;
  toCurrency: string;
  sourceMinor: string;
  targetMinor: string;
  feeMinor: string;
  marketTargetMinor: string;
  systemMarginMinor: string;
  scheduleMarkupMinor: string;
  totalMarkupMinor: string;
  sourceRateScaled: string;
  effectiveRateScaled: string;
  markupBps: number;
  scheduleMarkupBps: number;
  currencySpreadBps: number;
  feeScheduleId: number | null;
  rateSource: string;
  rateSourceDate: string;
  rateFetchedAt: string;
  expiresAt: number;
};

function walletQuoteSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new ApiError(503, "Wallet quote signing is not configured.");
  return secret;
}

function signWalletQuote(payload: WalletQuoteToken): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", walletQuoteSecret()).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

function verifyWalletQuote(token: string): WalletQuoteToken {
  const [encoded, signature, extra] = token.split(".");
  if (!encoded || !signature || extra !== undefined) throw new ApiError(409, "This conversion quote is invalid. Request a new quote.");
  const expected = createHmac("sha256", walletQuoteSecret()).update(encoded).digest();
  let provided: Buffer;
  try {
    provided = Buffer.from(signature, "base64url");
  } catch {
    throw new ApiError(409, "This conversion quote is invalid. Request a new quote.");
  }
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    throw new ApiError(409, "This conversion quote is invalid. Request a new quote.");
  }
  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as WalletQuoteToken;
    if (payload.version !== 1 || !Number.isInteger(payload.merchantId) ||
        !Number.isFinite(payload.expiresAt) || !/^\d+$/.test(payload.sourceMinor) ||
        !/^\d+$/.test(payload.targetMinor) || !/^\d+$/.test(payload.feeMinor) ||
        !/^\d+$/.test(payload.marketTargetMinor) || !/^\d+$/.test(payload.systemMarginMinor)) {
      throw new Error("Invalid wallet quote payload.");
    }
    return payload;
  } catch {
    throw new ApiError(409, "This conversion quote is invalid. Request a new quote.");
  }
}

function sameWalletQuoteEconomics(a: WalletQuoteToken, b: WalletQuoteToken): boolean {
  return a.merchantId === b.merchantId &&
    a.idempotencyKey === b.idempotencyKey &&
    a.fromCurrency === b.fromCurrency &&
    a.toCurrency === b.toCurrency &&
    a.sourceMinor === b.sourceMinor &&
    a.targetMinor === b.targetMinor &&
    a.feeMinor === b.feeMinor &&
    a.marketTargetMinor === b.marketTargetMinor &&
    a.systemMarginMinor === b.systemMarginMinor &&
    a.scheduleMarkupMinor === b.scheduleMarkupMinor &&
    a.totalMarkupMinor === b.totalMarkupMinor &&
    a.sourceRateScaled === b.sourceRateScaled &&
    a.effectiveRateScaled === b.effectiveRateScaled &&
    a.markupBps === b.markupBps &&
    a.scheduleMarkupBps === b.scheduleMarkupBps &&
    a.currencySpreadBps === b.currencySpreadBps &&
    a.feeScheduleId === b.feeScheduleId &&
    a.rateSource === b.rateSource &&
    a.rateSourceDate === b.rateSourceDate;
}
const SLL_FX_UNSUPPORTED_ERROR =
  "FX quotes involving SLL are disabled until Payzaapi's legacy SLL amount scale is verified; Greenpay keeps SLL balances and payment-link amounts unchanged and never substitutes SLE rates.";

type FinancialTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

function cryptoKey(): Buffer {
  const secret = process.env.SESSION_SECRET?.trim();
  if (!secret) throw new ApiError(503, "Secure wallet destination storage is unavailable until SESSION_SECRET is configured.");
  return Buffer.from(hkdfSync(
    "sha256", Buffer.from(secret, "utf8"),
    Buffer.from("greenpay-wallet-destination"),
    Buffer.from("AES-256-GCM"), 32,
  ));
}

function destinationFingerprintKey(): Buffer {
  const secret = process.env.SESSION_SECRET?.trim();
  if (!secret) throw new ApiError(503, "Secure wallet destination storage is unavailable until SESSION_SECRET is configured.");
  return Buffer.from(hkdfSync(
    "sha256", Buffer.from(secret, "utf8"),
    Buffer.from("greenpay-wallet-destination"),
    Buffer.from("HMAC-SHA256"),
    32,
  ));
}

function encryptDestination(value: Record<string, string | null>): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", cryptoKey(), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return [iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(".");
}

function decryptDestination(value: string): Record<string, string> {
  const [iv, tag, ciphertext] = value.split(".");
  if (!iv || !tag || !ciphertext) throw new ApiError(503, "Stored payout destination is invalid.");
  try {
    const decipher = createDecipheriv("aes-256-gcm", cryptoKey(), Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    const decoded: unknown = JSON.parse(Buffer.concat([
      decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final(),
    ]).toString("utf8"));
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) throw new Error("invalid destination");
    return decoded as Record<string, string>;
  } catch {
    throw new ApiError(503, "Stored payout destination could not be decrypted with SESSION_SECRET.");
  }
}

function destinationFingerprint(value: Record<string, string | null>): string {
  return createHmac("sha256", destinationFingerprintKey()).update(JSON.stringify(value)).digest("hex");
}

function maskDestinationName(value: string): string {
  const words = value.trim().split(/\s+/).filter(Boolean);
  return words.map((word) => `${word[0]}${"•".repeat(Math.max(2, Math.min(6, word.length - 1)))}`).join(" ");
}

function requestHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function userAmountToMinor(value: number): bigint {
  try {
    return decimalToMinor(value);
  } catch (error) {
    throw new ApiError(400, error instanceof Error ? error.message : "Enter a valid amount with up to two decimal places.");
  }
}

function assertWalletFxPairAllowed(fromCurrency: string, toCurrency: string): void {
  assertSupportedCurrency(fromCurrency);
  assertSupportedCurrency(toCurrency);
  if (fromCurrency === "SLL" || toCurrency === "SLL") {
    throw new ApiError(422, SLL_FX_UNSUPPORTED_ERROR);
  }
  if (fromCurrency === toCurrency) {
    throw new ApiError(400, "Choose two different currencies for an internal conversion.");
  }
}

function walletAccountDto(row: MerchantWalletRecord) {
  return {
    currency: row.currency,
    availableBalance: minorToNumber(row.availableMinor),
    reservedBalance: minorToNumber(row.reservedMinor),
    updatedAt: row.updatedAt,
  };
}

export function walletPayoutRequestDto(row: WalletPayoutRequestRecord) {
  const destination = {
    id: row.destinationId,
    versionId: row.destinationVersion,
    fingerprint: row.destinationFingerprint,
    accountName: row.accountName,
    maskedAccount: row.maskedAccount,
    method: row.method,
    currency: row.currency,
  };
  const reviewHistory = [{
    stage: "requested",
    actor: row.requestedBy ?? "merchant",
    occurredAt: row.createdAt,
    outcome: "requested",
    destination,
    fee: minorToNumber(row.feeMinor),
  }];
  if (row.firstApprovedBy && row.firstApprovedAt) reviewHistory.push({
    stage: "first",
    actor: row.firstApprovedBy,
    occurredAt: row.firstApprovedAt,
    outcome: "approved",
    destination,
    fee: minorToNumber(row.feeMinor),
  });
  if (row.secondApprovedBy && row.secondApprovedAt) reviewHistory.push({
    stage: "second",
    actor: row.secondApprovedBy,
    occurredAt: row.secondApprovedAt,
    outcome: "approved",
    destination,
    fee: minorToNumber(row.feeMinor),
  });
  if (row.rejectedBy && row.rejectedAt) reviewHistory.push({
    stage: "reject",
    actor: row.rejectedBy,
    occurredAt: row.rejectedAt,
    outcome: "rejected",
    destination,
    fee: minorToNumber(row.feeMinor),
  });
  if (row.submittedAt) reviewHistory.push({
    stage: "provider",
    actor: row.secondApprovedBy ?? row.approvedBy ?? "platform",
    occurredAt: row.submittedAt,
    outcome: row.status,
    destination,
    fee: minorToNumber(row.feeMinor),
  });
  return {
    id: row.id,
    reference: row.reference,
    merchantId: row.merchantId,
    amount: minorToNumber(row.amountMinor),
    fee: minorToNumber(row.feeMinor),
    netAmount: minorToNumber(row.amountMinor),
    currency: row.currency,
    method: row.method,
    accountName: row.accountName,
    maskedAccount: row.maskedAccount,
    destinationId: row.destinationId,
    destinationVersion: row.destinationVersion,
    destinationFingerprint: row.destinationFingerprint,
    requiresSecondApproval: row.requiresSecondApproval || !row.thresholdConfigured || row.destinationVersionId === null,
    largePayoutThreshold: row.thresholdMinor === null ? null : minorToNumber(row.thresholdMinor),
    thresholdConfigured: row.thresholdConfigured,
    requestedBy: row.requestedBy,
    firstApprovedBy: row.firstApprovedBy,
    firstApprovedAt: row.firstApprovedAt,
    secondApprovedBy: row.secondApprovedBy,
    secondApprovedAt: row.secondApprovedAt,
    rejectedBy: row.rejectedBy,
    rejectedAt: row.rejectedAt,
    reviewHistory,
    status: row.status,
    providerReference: row.providerReference,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

type WalletPayoutTransitionNotifier = (
  previousStatus: string,
  row: WalletPayoutRequestRecord,
) => Promise<void>;

async function persistWalletPayoutTransition(
  tx: FinancialTx,
  previousStatus: string,
  row: WalletPayoutRequestRecord,
): Promise<void> {
  if (previousStatus === row.status) return;
  await persistFinancialNotificationEvent(tx, {
    kind: "wallet_payout",
    walletPayoutRequestId: row.id,
    reference: row.reference,
    previousStatus,
    status: row.status,
    amount: minorToDecimal(row.amountMinor),
    currency: row.currency,
  });
}

function walletPayoutDestinationDto(input: {
  destination: typeof walletPayoutDestinationsTable.$inferSelect;
  version: WalletPayoutDestinationVersionRecord;
}) {
  return {
    id: input.destination.id,
    version: input.version.version,
    currency: input.version.currency,
    label: input.version.label,
    method: input.version.method,
    accountName: input.version.accountName,
    maskedAccount: input.version.maskedAccount,
    fingerprint: input.version.fingerprint,
    status: input.destination.status,
    approvedBy: input.version.approvedBy,
    approvedAt: input.version.approvedAt,
    createdAt: input.destination.createdAt,
    updatedAt: input.destination.updatedAt,
  };
}

function walletPayoutDestinationChangeDto(row: WalletPayoutDestinationChangeRequestRecord) {
  const destination = {
    id: row.destinationId,
    label: row.proposedLabel,
    currency: row.currency,
    method: row.method,
    accountName: row.accountName,
    maskedAccount: row.maskedAccount,
    fingerprint: row.destinationFingerprint,
  };
  const history = [{
    stage: "requested",
    actor: row.requestedBy,
    occurredAt: row.createdAt,
    outcome: "requested",
    destination,
    fee: null,
  }];
  if (row.firstApprovedBy && row.firstApprovedAt) history.push({
    stage: "first",
    actor: row.firstApprovedBy,
    occurredAt: row.firstApprovedAt,
    outcome: "approved",
    destination,
    fee: null,
  });
  if (row.secondApprovedBy && row.secondApprovedAt) history.push({
    stage: "second",
    actor: row.secondApprovedBy,
    occurredAt: row.secondApprovedAt,
    outcome: "approved",
    destination,
    fee: null,
  });
  if (row.rejectedBy && row.rejectedAt) history.push({
    stage: "reject",
    actor: row.rejectedBy,
    occurredAt: row.rejectedAt,
    outcome: "rejected",
    destination,
    fee: null,
  });
  return {
    id: row.id,
    destinationId: row.destinationId,
    destination,
    destinationFingerprint: row.destinationFingerprint,
    status: row.status,
    requestedBy: row.requestedBy,
    firstApprovedBy: row.firstApprovedBy,
    firstApprovedAt: row.firstApprovedAt,
    secondApprovedBy: row.secondApprovedBy,
    secondApprovedAt: row.secondApprovedAt,
    rejectedBy: row.rejectedBy,
    rejectedAt: row.rejectedAt,
    decisionReason: row.decisionReason,
    reviewHistory: history,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function lockWallet(tx: FinancialTx, merchantId: number, currency: string) {
  const normalized = currency.toUpperCase();
  await tx.insert(merchantWalletsTable).values({
    merchantId, currency: normalized,
  }).onConflictDoNothing();
  const [wallet] = await tx.select().from(merchantWalletsTable).where(and(
    eq(merchantWalletsTable.merchantId, merchantId),
    eq(merchantWalletsTable.currency, normalized),
  )).for("update").limit(1);
  if (!wallet) throw new ApiError(503, "Merchant wallet could not be locked safely.");
  return wallet;
}

async function postJournal(tx: FinancialTx, input: {
  merchantId: number;
  currency: string;
  kind: string;
  reference: string;
  sourceReference?: string | null;
  evidenceReference?: string | null;
  idempotencyKey: string;
  metadata?: Record<string, unknown>;
  merchantAccount: "merchant_available" | "merchant_reserved";
  merchantDirection: "debit" | "credit";
  externalAccount?: "platform_settlement" | "platform_payout" | "fx_clearing";
  externalAmountMinor?: bigint;
  platformFxRevenueMinor?: bigint;
  platformFeeRevenueMinor?: bigint;
  secondMerchantAccount?: "merchant_available" | "merchant_reserved";
}) {
  const [journal] = await tx.insert(walletJournalsTable).values({
    merchantId: input.merchantId,
    currency: input.currency.toUpperCase(),
    kind: input.kind,
    reference: input.reference,
    sourceReference: input.sourceReference ?? null,
    evidenceReference: input.evidenceReference ?? null,
    idempotencyKey: input.idempotencyKey,
    requestHash: requestHash({
      merchantId: input.merchantId, currency: input.currency.toUpperCase(), kind: input.kind,
      reference: input.reference, sourceReference: input.sourceReference ?? null,
      evidenceReference: input.evidenceReference ?? null, metadata: input.metadata ?? {},
      merchantAccount: input.merchantAccount, merchantDirection: input.merchantDirection,
      externalAccount: input.externalAccount,
      externalAmountMinor: input.externalAmountMinor?.toString() ?? null,
      platformFxRevenueMinor: input.platformFxRevenueMinor?.toString() ?? null,
      platformFeeRevenueMinor: input.platformFeeRevenueMinor?.toString() ?? null,
      secondMerchantAccount: input.secondMerchantAccount,
    }),
    metadata: input.metadata ?? {},
  }).onConflictDoNothing().returning();
  if (!journal) throw new ApiError(409, "This wallet journal action has already been posted.");
  const amountMinor = BigInt(String(input.metadata?.amountMinor ?? "0"));
  if (amountMinor <= 0n) throw new ApiError(500, "Wallet journal amount must be positive.");
  const otherDirection = input.merchantDirection === "credit" ? "debit" : "credit";
  const entries: (typeof walletJournalEntriesTable.$inferInsert)[] = [{
    journalId: journal.id,
    merchantId: input.merchantId,
    currency: input.currency.toUpperCase(),
    account: input.merchantAccount,
    direction: input.merchantDirection,
    amountMinor,
  }];
  if (input.secondMerchantAccount) {
    entries.push({
      journalId: journal.id,
      merchantId: input.merchantId,
      currency: input.currency.toUpperCase(),
      account: input.secondMerchantAccount,
      direction: otherDirection,
      amountMinor,
    });
  } else if (input.externalAccount) {
    entries.push({
      journalId: journal.id,
      merchantId: null,
      currency: input.currency.toUpperCase(),
      account: input.externalAccount,
      direction: otherDirection,
      amountMinor: input.externalAmountMinor ?? amountMinor,
    });
  } else {
    throw new ApiError(500, "Wallet journal counter-account is required.");
  }
  const platformRevenueEntries = [
    { account: "platform_fx_revenue", amount: input.platformFxRevenueMinor },
    { account: "platform_fee_revenue", amount: input.platformFeeRevenueMinor },
  ];
  for (const revenue of platformRevenueEntries) {
    if (revenue.amount === undefined) continue;
    if (revenue.amount < 0n || !input.externalAccount) {
      throw new ApiError(500, "Platform revenue journal entries require a non-negative amount and external counter-account.");
    }
    if (revenue.amount > 0n) {
      entries.push({
        journalId: journal.id,
        merchantId: null,
        currency: input.currency.toUpperCase(),
        account: revenue.account,
        direction: "credit",
        amountMinor: revenue.amount,
      });
    }
  }
  const debitTotal = entries.reduce((total, entry) => total + (entry.direction === "debit" ? entry.amountMinor : 0n), 0n);
  const creditTotal = entries.reduce((total, entry) => total + (entry.direction === "credit" ? entry.amountMinor : 0n), 0n);
  if (debitTotal !== creditTotal) throw new ApiError(500, "Wallet journal entries do not balance.");
  await tx.insert(walletJournalEntriesTable).values(entries);
  return journal;
}

export async function ensureMerchantWalletAccounts(merchantId: number, baseCurrency: string): Promise<void> {
  const normalizedBaseCurrency = baseCurrency.toUpperCase();
  const walletCurrencies = new Set([...COLLECTION_CURRENCIES.map(({ code }) => code), normalizedBaseCurrency]);
  await db.insert(merchantWalletsTable).values([...walletCurrencies].map((currency) => ({
    merchantId, currency,
  }))).onConflictDoNothing();
}

export async function listMerchantWallets(merchantId: number) {
  const [merchant] = await db.select({ baseCurrency: merchantsTable.baseCurrency }).from(merchantsTable)
    .where(eq(merchantsTable.id, merchantId)).limit(1);
  if (!merchant) throw new ApiError(404, "Merchant account not found.");
  const baseCurrency = merchant.baseCurrency.toUpperCase();
  await ensureMerchantWalletAccounts(merchantId, baseCurrency);
  const rows = await db.select().from(merchantWalletsTable)
    .where(eq(merchantWalletsTable.merchantId, merchantId))
    .orderBy(merchantWalletsTable.currency);
  rows.sort((left, right) => left.currency === baseCurrency
    ? -1
    : right.currency === baseCurrency
      ? 1
      : left.currency.localeCompare(right.currency));
  return rows.map(walletAccountDto);
}

export async function listAdminWallets() {
  const rows = await db.select({
    merchantId: merchantWalletsTable.merchantId,
    businessName: merchantsTable.businessName,
    currency: merchantWalletsTable.currency,
    availableMinor: merchantWalletsTable.availableMinor,
    reservedMinor: merchantWalletsTable.reservedMinor,
    updatedAt: merchantWalletsTable.updatedAt,
  }).from(merchantWalletsTable)
    .innerJoin(merchantsTable, eq(merchantWalletsTable.merchantId, merchantsTable.id))
    .orderBy(merchantWalletsTable.merchantId, merchantWalletsTable.currency);
  return rows.map((row) => ({
    merchantId: row.merchantId,
    businessName: row.businessName,
    currency: row.currency,
    availableBalance: minorToNumber(row.availableMinor),
    reservedBalance: minorToNumber(row.reservedMinor),
    updatedAt: row.updatedAt,
  }));
}

export async function listWalletLedger(merchantId: number, currency?: string) {
  const conditions = [eq(walletJournalsTable.merchantId, merchantId)];
  if (currency) conditions.push(eq(walletJournalsTable.currency, currency.toUpperCase()));
  const journals = await db.select().from(walletJournalsTable)
    .where(and(...conditions)).orderBy(desc(walletJournalsTable.createdAt)).limit(500);
  const result = [];
  for (const journal of journals) {
    const entries = await db.select().from(walletJournalEntriesTable).where(and(
      eq(walletJournalEntriesTable.journalId, journal.id),
      eq(walletJournalEntriesTable.merchantId, merchantId),
    ));
    for (const entry of entries) {
      result.push({
        id: entry.id,
        currency: entry.currency,
        amount: minorToNumber(entry.amountMinor),
        direction: entry.direction,
        kind: journal.kind,
        reference: journal.reference,
        evidenceReference: journal.evidenceReference,
        createdAt: journal.createdAt,
      });
    }
  }
  return result;
}

async function getMarketRate(fromCurrency: string, toCurrency: string) {
  const from = fromCurrency.toUpperCase();
  const to = toCurrency.toUpperCase();
  assertWalletFxPairAllowed(from, to);
  const now = new Date();
  const [cached] = await db.select().from(walletFxRatesTable).where(and(
    eq(walletFxRatesTable.fromCurrency, from),
    eq(walletFxRatesTable.toCurrency, to),
    gte(walletFxRatesTable.expiresAt, now),
  )).orderBy(desc(walletFxRatesTable.fetchedAt)).limit(1);
  if (cached && sourcePublicationDateIsFresh(cached.sourceDate, now)) return {
    rate: String(cached.rate), source: cached.source, sourceDate: cached.sourceDate,
    fetchedAt: cached.fetchedAt, expiresAt: cached.expiresAt,
  };

  try {
    const apiKey = await providerCredential("currencyapi", "CURRENCYAPI_API_KEY");
    const fresh = await fetchWalletFxRateCandidate(from, to, apiKey, now);
    if (!fresh) throw new Error("All public currency-reference sources are unavailable, stale, or invalid.");
    const fetchedAt = now;
    const expiresAt = new Date(now.getTime() + FX_CACHE_MS);
    await db.insert(walletFxRatesTable).values({
      fromCurrency: from, toCurrency: to, rate: fresh.rate, source: fresh.source,
      sourceDate: fresh.sourceDate, fetchedAt, expiresAt,
    }).onConflictDoUpdate({
      target: [
        walletFxRatesTable.fromCurrency,
        walletFxRatesTable.toCurrency,
        walletFxRatesTable.sourceDate,
      ],
      set: { rate: fresh.rate, source: fresh.source, fetchedAt, expiresAt },
    });
    const [rateRow] = await db.select().from(walletFxRatesTable).where(and(
      eq(walletFxRatesTable.fromCurrency, from),
      eq(walletFxRatesTable.toCurrency, to),
      eq(walletFxRatesTable.sourceDate, fresh.sourceDate),
    )).limit(1);
    if (!rateRow || rateRow.expiresAt < now) throw new Error("Wallet FX rate cache did not persist.");
    return {
      rate: String(rateRow.rate), source: rateRow.source, sourceDate: rateRow.sourceDate,
      fetchedAt: rateRow.fetchedAt, expiresAt: rateRow.expiresAt,
    };
  } catch {
    throw new ApiError(503, "Public currency-reference providers are unavailable or returned stale/invalid data, and no fresh cached rate can be used.");
  }
}

export async function listMerchantWalletFxRates(baseCurrency: string) {
  const base = baseCurrency.toUpperCase();
  const targets = COLLECTION_CURRENCIES
    .map(({ code }) => code)
    .filter((code) => code !== base && code !== "SLL");
  if (base === "SLL") throw new ApiError(422, "SLL FX rates are unavailable until the legacy SLL amount scale is verified.");
  for (const target of targets) assertWalletFxPairAllowed(base, target);

  const now = new Date();
  const cachedRows = await db.select().from(walletFxRatesTable).where(and(
    eq(walletFxRatesTable.fromCurrency, base),
    gte(walletFxRatesTable.expiresAt, now),
  )).orderBy(desc(walletFxRatesTable.fetchedAt));
  const cachedByTarget = new Map<string, typeof cachedRows[number]>();
  for (const row of cachedRows) {
    if (!cachedByTarget.has(row.toCurrency) && sourcePublicationDateIsFresh(row.sourceDate, now)) {
      cachedByTarget.set(row.toCurrency, row);
    }
  }

  if (targets.some((target) => !cachedByTarget.has(target))) {
    try {
      const apiKey = await providerCredential("currencyapi", "CURRENCYAPI_API_KEY");
      const fresh = await fetchWalletFxRateBatchCandidate(base, targets, apiKey, now);
      if (!fresh || targets.some((target) => !fresh[target])) throw new Error("No complete current rate set is available.");
      const expiresAt = new Date(now.getTime() + FX_CACHE_MS);
      await db.transaction(async (tx) => {
        for (const target of targets) {
          const rate = fresh[target]!;
          await tx.insert(walletFxRatesTable).values({
            fromCurrency: base,
            toCurrency: target,
            rate: rate.rate,
            source: rate.source,
            sourceDate: rate.sourceDate,
            fetchedAt: now,
            expiresAt,
          }).onConflictDoUpdate({
            target: [
              walletFxRatesTable.fromCurrency,
              walletFxRatesTable.toCurrency,
              walletFxRatesTable.sourceDate,
            ],
            set: { rate: rate.rate, source: rate.source, fetchedAt: now, expiresAt },
          });
          cachedByTarget.set(target, {
            id: 0,
            fromCurrency: base,
            toCurrency: target,
            rate: rate.rate,
            source: rate.source,
            sourceDate: rate.sourceDate,
            fetchedAt: now,
            expiresAt,
            createdAt: now,
          });
        }
      });
    } catch {
      throw new ApiError(503, "Current exchange rates are unavailable. No complete, fresh rate set could be loaded.");
    }
  }

  return {
    baseCurrency: base,
    items: targets.map((currency) => {
      const row = cachedByTarget.get(currency);
      if (!row) throw new ApiError(503, `A fresh ${base}/${currency} rate is unavailable.`);
      return {
        currency,
        rate: Number(row.rate),
        source: row.source,
        sourceDate: row.sourceDate,
        fetchedAt: row.fetchedAt,
        expiresAt: row.expiresAt,
      };
    }),
  };
}

async function getWalletFeeSchedule(merchantId: number) {
  const [specific] = await db.select().from(feeSchedulesTable)
    .where(eq(feeSchedulesTable.merchantId, merchantId)).limit(1);
  const [global] = specific ? [] : await db.select().from(feeSchedulesTable)
    .where(isNull(feeSchedulesTable.merchantId)).limit(1);
  return specific ?? global ?? null;
}

async function getWalletCurrencySpreadBps(currency: string): Promise<number> {
  const [settings] = await db.select({
    spreads: platformSettingsTable.walletFxCurrencySpreads,
  }).from(platformSettingsTable).where(eq(platformSettingsTable.id, 1)).limit(1);
  const spread = settings?.spreads?.[currency] ?? 0;
  if (!Number.isInteger(spread) || spread < 0 || spread > 10_000) {
    throw new ApiError(503, `The configured ${currency} wallet FX spread is invalid.`);
  }
  return spread;
}

export async function quoteWalletConversion(merchantId: number, input: {
  amount: number;
  fromCurrency: string;
  toCurrency: string;
  idempotencyKey?: string;
}) {
  const fromCurrency = input.fromCurrency.toUpperCase();
  const toCurrency = input.toCurrency.toUpperCase();
  const sourceMinor = userAmountToMinor(input.amount);
  assertWalletFxPairAllowed(fromCurrency, toCurrency);
  if (sourceMinor <= 0n) throw new ApiError(400, "Enter an amount greater than zero.");
  const rate = await getMarketRate(fromCurrency, toCurrency);
  const schedule = await getWalletFeeSchedule(merchantId);
  const scheduleMarkupBps = schedule?.fxMarkupBps ?? 0;
  const currencySpreadBps = await getWalletCurrencySpreadBps(toCurrency);
  let markupBps: number;
  try {
    markupBps = combineWalletFxMarkupBps(scheduleMarkupBps, currencySpreadBps);
  } catch (error) {
    throw new ApiError(409, error instanceof Error ? error.message : "The configured wallet FX markup is invalid.");
  }
  const flatCurrency = schedule?.currency.toUpperCase();
  if (schedule && Number(schedule.flatAmount) > 0 && flatCurrency !== toCurrency) {
    throw new ApiError(409, `The active fee schedule flat fee is denominated in ${flatCurrency}; this quote cannot safely apply it.`);
  }
  const flatFeeMinor = schedule ? decimalToMinor(schedule.flatAmount) : 0n;
  const calculation = calculateWalletConversion({
    sourceMinor, sourceRate: rate.rate, markupBps, systemMarginBps: currencySpreadBps,
    feePercentage: schedule ? String(schedule.percentage) : "0", flatFeeMinor,
  });
  const now = new Date();
  if (rate.expiresAt <= now) throw new ApiError(503, "The public market rate expired before a quote could be issued.");
  const expiresAt = new Date(Math.min(rate.expiresAt.getTime(), now.getTime() + FX_QUOTE_TTL_MS));
  const quoteToken: WalletQuoteToken = {
    version: 1,
    merchantId,
    idempotencyKey: input.idempotencyKey ?? "",
    fromCurrency,
    toCurrency,
    sourceMinor: sourceMinor.toString(),
    targetMinor: calculation.targetMinor.toString(),
    feeMinor: calculation.feeMinor.toString(),
    marketTargetMinor: calculation.marketTargetMinor.toString(),
    systemMarginMinor: calculation.systemMarginMinor.toString(),
    scheduleMarkupMinor: calculation.scheduleMarkupMinor.toString(),
    totalMarkupMinor: calculation.totalMarkupMinor.toString(),
    sourceRateScaled: decimalToScaled(rate.rate, 12).toString(),
    effectiveRateScaled: calculation.effectiveRateScaled.toString(),
    markupBps,
    scheduleMarkupBps,
    currencySpreadBps,
    feeScheduleId: schedule?.id ?? null,
    rateSource: rate.source,
    rateSourceDate: rate.sourceDate,
    rateFetchedAt: rate.fetchedAt.toISOString(),
    expiresAt: expiresAt.getTime(),
  };
  return {
    quoteId: signWalletQuote(quoteToken),
    fromCurrency,
    toCurrency,
    sourceAmount: minorToNumber(sourceMinor),
    sourceRate: Number(quoteToken.sourceRateScaled) / Number(WALLET_RATE_SCALE),
    effectiveRate: Number(calculation.effectiveRateScaled) / 1_000_000_000_000,
    marketTargetAmount: minorToNumber(calculation.marketTargetMinor),
    systemMarginAmount: minorToNumber(calculation.systemMarginMinor),
    scheduleMarkupAmount: minorToNumber(calculation.scheduleMarkupMinor),
    totalMarkupAmount: minorToNumber(calculation.totalMarkupMinor),
    feeAmount: minorToNumber(calculation.feeMinor),
    targetAmount: minorToNumber(calculation.targetMinor),
    markupBps,
    scheduleMarkupBps,
    currencySpreadBps,
    source: rate.source,
    quotedAt: now,
    expiresAt,
    sourceDate: rate.sourceDate,
    note: "Internal wallet allocation only. This does not execute external bank FX or represent provider liquidity.",
    sourceMinor,
    marketTargetMinor: calculation.marketTargetMinor,
    systemMarginMinor: calculation.systemMarginMinor,
    scheduleMarkupMinor: calculation.scheduleMarkupMinor,
    totalMarkupMinor: calculation.totalMarkupMinor,
    targetMinor: calculation.targetMinor,
    feeMinor: calculation.feeMinor,
    schedule,
    rateSourceDate: rate.sourceDate,
  };
}

export async function convertWalletFunds(merchantId: number, input: {
  amount: number;
  fromCurrency: string;
  toCurrency: string;
  idempotencyKey: string;
  quoteId: string;
}) {
  const fromCurrency = input.fromCurrency.toUpperCase();
  const toCurrency = input.toCurrency.toUpperCase();
  assertWalletFxPairAllowed(fromCurrency, toCurrency);
  const sourceMinor = userAmountToMinor(input.amount);
  const fingerprint = requestHash({ amountMinor: sourceMinor.toString(), fromCurrency, toCurrency });
  const [prior] = await db.select().from(walletConversionsTable).where(and(
    eq(walletConversionsTable.merchantId, merchantId),
    eq(walletConversionsTable.idempotencyKey, input.idempotencyKey),
  )).limit(1);
  if (prior) {
    if (prior.requestHash !== fingerprint) {
      throw new ApiError(409, "This wallet conversion idempotency key was used for different conversion details.");
    }
    return walletConversionDto(prior);
  }
  await assertMerchantActionEnabled(merchantId, "walletConversion");
  const acceptedQuote = verifyWalletQuote(input.quoteId);
  if (acceptedQuote.merchantId !== merchantId ||
      acceptedQuote.idempotencyKey !== input.idempotencyKey ||
      acceptedQuote.fromCurrency !== fromCurrency ||
      acceptedQuote.toCurrency !== toCurrency ||
      acceptedQuote.sourceMinor !== sourceMinor.toString()) {
    throw new ApiError(409, "This conversion quote does not match the requested amount, wallets, or idempotency key. Request a new quote.");
  }
  if (acceptedQuote.expiresAt <= Date.now()) {
    throw new ApiError(409, "This conversion quote expired. Request a new quote before confirming.");
  }
  const refreshedQuote = await quoteWalletConversion(merchantId, input);
  const refreshedToken = verifyWalletQuote(refreshedQuote.quoteId);
  if (!sameWalletQuoteEconomics(acceptedQuote, refreshedToken)) {
    throw new ApiError(409, "The rate or fees changed after this quote was shown. Review a fresh quote before confirming.");
  }
  const quote = refreshedQuote;
  return db.transaction(async (tx) => {
    const [existing] = await tx.select().from(walletConversionsTable).where(and(
      eq(walletConversionsTable.merchantId, merchantId),
      eq(walletConversionsTable.idempotencyKey, input.idempotencyKey),
    )).for("update").limit(1);
    if (existing) {
      if (existing.requestHash !== fingerprint) throw new ApiError(409, "This wallet conversion idempotency key was used for different conversion details.");
      return walletConversionDto(existing);
    }
    const currencies = [fromCurrency, toCurrency].sort();
    const wallets = new Map<string, MerchantWalletRecord>();
    for (const currency of currencies) wallets.set(currency, await lockWallet(tx, merchantId, currency));
    const [concurrent] = await tx.select().from(walletConversionsTable).where(and(
      eq(walletConversionsTable.merchantId, merchantId),
      eq(walletConversionsTable.idempotencyKey, input.idempotencyKey),
    )).for("update").limit(1);
    if (concurrent) {
      if (concurrent.requestHash !== fingerprint) {
        throw new ApiError(409, "This wallet conversion idempotency key was used for different conversion details.");
      }
      return walletConversionDto(concurrent);
    }
    await assertMerchantActionEnabled(merchantId, "walletConversion", tx);
    const sourceWallet = wallets.get(fromCurrency)!;
    const targetWallet = wallets.get(toCurrency)!;
    await enforceVerificationLimit(
      tx, merchantId, "conversion", minorToNumber(quote.sourceMinor), fromCurrency,
    );
    if (!canReserveWalletFunds(sourceWallet.availableMinor, quote.sourceMinor)) {
      throw new ApiError(409, `Available ${fromCurrency} wallet funds are insufficient for this conversion.`);
    }
    const [conversion] = await tx.insert(walletConversionsTable).values({
      merchantId,
      idempotencyKey: input.idempotencyKey,
      requestHash: fingerprint,
      fromCurrency,
      toCurrency,
      sourceMinor: quote.sourceMinor,
      targetMinor: quote.targetMinor,
      feeMinor: quote.feeMinor,
      sourceRate: Number(quote.sourceRate),
      effectiveRate: Number(quote.effectiveRate),
      markupBps: quote.markupBps,
      currencySpreadBps: quote.currencySpreadBps,
      feeScheduleId: quote.schedule?.id ?? null,
      rateSource: quote.source,
      rateSourceDate: quote.rateSourceDate,
      rateFetchedAt: quote.quotedAt,
    }).returning();
    if (!conversion) throw new ApiError(503, "Wallet conversion could not be persisted.");

    await tx.update(merchantWalletsTable).set({
      availableMinor: sourceWallet.availableMinor - quote.sourceMinor,
      updatedAt: new Date(),
    }).where(eq(merchantWalletsTable.id, sourceWallet.id));
    await tx.update(merchantWalletsTable).set({
      availableMinor: targetWallet.availableMinor + quote.targetMinor,
      updatedAt: new Date(),
    }).where(eq(merchantWalletsTable.id, targetWallet.id));
    await postJournal(tx, {
      merchantId, currency: fromCurrency, kind: "conversion", reference: `conversion:${conversion.id}`,
      sourceReference: String(conversion.id), idempotencyKey: `conversion:${conversion.id}:debit`,
      metadata: { amountMinor: quote.sourceMinor.toString(), allocationType: "internal_wallet_allocation" },
      merchantAccount: "merchant_available", merchantDirection: "debit", externalAccount: "fx_clearing",
    });
    await postJournal(tx, {
      merchantId, currency: toCurrency, kind: "conversion", reference: `conversion:${conversion.id}`,
      sourceReference: String(conversion.id), idempotencyKey: `conversion:${conversion.id}:credit`,
      metadata: {
        amountMinor: quote.targetMinor.toString(),
        marketAmountMinor: quote.marketTargetMinor.toString(),
        systemMarginMinor: quote.systemMarginMinor.toString(),
        feeMinor: quote.feeMinor.toString(),
        allocationType: "internal_wallet_allocation",
      },
      merchantAccount: "merchant_available",
      merchantDirection: "credit",
      externalAccount: "fx_clearing",
      externalAmountMinor: quote.marketTargetMinor,
      platformFxRevenueMinor: quote.totalMarkupMinor,
      platformFeeRevenueMinor: quote.feeMinor,
    });
    return walletConversionDto(conversion);
  });
}

function walletConversionDto(row: typeof walletConversionsTable.$inferSelect) {
  const marketTargetMinor = roundDivide(
    row.sourceMinor * decimalToScaled(row.sourceRate, 12),
    WALLET_RATE_SCALE,
  );
  const totalMarkupMinor = marketTargetMinor - row.targetMinor - row.feeMinor;
  const systemMarginMinor = row.markupBps === 0
    ? 0n
    : roundDivide(totalMarkupMinor * BigInt(row.currencySpreadBps), BigInt(row.markupBps));
  const scheduleMarkupMinor = totalMarkupMinor - systemMarginMinor;
  return {
    id: row.id,
    fromCurrency: row.fromCurrency,
    toCurrency: row.toCurrency,
    sourceAmount: minorToNumber(row.sourceMinor),
    sourceRate: Number(row.sourceRate),
    effectiveRate: Number(row.effectiveRate),
    marketTargetAmount: minorToNumber(marketTargetMinor),
    systemMarginAmount: minorToNumber(systemMarginMinor),
    scheduleMarkupAmount: minorToNumber(scheduleMarkupMinor),
    totalMarkupAmount: minorToNumber(totalMarkupMinor),
    feeAmount: minorToNumber(row.feeMinor),
    targetAmount: minorToNumber(row.targetMinor),
    markupBps: row.markupBps,
    scheduleMarkupBps: row.markupBps - row.currencySpreadBps,
    currencySpreadBps: row.currencySpreadBps,
    source: row.rateSource,
    sourceDate: row.rateSourceDate,
    note: "Internal wallet allocation only. This does not execute external bank FX or represent provider liquidity.",
    idempotencyKey: row.idempotencyKey,
    createdAt: row.createdAt,
    allocationType: "internal_wallet_allocation" as const,
  };
}

export async function listMerchantPayoutRequests(merchantId: number) {
  const rows = await db.select().from(walletPayoutRequestsTable)
    .where(eq(walletPayoutRequestsTable.merchantId, merchantId))
    .orderBy(desc(walletPayoutRequestsTable.createdAt)).limit(500);
  return rows.map(walletPayoutRequestDto);
}

export async function listAdminPayoutRequests(status?: string) {
  const rows = await db.select().from(walletPayoutRequestsTable)
    .where(status ? eq(walletPayoutRequestsTable.status, status) : undefined)
    .orderBy(desc(walletPayoutRequestsTable.createdAt)).limit(1000);
  return rows.map(walletPayoutRequestDto);
}

export async function listMerchantWalletPayoutDestinations(merchantId: number) {
  const destinations = await db.select().from(walletPayoutDestinationsTable).where(and(
    eq(walletPayoutDestinationsTable.merchantId, merchantId),
    eq(walletPayoutDestinationsTable.status, "active"),
  )).orderBy(desc(walletPayoutDestinationsTable.updatedAt)).limit(500);
  const items = [];
  for (const destination of destinations) {
    if (!destination.currentVersionId) continue;
    const [version] = await db.select().from(walletPayoutDestinationVersionsTable).where(and(
      eq(walletPayoutDestinationVersionsTable.id, destination.currentVersionId),
      eq(walletPayoutDestinationVersionsTable.destinationId, destination.id),
    )).limit(1);
    if (version) items.push(walletPayoutDestinationDto({ destination, version }));
  }
  return items;
}

export async function listMerchantWalletPayoutDestinationChanges(merchantId: number) {
  const rows = await db.select().from(walletPayoutDestinationChangeRequestsTable).where(eq(
    walletPayoutDestinationChangeRequestsTable.merchantId, merchantId,
  )).orderBy(desc(walletPayoutDestinationChangeRequestsTable.createdAt)).limit(500);
  return rows.map(walletPayoutDestinationChangeDto);
}

export async function listAdminWalletPayoutDestinationChanges(status?: string) {
  const rows = await db.select().from(walletPayoutDestinationChangeRequestsTable)
    .where(status ? eq(walletPayoutDestinationChangeRequestsTable.status, status) : undefined)
    .orderBy(desc(walletPayoutDestinationChangeRequestsTable.createdAt)).limit(1000);
  return rows.map(walletPayoutDestinationChangeDto);
}

export async function createMerchantWalletPayoutDestinationChange(merchant: typeof merchantsTable.$inferSelect, input: {
  destinationId?: number;
  label: string;
  currency: string;
  method: string;
  accountName: string;
  accountNumber: string;
  bankCode?: string;
  bankName?: string;
  idempotencyKey: string;
  requester: string;
}) {
  const label = input.label.trim().replace(/\s+/g, " ");
  const currency = input.currency.trim().toUpperCase();
  assertSupportedCurrency(currency);
  const method = input.method.trim();
  const destination = {
    accountName: input.accountName.trim().replace(/\s+/g, " "),
    accountNumber: input.accountNumber.trim().replace(/\s+/g, ""),
    bankCode: input.bankCode?.trim() || null,
    bankName: input.bankName?.trim().replace(/\s+/g, " ") || null,
    method,
  };
  if (!label || label.length > 120 || !destination.accountName ||
      destination.accountName.length > 200 || destination.accountNumber.length < 3 ||
      destination.accountNumber.length > 100 || !method || method.length > 120) {
    throw new ApiError(400, "Enter a destination label, beneficiary name, account number, and payout method.");
  }

  const destinationHash = destinationFingerprint(destination);
  const rawDigits = destination.accountNumber.replace(/\D/g, "");
  const maskedAccount = `${"•".repeat(Math.max(0, Math.min(8, rawDigits.length - 4)))}${rawDigits.slice(-4)}` || "••••";
  const maskedAccountName = maskDestinationName(destination.accountName);
  const [prior] = await db.select().from(walletPayoutDestinationChangeRequestsTable).where(and(
    eq(walletPayoutDestinationChangeRequestsTable.merchantId, merchant.id),
    eq(walletPayoutDestinationChangeRequestsTable.idempotencyKey, input.idempotencyKey),
  )).limit(1);
  if (prior) {
    if (prior.destinationId !== (input.destinationId ?? null) ||
        prior.proposedLabel !== label || prior.currency !== currency || prior.method !== method ||
        prior.accountName !== maskedAccountName || prior.maskedAccount !== maskedAccount ||
        prior.destinationFingerprint !== destinationHash) {
      throw new ApiError(409, "This destination idempotency key was already used with different details.");
    }
    return walletPayoutDestinationChangeDto(prior);
  }

  let expectedVersionId: number | null = null;
  let existingFingerprint: string | null = null;
  let existingDestination: typeof walletPayoutDestinationsTable.$inferSelect | null = null;
  if (input.destinationId !== undefined) {
    const [existing] = await db.select().from(walletPayoutDestinationsTable).where(and(
      eq(walletPayoutDestinationsTable.id, input.destinationId),
      eq(walletPayoutDestinationsTable.merchantId, merchant.id),
      eq(walletPayoutDestinationsTable.status, "active"),
    )).limit(1);
    if (!existing?.currentVersionId) throw new ApiError(404, "Approved payout destination not found.");
    const [currentVersion] = await db.select().from(walletPayoutDestinationVersionsTable).where(and(
      eq(walletPayoutDestinationVersionsTable.id, existing.currentVersionId),
      eq(walletPayoutDestinationVersionsTable.destinationId, existing.id),
    )).limit(1);
    if (!currentVersion) throw new ApiError(409, "The current approved destination version is unavailable.");
    if (currentVersion.currency !== currency) {
      throw new ApiError(409, "A payout destination change cannot change its currency.");
    }
    existingDestination = existing;
    expectedVersionId = currentVersion.id;
    existingFingerprint = currentVersion.fingerprint;
  }
  if (existingFingerprint === destinationHash) {
    throw new ApiError(409, "The proposed destination matches the currently approved destination; submit only a substantive account change.");
  }
  const fingerprint = requestHash({
    destinationId: existingDestination?.id ?? null,
    expectedVersionId,
    label,
    currency,
    destinationHash,
  });

  await assertMerchantActionEnabled(merchant.id, "destinationChanges");
  const encryptedDestination = encryptDestination(destination);
  return db.transaction(async (tx) => {
    await tx.select({ id: merchantsTable.id }).from(merchantsTable)
      .where(eq(merchantsTable.id, merchant.id)).for("update").limit(1);
    const [concurrentRequest] = await tx.select().from(walletPayoutDestinationChangeRequestsTable).where(and(
      eq(walletPayoutDestinationChangeRequestsTable.merchantId, merchant.id),
      eq(walletPayoutDestinationChangeRequestsTable.idempotencyKey, input.idempotencyKey),
    )).for("update").limit(1);
    if (concurrentRequest) {
      if (concurrentRequest.destinationId !== (input.destinationId ?? null) ||
          concurrentRequest.proposedLabel !== label || concurrentRequest.currency !== currency ||
          concurrentRequest.method !== method || concurrentRequest.accountName !== maskedAccountName ||
          concurrentRequest.maskedAccount !== maskedAccount ||
          concurrentRequest.destinationFingerprint !== destinationHash) {
        throw new ApiError(409, "This destination idempotency key was already used with different details.");
      }
      return walletPayoutDestinationChangeDto(concurrentRequest);
    }
    await assertMerchantActionEnabled(merchant.id, "destinationChanges", tx);
    let targetDestinationId = existingDestination?.id ?? null;
    if (existingDestination) {
      const [locked] = await tx.select().from(walletPayoutDestinationsTable).where(and(
        eq(walletPayoutDestinationsTable.id, existingDestination.id),
        eq(walletPayoutDestinationsTable.merchantId, merchant.id),
      )).for("update").limit(1);
      if (!locked || locked.currentVersionId !== expectedVersionId || locked.status !== "active") {
        throw new ApiError(409, "The approved payout destination changed while this request was being prepared.");
      }
    } else {
      const [createdDestination] = await tx.insert(walletPayoutDestinationsTable).values({
        merchantId: merchant.id,
        status: "pending",
        currentVersionId: null,
        createdBy: input.requester,
      }).returning();
      if (!createdDestination) throw new ApiError(503, "Payout destination change could not be prepared.");
      targetDestinationId = createdDestination.id;
    }
    const [created] = await tx.insert(walletPayoutDestinationChangeRequestsTable).values({
      merchantId: merchant.id,
      destinationId: targetDestinationId,
      expectedVersionId,
      idempotencyKey: input.idempotencyKey,
      requestHash: fingerprint,
      proposedLabel: label,
      currency,
      method,
      accountName: maskedAccountName,
      maskedAccount: maskedAccount || "••••",
      encryptedDestination,
      destinationFingerprint: destinationHash,
      requestedBy: input.requester,
      status: "requested",
    }).returning();
    if (!created) throw new ApiError(503, "Payout destination change could not be persisted.");
    return walletPayoutDestinationChangeDto(created);
  });
}

export async function approveWalletPayoutDestinationChange(
  requestId: number,
  actor: string,
  expectedFingerprint?: string,
) {
  return db.transaction(async (tx) => {
    const [request] = await tx.select().from(walletPayoutDestinationChangeRequestsTable)
      .where(eq(walletPayoutDestinationChangeRequestsTable.id, requestId)).for("update").limit(1);
    if (!request) throw new ApiError(404, "Payout destination change request not found.");
    if (request.requestedBy === actor) {
      throw new ApiError(409, "The destination requester cannot approve their own change.");
    }
    const now = new Date();
    if (request.status === "requested") {
      const [updated] = await tx.update(walletPayoutDestinationChangeRequestsTable).set({
        status: "first_approved",
        firstApprovedBy: actor,
        firstApprovedAt: now,
        updatedAt: now,
      }).where(and(
        eq(walletPayoutDestinationChangeRequestsTable.id, request.id),
        eq(walletPayoutDestinationChangeRequestsTable.status, "requested"),
      )).returning();
      if (!updated) throw new ApiError(409, "Destination review was concurrently processed.");
      await tx.insert(adminAuditLogTable).values({
        actor,
        action: "wallet.destination.first_approved",
        target: `wallet-destination-change:${request.id}`,
        details: `First review recorded for masked destination ${request.maskedAccount}; no approved destination was changed.`,
      });
      return walletPayoutDestinationChangeDto(updated);
    }
    if (request.status !== "first_approved") {
      throw new ApiError(409, "This destination change has already been reviewed or is no longer pending.");
    }
    if (actor === request.firstApprovedBy) throw new ApiError(409, "A different administrator must provide the second destination approval.");
    if (expectedFingerprint !== request.destinationFingerprint) {
      throw new ApiError(409, "The pending destination version changed. Review the exact fingerprint before second approval.");
    }
    if (!request.destinationId) throw new ApiError(409, "Destination change has no destination identity.");
    const [destination] = await tx.select().from(walletPayoutDestinationsTable).where(and(
      eq(walletPayoutDestinationsTable.id, request.destinationId),
      eq(walletPayoutDestinationsTable.merchantId, request.merchantId),
    )).for("update").limit(1);
    if (!destination) throw new ApiError(409, "The merchant payout destination no longer exists.");
    if (destination.currentVersionId !== request.expectedVersionId) {
      throw new ApiError(409, "Another approved change replaced this destination version. Create a new request.");
    }
    let versionNumber = 1;
    if (request.expectedVersionId !== null) {
      const [priorVersion] = await tx.select().from(walletPayoutDestinationVersionsTable).where(eq(
        walletPayoutDestinationVersionsTable.id, request.expectedVersionId,
      )).limit(1);
      if (!priorVersion) throw new ApiError(409, "The destination version under review is unavailable.");
      versionNumber = priorVersion.version + 1;
    }
    const [version] = await tx.insert(walletPayoutDestinationVersionsTable).values({
      destinationId: destination.id,
      version: versionNumber,
      label: request.proposedLabel,
      currency: request.currency,
      method: request.method,
      accountName: request.accountName,
      maskedAccount: request.maskedAccount,
      encryptedDestination: request.encryptedDestination,
      fingerprint: request.destinationFingerprint,
      approvedBy: actor,
      approvedAt: now,
    }).returning();
    if (!version) throw new ApiError(503, "Approved destination version could not be saved.");
    await tx.update(walletPayoutDestinationsTable).set({
      currentVersionId: version.id,
      status: "active",
      updatedAt: now,
    }).where(eq(walletPayoutDestinationsTable.id, destination.id));
    const [updated] = await tx.update(walletPayoutDestinationChangeRequestsTable).set({
      status: "approved",
      secondApprovedBy: actor,
      secondApprovedAt: now,
      approvedVersionId: version.id,
      updatedAt: now,
    }).where(and(
      eq(walletPayoutDestinationChangeRequestsTable.id, request.id),
      eq(walletPayoutDestinationChangeRequestsTable.status, "first_approved"),
      eq(walletPayoutDestinationChangeRequestsTable.destinationFingerprint, expectedFingerprint!),
    )).returning();
    if (!updated) throw new ApiError(409, "Destination second approval was concurrently processed.");
    await tx.insert(adminAuditLogTable).values({
      actor,
      action: "wallet.destination.second_approved",
      target: `wallet-destination-change:${request.id}`,
      details: `Destination ${destination.id} version ${version.version} approved (${request.maskedAccount}, ${request.currency}); prior approved version remains in immutable history.`,
    });
    return walletPayoutDestinationChangeDto(updated);
  });
}

export async function rejectWalletPayoutDestinationChange(requestId: number, actor: string, reason: string) {
  const normalizedReason = reason.trim();
  if (!normalizedReason || normalizedReason.length > 400) throw new ApiError(400, "Enter a rejection reason.");
  return db.transaction(async (tx) => {
    const [request] = await tx.select().from(walletPayoutDestinationChangeRequestsTable)
      .where(eq(walletPayoutDestinationChangeRequestsTable.id, requestId)).for("update").limit(1);
    if (!request) throw new ApiError(404, "Payout destination change request not found.");
    if (!["requested", "first_approved"].includes(request.status)) {
      throw new ApiError(409, "Only an unapproved destination change can be rejected.");
    }
    const now = new Date();
    const [updated] = await tx.update(walletPayoutDestinationChangeRequestsTable).set({
      status: "rejected",
      rejectedBy: actor,
      rejectedAt: now,
      decisionReason: normalizedReason,
      updatedAt: now,
    }).where(and(
      eq(walletPayoutDestinationChangeRequestsTable.id, request.id),
      inArray(walletPayoutDestinationChangeRequestsTable.status, ["requested", "first_approved"]),
    )).returning();
    if (!updated) throw new ApiError(409, "Destination change was concurrently processed.");
    if (request.expectedVersionId === null && request.destinationId !== null) {
      await tx.update(walletPayoutDestinationsTable).set({
        status: "rejected",
        updatedAt: now,
      }).where(and(
        eq(walletPayoutDestinationsTable.id, request.destinationId),
        isNull(walletPayoutDestinationsTable.currentVersionId),
      ));
    }
    await tx.insert(adminAuditLogTable).values({
      actor,
      action: "wallet.destination.rejected",
      target: `wallet-destination-change:${request.id}`,
      details: `Destination change rejected; existing approved version preserved. ${normalizedReason}`,
    });
    return walletPayoutDestinationChangeDto(updated);
  });
}

export async function walletPayoutMethods(currency: string) {
  const normalized = currency.toUpperCase();
  assertSupportedCurrency(normalized);
  if (!await providerIsConfigured("payzaapi")) throw new ApiError(503, "Payzaapi payout credentials are not configured.");
  const methods = await payzaPayoutMethods(normalized);
  return {
    currency: methods.currency,
    available: methods.available,
    minimumWithdrawal: methods.minimumWithdrawal,
    fee: methods.fee,
    methods: methods.methods.map((item) => ({
      value: item.value,
      label: item.label,
      requiresBankFields: item.requiresBankFields,
    })),
  };
}

function payoutFeeMinor(amountMinor: bigint, methods: Awaited<ReturnType<typeof payzaPayoutMethods>>) {
  if (methods.fee.type === "flat") return decimalToMinor(methods.fee.amount);
  const percentScaled = BigInt(Math.round((methods.fee.percent ?? 0) * 10_000));
  const percentFee = (amountMinor * percentScaled + 500_000n) / 1_000_000n;
  const floorMinor = decimalToMinor(methods.fee.floor ?? 0);
  return percentFee > floorMinor ? percentFee : floorMinor;
}

type WalletPayoutRequestDependencies = {
  assertPayoutsEnabled?: () => Promise<void>;
  assertMerchantMayPayout?: (merchant: typeof merchantsTable.$inferSelect) => Promise<void>;
  providerIsConfigured?: () => Promise<boolean>;
  payoutMethods?: (currency: string) => ReturnType<typeof payzaPayoutMethods>;
  getPayoutSafetySettings?: (merchantId: number) => Promise<MerchantActionControlsSnapshot["payoutSafety"]>;
  notifyWalletPayoutTransition?: WalletPayoutTransitionNotifier;
};

export async function createWalletPayoutRequest(merchant: typeof merchantsTable.$inferSelect, input: {
  amount: number;
  currency: string;
  method?: string;
  destinationId?: number;
  accountName?: string;
  accountNumber?: string;
  bankCode?: string;
  bankName?: string;
  idempotencyKey: string;
  requester?: string;
}, dependencies: WalletPayoutRequestDependencies = {}) {
  const currency = input.currency.toUpperCase();
  assertSupportedCurrency(currency);
  const amountMinor = userAmountToMinor(input.amount);
  if (amountMinor <= 0n) throw new ApiError(400, "Enter a payout amount greater than zero.");
  if (input.destinationId !== undefined) {
    const [previous] = await db.select().from(walletPayoutRequestsTable).where(and(
      eq(walletPayoutRequestsTable.merchantId, merchant.id),
      eq(walletPayoutRequestsTable.idempotencyKey, input.idempotencyKey),
    )).limit(1);
    if (previous) {
      if (previous.amountMinor !== amountMinor || previous.currency !== currency ||
          previous.destinationId !== input.destinationId) {
        throw new ApiError(409, "This payout idempotency key was already used with different payout details.");
      }
      if (input.method && previous.destinationVersionId) {
        const [previousVersion] = await db.select({ method: walletPayoutDestinationVersionsTable.method })
          .from(walletPayoutDestinationVersionsTable)
          .where(eq(walletPayoutDestinationVersionsTable.id, previous.destinationVersionId)).limit(1);
        if (!previousVersion || previousVersion.method !== input.method.trim()) {
          throw new ApiError(409, "This payout idempotency key was already used with different payout details.");
        }
      }
      return walletPayoutRequestDto(previous);
    }
  }
  let savedDestination: typeof walletPayoutDestinationsTable.$inferSelect | null = null;
  let savedVersion: WalletPayoutDestinationVersionRecord | null = null;
  let destination: Record<string, string | null>;
  let methodValue: string;
  if (input.destinationId !== undefined) {
    const [destinationRow] = await db.select().from(walletPayoutDestinationsTable).where(and(
      eq(walletPayoutDestinationsTable.id, input.destinationId),
      eq(walletPayoutDestinationsTable.merchantId, merchant.id),
      eq(walletPayoutDestinationsTable.status, "active"),
    )).limit(1);
    if (!destinationRow?.currentVersionId) {
      throw new ApiError(409, "Choose a currently approved payout destination. Pending destination changes cannot be used.");
    }
    const [version] = await db.select().from(walletPayoutDestinationVersionsTable).where(and(
      eq(walletPayoutDestinationVersionsTable.id, destinationRow.currentVersionId),
      eq(walletPayoutDestinationVersionsTable.destinationId, destinationRow.id),
    )).limit(1);
    if (!version) throw new ApiError(409, "The approved payout destination version is unavailable.");
    savedDestination = destinationRow;
    savedVersion = version;
    destination = decryptDestination(version.encryptedDestination);
    methodValue = version.method;
    if (version.currency !== currency) {
      throw new ApiError(400, `Choose a saved payout destination denominated in ${currency}.`);
    }
    if (input.method && input.method.trim() !== methodValue) {
      throw new ApiError(409, "The selected payout method does not match the approved destination version.");
    }
  } else {
    methodValue = input.method?.trim() ?? "";
    destination = {
      accountName: input.accountName?.trim().replace(/\s+/g, " ") ?? "",
      accountNumber: input.accountNumber?.trim().replace(/\s+/g, "") ?? "",
      bankCode: input.bankCode?.trim() || null,
      bankName: input.bankName?.trim().replace(/\s+/g, " ") || null,
      method: methodValue,
    };
  }
  const destinationAccountName = destination.accountName;
  const destinationAccountNumber = destination.accountNumber;
  if (!destinationAccountName || !destinationAccountNumber ||
      destinationAccountNumber.length < 3 || !methodValue) {
    throw new ApiError(400, "Enter a beneficiary name, destination, and payout method.");
  }
  const destinationHash = savedVersion?.fingerprint ?? destinationFingerprint(destination);
  const fingerprint = requestHash({
    amountMinor: amountMinor.toString(), currency, method: methodValue,
    destinationHash, destinationVersionId: savedVersion?.id ?? null,
  });
  const [prior] = await db.select().from(walletPayoutRequestsTable).where(and(
    eq(walletPayoutRequestsTable.merchantId, merchant.id),
    eq(walletPayoutRequestsTable.idempotencyKey, input.idempotencyKey),
  )).limit(1);
  if (prior) {
    if (prior.requestHash !== fingerprint) {
      throw new ApiError(409, "This payout idempotency key was already used with different payout details.");
    }
    return walletPayoutRequestDto(prior);
  }

  await (dependencies.assertPayoutsEnabled ?? (() => assertPlatformEnabled("payoutsEnabled")))();
  await (dependencies.assertMerchantMayPayout ?? assertMerchantMayPayout)(merchant);
  await assertMerchantActionEnabled(merchant.id, "payoutRequests");
  if (!await (dependencies.providerIsConfigured ?? (() => providerIsConfigured("payzaapi")))) {
    throw new ApiError(503, "Payzaapi payouts are not configured.");
  }
  const methods = await (dependencies.payoutMethods ?? payzaPayoutMethods)(currency);
  if (!methods.available) throw new ApiError(422, `Payout requests are unavailable in ${currency}.`);
  const method = methods.methods.find((candidate) => candidate.value === methodValue);
  if (!method) throw new ApiError(400, "Choose a payout method returned by Payzaapi.");
  if (amountMinor < decimalToMinor(methods.minimumWithdrawal)) {
    throw new ApiError(400, `The minimum withdrawal for ${currency} is ${methods.minimumWithdrawal}.`);
  }
  if (method.requiresBankFields && (!destination.bankCode || !destination.bankName)) {
    throw new ApiError(400, "Select a bank and enter its bank code for this payout method.");
  }
  const encryptedDestination = savedVersion?.encryptedDestination ?? encryptDestination(destination);
  const feeMinor = payoutFeeMinor(amountMinor, methods);
  const holdMinor = amountMinor + feeMinor;
  const rawDigits = destinationAccountNumber.replace(/\D/g, "");
  const maskedAccount = `${"•".repeat(Math.max(0, Math.min(8, rawDigits.length - 4)))}${rawDigits.slice(-4)}`;
  const payoutSafety = dependencies.getPayoutSafetySettings
    ? await dependencies.getPayoutSafetySettings(merchant.id)
    : (await getMerchantActionControls(merchant.id)).payoutSafety;
  const rawThreshold = payoutSafety.largePayoutThresholds[currency];
  let thresholdMinor: bigint | null = null;
  if (rawThreshold !== undefined) {
    try {
      thresholdMinor = decimalToMinor(rawThreshold);
    } catch {
      throw new ApiError(503, `The configured ${currency} large-payout threshold must use the wallet's two-decimal amount scale.`);
    }
  }
  const thresholdConfigured = thresholdMinor !== null;
  let destinationAlreadySecondReviewed = false;
  if (savedVersion) {
    const [priorApprovedUse] = await db.select({ id: walletPayoutRequestsTable.id })
      .from(walletPayoutRequestsTable).where(and(
        eq(walletPayoutRequestsTable.destinationVersionId, savedVersion.id),
        isNotNull(walletPayoutRequestsTable.secondApprovedAt),
      )).limit(1);
    destinationAlreadySecondReviewed = Boolean(priorApprovedUse);
  }
  const requiresSecondApproval = payoutNeedsSecondApproval({
    amountMinor,
    largePayoutThresholdMinor: thresholdMinor,
    thresholdConfigured,
    destinationIsApproved: savedVersion !== null && destinationAlreadySecondReviewed,
    dualApprovalEnabled: payoutSafety.dualApprovalEnabled,
  });
  const createdRequest = await db.transaction(async (tx) => {
    const [existing] = await tx.select().from(walletPayoutRequestsTable).where(and(
      eq(walletPayoutRequestsTable.merchantId, merchant.id),
      eq(walletPayoutRequestsTable.idempotencyKey, input.idempotencyKey),
    )).for("update").limit(1);
    if (existing) {
      if (existing.requestHash !== fingerprint) {
        throw new ApiError(409, "This payout idempotency key was already used with different payout details.");
      }
      return { row: existing, created: false };
    }
    await assertMerchantActionEnabled(merchant.id, "payoutRequests", tx);
    const wallet = await lockWallet(tx, merchant.id, currency);
    const [concurrent] = await tx.select().from(walletPayoutRequestsTable).where(and(
      eq(walletPayoutRequestsTable.merchantId, merchant.id),
      eq(walletPayoutRequestsTable.idempotencyKey, input.idempotencyKey),
    )).for("update").limit(1);
    if (concurrent) {
      if (concurrent.requestHash !== fingerprint) {
        throw new ApiError(409, "This payout idempotency key was already used with different payout details.");
      }
      return { row: concurrent, created: false };
    }
    await enforceVerificationLimit(tx, merchant.id, "payout", minorToNumber(holdMinor), currency);
    if (!canReserveWalletFunds(wallet.availableMinor, holdMinor)) {
      throw new ApiError(409, `Available ${currency} wallet funds do not cover the payout and fee.`);
    }
    const reference = `GP-WP-${randomUUID()}`;
    await tx.update(merchantWalletsTable).set({
      availableMinor: wallet.availableMinor - holdMinor,
      reservedMinor: wallet.reservedMinor + holdMinor,
      updatedAt: new Date(),
    }).where(eq(merchantWalletsTable.id, wallet.id));
    const journal = await postJournal(tx, {
      merchantId: merchant.id,
      currency,
      kind: "payout_reserve",
      reference,
      sourceReference: reference,
      idempotencyKey: `payout:${merchant.id}:${input.idempotencyKey}:reserve`,
      metadata: { amountMinor: holdMinor.toString() },
      merchantAccount: "merchant_available",
      merchantDirection: "debit",
      secondMerchantAccount: "merchant_reserved",
    });
    const [created] = await tx.insert(walletPayoutRequestsTable).values({
      merchantId: merchant.id,
      reference,
      idempotencyKey: input.idempotencyKey,
      requestHash: fingerprint,
      amountMinor,
      feeMinor,
      holdMinor,
      destinationId: savedDestination?.id ?? null,
      destinationVersionId: savedVersion?.id ?? null,
      destinationVersion: savedVersion?.version ?? null,
      destinationFingerprint: destinationHash,
      requestedBy: input.requester ?? null,
      requiresSecondApproval,
      thresholdMinor,
      thresholdConfigured,
      currency,
      method: method.label,
      accountName: savedVersion?.accountName ?? maskDestinationName(destinationAccountName),
      maskedAccount: maskedAccount || "••••",
      encryptedDestination,
      status: "requested",
      provider: "payzaapi",
      reservationJournalId: journal.id,
    }).returning();
    if (!created) throw new ApiError(503, "Payout reservation could not be recorded.");
    await persistWalletPayoutTransition(tx, "not_created", created);
    return { row: created, created: true };
  });
  return walletPayoutRequestDto(createdRequest.row);
}

async function applyPayoutFinalState(
  tx: FinancialTx,
  request: WalletPayoutRequestRecord,
  finalStatus: "completed" | "rejected" | "failed",
  providerReference?: string | null,
) {
  if (request.status === "completed" || request.status === "rejected" || request.status === "failed") return request;
  const wallet = await lockWallet(tx, request.merchantId, request.currency);
  if (finalStatus === "completed") {
    if (wallet.reservedMinor < request.holdMinor) throw new ApiError(409, "Payout reservation is inconsistent; manual reconciliation is required.");
    await tx.update(merchantWalletsTable).set({
      reservedMinor: wallet.reservedMinor - request.holdMinor, updatedAt: new Date(),
    }).where(eq(merchantWalletsTable.id, wallet.id));
    await postJournal(tx, {
      merchantId: request.merchantId,
      currency: request.currency,
      kind: "payout_complete",
      reference: request.reference,
      sourceReference: providerReference ?? request.reference,
      idempotencyKey: `payout:${request.reference}:complete`,
      metadata: { amountMinor: request.holdMinor.toString() },
      merchantAccount: "merchant_reserved",
      merchantDirection: "debit",
      externalAccount: "platform_payout",
    });
  } else if (shouldReleasePayoutHold(finalStatus)) {
    if (wallet.reservedMinor < request.holdMinor) throw new ApiError(409, "Payout reservation is inconsistent; manual reconciliation is required.");
    await tx.update(merchantWalletsTable).set({
      availableMinor: wallet.availableMinor + request.holdMinor,
      reservedMinor: wallet.reservedMinor - request.holdMinor,
      updatedAt: new Date(),
    }).where(eq(merchantWalletsTable.id, wallet.id));
    await postJournal(tx, {
      merchantId: request.merchantId,
      currency: request.currency,
      kind: "payout_release",
      reference: request.reference,
      sourceReference: request.reference,
      idempotencyKey: `payout:${request.reference}:release`,
      metadata: { amountMinor: request.holdMinor.toString() },
      merchantAccount: "merchant_available",
      merchantDirection: "credit",
      secondMerchantAccount: "merchant_reserved",
    });
  }
  const [updated] = await tx.update(walletPayoutRequestsTable).set({
    status: finalStatus,
    providerReference: providerReference ?? request.providerReference,
    completedAt: finalStatus === "completed" ? new Date() : request.completedAt,
    updatedAt: new Date(),
  }).where(eq(walletPayoutRequestsTable.id, request.id)).returning();
  return updated ?? request;
}

export async function recordMerchantPayoutProviderOutcome(requestId: number, input: {
  status: "uncertain" | "processing" | "completed" | "rejected" | "failed";
  providerReference?: string | null;
}, _dependencies: { notifyWalletPayoutTransition?: WalletPayoutTransitionNotifier } = {}) {
  const result = await db.transaction(async (tx) => {
    const [request] = await tx.select().from(walletPayoutRequestsTable)
      .where(eq(walletPayoutRequestsTable.id, requestId)).for("update").limit(1);
    if (!request) throw new ApiError(404, "Payout request not found.");
    if (request.status === "completed" || request.status === "rejected" || request.status === "failed") {
      if (!input.providerReference || input.providerReference === request.providerReference) {
        return { previousStatus: request.status, row: request };
      }
      const [updated] = await tx.update(walletPayoutRequestsTable).set({
        providerReference: input.providerReference,
        updatedAt: new Date(),
      }).where(eq(walletPayoutRequestsTable.id, request.id)).returning();
      return { previousStatus: request.status, row: updated ?? request };
    }
    if (input.status === "completed" || input.status === "rejected" || input.status === "failed") {
      const row = await applyPayoutFinalState(tx, request, input.status, input.providerReference);
      await persistWalletPayoutTransition(tx, request.status, row);
      return { previousStatus: request.status, row };
    }
    const [updated] = await tx.update(walletPayoutRequestsTable).set({
      status: input.status,
      providerReference: input.providerReference ?? request.providerReference,
      updatedAt: new Date(),
    }).where(eq(walletPayoutRequestsTable.id, request.id)).returning();
    const row = updated ?? request;
    await persistWalletPayoutTransition(tx, request.status, row);
    return { previousStatus: request.status, row };
  });
  return result.row;
}

export async function rejectMerchantPayoutRequest(requestId: number, actor: string, reason: string) {
  const result = await db.transaction(async (tx) => {
    const [request] = await tx.select().from(walletPayoutRequestsTable)
      .where(eq(walletPayoutRequestsTable.id, requestId)).for("update").limit(1);
    if (!request) throw new ApiError(404, "Payout request not found.");
    if (!["requested", "awaiting_second_approval"].includes(request.status)) {
      throw new ApiError(409, "Only an unsubmitted payout request can be rejected.");
    }
    const updated = await applyPayoutFinalState(tx, request, "rejected");
    const [reviewed] = await tx.update(walletPayoutRequestsTable).set({
      decisionReason: reason,
      rejectedBy: actor,
      rejectedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(walletPayoutRequestsTable.id, request.id)).returning();
    await tx.insert(adminAuditLogTable).values({
      actor, action: "wallet.payout.rejected", target: `wallet-payout:${request.reference}`,
      details: `Merchant payout request rejected. ${reason}`,
    });
    const row = reviewed ?? updated;
    await persistWalletPayoutTransition(tx, request.status, row);
    return row;
  });
  return walletPayoutRequestDto(result);
}

type WalletPayoutApprovalDependencies = {
  assertPayoutsEnabled?: () => Promise<void>;
  providerIsConfigured?: () => Promise<boolean>;
  submitPayout?: (payload: Record<string, unknown>, reference: string) => Promise<Record<string, unknown>>;
  notifyWalletPayoutTransition?: WalletPayoutTransitionNotifier;
};

export async function approveAndSubmitMerchantPayout(
  requestId: number,
  actor: string,
  expectedDestinationFingerprint?: string,
  dependencies: WalletPayoutApprovalDependencies = {},
) {
  await (dependencies.assertPayoutsEnabled ?? (() => assertPlatformEnabled("payoutsEnabled")))();
  const approval = await db.transaction(async (tx) => {
    const [request] = await tx.select().from(walletPayoutRequestsTable)
      .where(eq(walletPayoutRequestsTable.id, requestId)).for("update").limit(1);
    if (!request) throw new ApiError(404, "Payout request not found.");
    const isSensitive = request.requiresSecondApproval || !request.thresholdConfigured ||
      request.destinationVersionId === null;
    if (request.requestedBy === actor) throw new ApiError(409, "The payout requester cannot approve their own payout.");
    const [merchant] = await tx.select().from(merchantsTable).where(eq(merchantsTable.id, request.merchantId)).limit(1);
    if (!merchant) throw new ApiError(409, "Payout merchant account no longer exists.");
    await enforceVerificationLimit(tx, merchant.id, "payout", minorToNumber(request.holdMinor), request.currency);
    await assertMerchantActionEnabled(merchant.id, "payoutRequests", tx);
    const now = new Date();
    let updated: WalletPayoutRequestRecord | undefined;
    let submit = false;
    if (request.status === "requested") {
      const values = isSensitive
        ? { status: "awaiting_second_approval", firstApprovedBy: actor, firstApprovedAt: now, updatedAt: now }
        : {
          status: "approved", approvedBy: actor, firstApprovedBy: actor,
          firstApprovedAt: now, submittedAt: now, updatedAt: now,
        };
      [updated] = await tx.update(walletPayoutRequestsTable).set(values).where(and(
        eq(walletPayoutRequestsTable.id, request.id),
        eq(walletPayoutRequestsTable.status, "requested"),
      )).returning();
      if (!updated) throw new ApiError(409, "Payout approval was concurrently processed.");
      submit = !isSensitive;
      await tx.insert(adminAuditLogTable).values({
        actor,
        action: isSensitive ? "wallet.payout.first_approved" : "wallet.payout.approved",
        target: `wallet-payout:${request.reference}`,
        details: isSensitive
          ? `First payout review recorded. Second approval is required for ${request.currency} ${minorToDecimal(request.amountMinor)} plus fee ${minorToDecimal(request.feeMinor)}; destination ${request.maskedAccount} (${request.destinationFingerprint ?? "legacy destination"}).`
          : `Merchant payout reviewed for one provider submission; destination ${request.maskedAccount} (${request.destinationFingerprint ?? "legacy destination"}).`,
      });
    } else if (request.status === "awaiting_second_approval" && isSensitive) {
      if (actor === request.firstApprovedBy) {
        throw new ApiError(409, "A different administrator must provide the second payout approval.");
      }
      if (!request.destinationFingerprint || expectedDestinationFingerprint !== request.destinationFingerprint) {
        throw new ApiError(409, "Second approval must match the exact destination version and fingerprint under review.");
      }
      [updated] = await tx.update(walletPayoutRequestsTable).set({
        status: "approved",
        approvedBy: actor,
        secondApprovedBy: actor,
        secondApprovedAt: now,
        submittedAt: now,
        updatedAt: now,
      }).where(and(
        eq(walletPayoutRequestsTable.id, request.id),
        eq(walletPayoutRequestsTable.status, "awaiting_second_approval"),
        eq(walletPayoutRequestsTable.destinationFingerprint, expectedDestinationFingerprint),
      )).returning();
      if (!updated) throw new ApiError(409, "Payout second approval was concurrently processed.");
      submit = true;
      await tx.insert(adminAuditLogTable).values({
        actor,
        action: "wallet.payout.second_approved",
        target: `wallet-payout:${request.reference}`,
        details: `Second payout approval bound to destination ${request.maskedAccount} (${request.destinationFingerprint}); amount ${request.currency} ${minorToDecimal(request.amountMinor)}, fee ${minorToDecimal(request.feeMinor)}.`,
      });
    } else {
      throw new ApiError(409, "This payout has already been approved, submitted, or reached a terminal outcome.");
    }
    await persistWalletPayoutTransition(tx, request.status, updated!);
    return {
      request: updated!,
      submit,
    };
  });

  if (!approval.submit) return walletPayoutRequestDto(approval.request);
  const approved = approval.request;
  if (!await (dependencies.providerIsConfigured ?? (() => providerIsConfigured("payzaapi")))()) {
    await recordMerchantPayoutProviderOutcome(requestId, { status: "uncertain" }, dependencies);
    throw new ApiError(503, "Payzaapi is not configured. The payout remains reserved for administrator reconciliation and will not be auto-submitted.");
  }
  let response: Record<string, unknown>;
  try {
    const destination = decryptDestination(approved.encryptedDestination);
    const payload: Record<string, unknown> = {
      amount: minorToNumber(approved.amountMinor),
      currency: approved.currency,
      method: destination.method,
      account_number: destination.accountNumber,
      account_name: destination.accountName,
      reference: approved.reference,
    };
    if (destination.bankCode) payload.bank_code = destination.bankCode;
    if (destination.bankName) payload.bank_name = destination.bankName;
    response = await (dependencies.submitPayout
      ? dependencies.submitPayout(payload, approved.reference)
      : payzaApiRequest("/payout", {
        method: "POST",
        headers: { "Idempotency-Key": approved.reference },
        body: JSON.stringify(payload),
      }));
  } catch {
    await recordMerchantPayoutProviderOutcome(requestId, { status: "uncertain" }, dependencies);
    throw new ApiError(503, `Payzaapi payout outcome is uncertain. Request ${approved.reference} remains reserved and cannot be re-submitted.`);
  }
  const payout = asObject(response.payout);
  const providerReference = stringValue(payout.reference) ?? stringValue(payout.id);
  const outcome = payoutProviderOutcome({
    accepted: typeof response.success === "boolean" ? response.success : undefined,
    providerReference,
    providerStatus: stringValue(payout.status),
  });
  const result = await recordMerchantPayoutProviderOutcome(requestId, {
    status: outcome, providerReference,
  }, dependencies);
  return walletPayoutRequestDto(result);
}

export async function reconcileMerchantPayoutRequest(requestId: number, dependencies: {
  providerIsConfigured?: () => Promise<boolean>;
  lookupPayout?: (reference: string) => Promise<Record<string, unknown>>;
} = {}) {
  const [request] = await db.select().from(walletPayoutRequestsTable)
    .where(eq(walletPayoutRequestsTable.id, requestId)).limit(1);
  if (!request) throw new ApiError(404, "Payout request not found.");
  if (!["approved", "uncertain", "processing"].includes(request.status)) {
    throw new ApiError(409, "Only an approved, processing, or uncertain payout can be reconciled.");
  }
  if (!await (dependencies.providerIsConfigured ?? (() => providerIsConfigured("payzaapi")))()) {
    throw new ApiError(503, "Payzaapi is not configured for payout reconciliation.");
  }
  const lookupReference = request.providerReference ?? request.reference;
  const response = await (dependencies.lookupPayout
    ? dependencies.lookupPayout(lookupReference)
    : payzaApiRequest(`/payouts?reference=${encodeURIComponent(lookupReference)}`));
  const payout = asObject(response.payout ?? (Array.isArray(response.payouts) ? response.payouts[0] : null));
  const status = stringValue(payout.status)?.toLowerCase();
  if (response.success !== true || !status) {
    throw new ApiError(503, "Payzaapi could not authoritatively verify this payout; its funds remain reserved.");
  }
  const providerReference = stringValue(payout.reference) ?? stringValue(payout.id) ?? request.providerReference;
  const normalized = payoutProviderOutcome({
    accepted: true, providerReference, providerStatus: status,
  });
  const updated = await recordMerchantPayoutProviderOutcome(request.id, {
    status: normalized, providerReference,
  });
  return walletPayoutRequestDto(updated);
}

export async function confirmWalletSettlement(input: {
  settlementReference: string;
  evidenceReference: string;
  actor: string;
}) {
  return db.transaction(async (tx) => {
    const [transaction] = await tx.select().from(transactionsTable)
      .where(eq(transactionsTable.reference, input.settlementReference)).for("update").limit(1);
    const [settlement] = await tx.select().from(settlementsTable)
      .where(eq(settlementsTable.reference, input.settlementReference)).for("update").limit(1);
    if (!transaction || !settlement) throw new ApiError(404, "Settlement or source collection was not found.");
    if (transaction.status !== "success" || !transaction.merchantId) {
      throw new ApiError(409, "Only a confirmed successful merchant collection can fund a wallet.");
    }
    if (!["pending", "due"].includes(settlement.status)) {
      throw new ApiError(409, "This settlement is not eligible for wallet reconciliation.");
    }
    if (settlement.currency !== transaction.currency) {
      throw new ApiError(409, "The settlement currency does not match the source collection.");
    }
    const [alreadyConfirmed] = await tx.select().from(walletSettlementConfirmationsTable)
      .where(eq(walletSettlementConfirmationsTable.settlementReference, settlement.reference)).limit(1);
    if (alreadyConfirmed) throw new ApiError(409, "This settlement has already been confirmed and credited.");
    const [openRefund] = await tx.select({ id: refundsTable.id }).from(refundsTable).where(and(
      eq(refundsTable.originalReference, transaction.reference),
      inArray(refundsTable.status, [...OPEN_REFUND_RESERVATION_STATUSES]),
    )).limit(1);
    if (openRefund) {
      throw new ApiError(409, "This collection has a pending or unresolved customer refund; reconcile it before wallet funding.");
    }
    const [refundSum] = await tx.select({
      total: sql<number>`coalesce(sum(${refundsTable.amount}), 0)::numeric`,
    }).from(refundsTable).where(and(
      eq(refundsTable.originalReference, transaction.reference),
      inArray(refundsTable.status, [...CUSTOMER_REIMBURSED_REFUND_STATUSES]),
    ));
    const confirmedNetMinor = decimalToMinor(
      Math.min(Number(transaction.platformNetAmount ?? transaction.netAmount ?? transaction.amount), Number(settlement.netAmount)),
    );
    const confirmedRefundMinor = decimalToMinor(Number(refundSum?.total ?? 0));
    const previousSource = await tx.select({ fundedMinor: walletSettlementConfirmationsTable.fundedMinor })
      .from(walletSettlementConfirmationsTable).where(eq(
        walletSettlementConfirmationsTable.settlementReference, transaction.reference,
      ));
    const previouslyFundedMinor = previousSource.reduce((total, row) => total + row.fundedMinor, 0n);
    const fundableMinor = eligibleSettlementFunding({
      confirmedNetMinor,
      confirmedRefundMinor,
      originalAmountMinor: decimalToMinor(Number(transaction.amount)),
      previouslyFundedMinor,
    });
    if (fundableMinor <= 0n) throw new ApiError(409, "Confirmed refunds leave no net collection available for wallet funding.");
    const wallet = await lockWallet(tx, transaction.merchantId, transaction.currency);
    const reference = `settlement:${settlement.reference}`;
    const journal = await postJournal(tx, {
      merchantId: transaction.merchantId,
      currency: transaction.currency,
      kind: "settlement_funding",
      reference,
      sourceReference: settlement.reference,
      evidenceReference: input.evidenceReference,
      idempotencyKey: `settlement:${settlement.reference}:funding`,
      metadata: { amountMinor: fundableMinor.toString() },
      merchantAccount: "merchant_available",
      merchantDirection: "credit",
      externalAccount: "platform_settlement",
    });
    await tx.update(merchantWalletsTable).set({
      availableMinor: wallet.availableMinor + fundableMinor,
      updatedAt: new Date(),
    }).where(eq(merchantWalletsTable.id, wallet.id));
    await tx.insert(walletSettlementConfirmationsTable).values({
      settlementReference: settlement.reference,
      merchantId: transaction.merchantId,
      currency: transaction.currency,
      fundedMinor: fundableMinor,
      evidenceReference: input.evidenceReference,
      journalId: journal.id,
      confirmedBy: input.actor,
    });
    await tx.update(settlementsTable).set({ status: "settled", settledAt: new Date() })
      .where(eq(settlementsTable.id, settlement.id));
    await tx.update(transactionsTable).set({ settlementStatus: "settled" })
      .where(eq(transactionsTable.id, transaction.id));
    await tx.insert(adminAuditLogTable).values({
      actor: input.actor,
      action: "wallet.settlement.confirmed",
      target: `settlement:${settlement.reference}`,
      details: `Confirmed ${minorToDecimal(fundableMinor)} ${settlement.currency} with evidence reference ${input.evidenceReference}.`,
    });
    return {
      settlementReference: settlement.reference,
      merchantId: transaction.merchantId,
      currency: settlement.currency,
      fundedAmount: minorToNumber(fundableMinor),
      evidenceReference: input.evidenceReference,
      confirmedAt: new Date(),
    };
  });
}

export async function reserveWalletRefundFunds(
  tx: FinancialTx,
  transaction: typeof transactionsTable.$inferSelect,
  refund: typeof refundsTable.$inferSelect,
): Promise<void> {
  if (!transaction.merchantId || ![
    ...CUSTOMER_REIMBURSED_REFUND_STATUSES,
    ...OPEN_REFUND_RESERVATION_STATUSES,
  ].includes(refund.status as never)) return;
  const [funding] = await tx.select().from(walletSettlementConfirmationsTable)
    .where(eq(walletSettlementConfirmationsTable.settlementReference, transaction.reference))
    .for("update").limit(1);
  if (!funding) return;
  const [settlement] = await tx.select().from(settlementsTable)
    .where(eq(settlementsTable.reference, transaction.reference)).for("update").limit(1);
  if (!settlement || settlement.currency !== transaction.currency) {
    throw new ApiError(409, "Wallet-funded settlement source is inconsistent; manual reconciliation is required.");
  }
  const [existing] = await tx.select().from(walletRefundAdjustmentsTable)
    .where(eq(walletRefundAdjustmentsTable.refundReference, refund.reference)).for("update").limit(1);
  if (existing) return;
  const [refundTotal] = await tx.select({
    total: sql<number>`coalesce(sum(${refundsTable.amount}), 0)::numeric`,
  }).from(refundsTable).where(and(
    eq(refundsTable.originalReference, transaction.reference),
    inArray(refundsTable.status, [
      ...CUSTOMER_REIMBURSED_REFUND_STATUSES,
      ...OPEN_REFUND_RESERVATION_STATUSES,
    ]),
  ));
  const totalRefundMinor = decimalToMinor(Number(refundTotal?.total ?? 0));
  const originalMinor = decimalToMinor(Number(transaction.amount));
  const eligibleNetMinor = decimalToMinor(
    Math.min(Number(transaction.platformNetAmount ?? transaction.netAmount ?? transaction.amount), Number(settlement.netAmount)),
  );
  const targetReversalMinor = proportionalNetRefundReversal(eligibleNetMinor, totalRefundMinor, originalMinor);
  const preFundingReversalMinor = eligibleNetMinor > funding.fundedMinor
    ? eligibleNetMinor - funding.fundedMinor
    : 0n;
  const [previous] = await tx.select({
    total: sql<string>`coalesce(sum(${walletRefundAdjustmentsTable.amountMinor}), 0)::text`,
  }).from(walletRefundAdjustmentsTable).where(and(
    eq(walletRefundAdjustmentsTable.transactionReference, transaction.reference),
    inArray(walletRefundAdjustmentsTable.status, ["reserved", "committed"]),
  ));
  const previousMinor = preFundingReversalMinor + BigInt(previous?.total ?? "0");
  const adjustmentMinor = targetReversalMinor - previousMinor;
  if (adjustmentMinor <= 0n) return;
  const wallet = await lockWallet(tx, transaction.merchantId, transaction.currency);
  if (!canApplyWalletRefundAdjustment(wallet.availableMinor, adjustmentMinor)) {
    throw new ApiError(409, "Refund cannot be recorded because wallet-funded proceeds for this collection have already been reserved or spent.");
  }
  await tx.update(merchantWalletsTable).set({
    availableMinor: wallet.availableMinor - adjustmentMinor,
    reservedMinor: wallet.reservedMinor + adjustmentMinor,
    updatedAt: new Date(),
  }).where(eq(merchantWalletsTable.id, wallet.id));
  const journal = await postJournal(tx, {
    merchantId: transaction.merchantId,
    currency: transaction.currency,
    kind: "refund_adjustment",
    reference: `refund:${refund.reference}`,
    sourceReference: transaction.reference,
    idempotencyKey: `refund:${refund.reference}:reserve`,
    metadata: { amountMinor: adjustmentMinor.toString() },
    merchantAccount: "merchant_available",
    merchantDirection: "debit",
    secondMerchantAccount: "merchant_reserved",
  });
  await tx.insert(walletRefundAdjustmentsTable).values({
    refundReference: refund.reference,
    transactionReference: transaction.reference,
    merchantId: transaction.merchantId,
    currency: transaction.currency,
    amountMinor: adjustmentMinor,
    reserveJournalId: journal.id,
  });
}

export async function settleWalletRefundFunds(
  tx: FinancialTx,
  transaction: typeof transactionsTable.$inferSelect,
  refund: typeof refundsTable.$inferSelect,
): Promise<void> {
  if (CUSTOMER_REIMBURSED_REFUND_STATUSES.includes(refund.status as never)) {
    await reserveWalletRefundFunds(tx, transaction, refund);
  }
  const [adjustment] = await tx.select().from(walletRefundAdjustmentsTable)
    .where(eq(walletRefundAdjustmentsTable.refundReference, refund.reference)).for("update").limit(1);
  if (!adjustment || adjustment.status !== "reserved") return;
  const isConfirmed = CUSTOMER_REIMBURSED_REFUND_STATUSES.includes(refund.status as never);
  const isDefinitiveFailure = ["failed", "reversed", "rejected", "cancelled"].includes(refund.status);
  if (!isConfirmed && !isDefinitiveFailure) return;
  const wallet = await lockWallet(tx, adjustment.merchantId, adjustment.currency);
  if (wallet.reservedMinor < adjustment.amountMinor) {
    throw new ApiError(409, "Refund wallet reservation is inconsistent; manual reconciliation is required.");
  }
  if (isConfirmed) {
    await tx.update(merchantWalletsTable).set({
      reservedMinor: wallet.reservedMinor - adjustment.amountMinor,
      updatedAt: new Date(),
    }).where(eq(merchantWalletsTable.id, wallet.id));
    await postJournal(tx, {
      merchantId: adjustment.merchantId,
      currency: adjustment.currency,
      kind: "refund_adjustment",
      reference: refund.reference,
      sourceReference: transaction.reference,
      idempotencyKey: `refund:${refund.reference}:commit`,
      metadata: { amountMinor: adjustment.amountMinor.toString() },
      merchantAccount: "merchant_reserved",
      merchantDirection: "debit",
      externalAccount: "platform_settlement",
    });
    await tx.update(walletRefundAdjustmentsTable).set({
      status: "committed", updatedAt: new Date(),
    }).where(eq(walletRefundAdjustmentsTable.id, adjustment.id));
  } else {
    await tx.update(merchantWalletsTable).set({
      availableMinor: wallet.availableMinor + adjustment.amountMinor,
      reservedMinor: wallet.reservedMinor - adjustment.amountMinor,
      updatedAt: new Date(),
    }).where(eq(merchantWalletsTable.id, wallet.id));
    await postJournal(tx, {
      merchantId: adjustment.merchantId,
      currency: adjustment.currency,
      kind: "refund_adjustment",
      reference: refund.reference,
      sourceReference: transaction.reference,
      idempotencyKey: `refund:${refund.reference}:release`,
      metadata: { amountMinor: adjustment.amountMinor.toString() },
      merchantAccount: "merchant_available",
      merchantDirection: "credit",
      secondMerchantAccount: "merchant_reserved",
    });
    await tx.update(walletRefundAdjustmentsTable).set({
      status: "released", updatedAt: new Date(),
    }).where(eq(walletRefundAdjustmentsTable.id, adjustment.id));
  }
}

export async function setWalletPayoutStatusFromProvider(
  provider: string,
  providerReference: string,
  status: "processing" | "completed" | "rejected" | "failed",
  dependencies: { notifyWalletPayoutTransition?: WalletPayoutTransitionNotifier } = {},
): Promise<boolean> {
  const [request] = await db.select().from(walletPayoutRequestsTable).where(and(
    eq(walletPayoutRequestsTable.provider, provider),
    or(
      eq(walletPayoutRequestsTable.providerReference, providerReference),
      eq(walletPayoutRequestsTable.reference, providerReference),
    ),
  )).limit(1);
  if (!request) return false;
  await recordMerchantPayoutProviderOutcome(request.id, {
    status,
    providerReference: request.reference === providerReference ? request.providerReference : providerReference,
  }, dependencies);
  return true;
}

export async function reconcileMerchantPayoutByReference(reference: string): Promise<boolean> {
  const [request] = await db.select({ id: walletPayoutRequestsTable.id }).from(walletPayoutRequestsTable).where(and(
    eq(walletPayoutRequestsTable.provider, "payzaapi"),
    or(
      eq(walletPayoutRequestsTable.providerReference, reference),
      eq(walletPayoutRequestsTable.reference, reference),
    ),
  )).limit(1);
  if (!request) return false;
  await reconcileMerchantPayoutRequest(request.id);
  return true;
}
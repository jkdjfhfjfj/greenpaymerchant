import { createHash, randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import {
  adminAuditLogTable, airtimePurchasesTable, airtimeStatumCallbacksTable, airtimeTopupsTable,
  airtimeWalletEntriesTable, airtimeWalletsTable, db, merchantsTable,
} from "@workspace/db";
import { ApiError } from "./api-error";
import { providerCredential } from "./credential-runtime";
import {
  getProviderWebhookUrl, normalizeKenyanPhone, payheroHeaders, providerIsConfigured,
} from "./greenpay-provider";
import { isStatumConfigured, parseKesMinor, submitStatumAirtime } from "./statum-provider";

type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type TopupRow = typeof airtimeTopupsTable.$inferSelect;
type PurchaseRow = typeof airtimePurchasesTable.$inferSelect;
type CallbackRow = typeof airtimeStatumCallbacksTable.$inferSelect;
type AirtimeCallback = {
  request_id: string;
  charge: number | string;
  account_balance?: number | string;
  result_code: number | string;
  result_desc: string;
};

const TERMINAL_STATUSES = new Set(["succeeded", "failed"]);

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function moneyFromMinor(value: bigint | null): number | null {
  return value === null ? null : Number(value) / 100;
}

function amountToMinor(amountKes: number): bigint {
  if (!Number.isSafeInteger(amountKes) || amountKes <= 0 ||
      amountKes > Math.floor(Number.MAX_SAFE_INTEGER / 100)) {
    throw new ApiError(400, "Enter a positive whole KES amount.");
  }
  return BigInt(amountKes) * 100n;
}

function walletDto(wallet: typeof airtimeWalletsTable.$inferSelect) {
  return {
    currency: "KES" as const,
    availableBalance: Number(wallet.availableMinor) / 100,
    reservedBalance: Number(wallet.reservedMinor) / 100,
    updatedAt: wallet.updatedAt,
  };
}

export function airtimeTopupDto(row: TopupRow) {
  return {
    reference: row.reference,
    phoneNumber: row.phoneNumber,
    amount: Number(row.amountMinor) / 100,
    status: row.status,
    providerReference: row.providerReference,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function airtimePurchaseDto(row: PurchaseRow) {
  return {
    reference: row.reference,
    phoneNumber: row.phoneNumber,
    amount: Number(row.amountMinor) / 100,
    charge: moneyFromMinor(row.chargeMinor),
    status: row.status,
    providerRequestId: row.providerRequestId,
    resultDescription: row.resultDescription,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function lockWallet(tx: DbTx, merchantId: number) {
  await tx.insert(airtimeWalletsTable).values({ merchantId }).onConflictDoNothing();
  const [wallet] = await tx.select().from(airtimeWalletsTable)
    .where(eq(airtimeWalletsTable.merchantId, merchantId)).for("update").limit(1);
  if (!wallet) throw new ApiError(503, "Airtime wallet could not be locked safely.");
  return wallet;
}

async function loadWallet(merchantId: number) {
  return db.transaction((tx) => lockWallet(tx, merchantId));
}

export async function getAirtimeWallet(merchantId: number) {
  return walletDto(await loadWallet(merchantId));
}

export async function getMerchantAirtimeDashboard(merchantId: number) {
  const wallet = await loadWallet(merchantId);
  const [topups, purchases] = await Promise.all([
    db.select().from(airtimeTopupsTable).where(eq(airtimeTopupsTable.merchantId, merchantId))
      .orderBy(desc(airtimeTopupsTable.createdAt)).limit(20),
    db.select().from(airtimePurchasesTable).where(eq(airtimePurchasesTable.merchantId, merchantId))
      .orderBy(desc(airtimePurchasesTable.createdAt)).limit(20),
  ]);
  return {
    wallet: walletDto(wallet),
    topups: topups.map(airtimeTopupDto),
    purchases: purchases.map(airtimePurchaseDto),
  };
}

export async function listAdminAirtimeTopupsForReview() {
  const rows = await db.select({
    reference: airtimeTopupsTable.reference,
    merchantId: airtimeTopupsTable.merchantId,
    businessName: merchantsTable.businessName,
    phoneNumber: airtimeTopupsTable.phoneNumber,
    amountMinor: airtimeTopupsTable.amountMinor,
    status: airtimeTopupsTable.status,
    providerReference: airtimeTopupsTable.providerReference,
    createdAt: airtimeTopupsTable.createdAt,
    updatedAt: airtimeTopupsTable.updatedAt,
    lastCheckedAt: airtimeTopupsTable.lastCheckedAt,
    lastError: airtimeTopupsTable.lastError,
  }).from(airtimeTopupsTable)
    .innerJoin(merchantsTable, eq(airtimeTopupsTable.merchantId, merchantsTable.id))
    .where(inArray(airtimeTopupsTable.status, ["initiating", "pending", "unknown", "failed"]))
    .orderBy(desc(airtimeTopupsTable.createdAt))
    .limit(100);
  return {
    items: rows.map(({ amountMinor, ...row }) => ({
      ...row,
      amount: Number(amountMinor) / 100,
    })),
  };
}

export async function listAirtimePurchases(merchantId: number) {
  const items = await db.select().from(airtimePurchasesTable)
    .where(eq(airtimePurchasesTable.merchantId, merchantId))
    .orderBy(desc(airtimePurchasesTable.createdAt)).limit(50);
  return { items: items.map(airtimePurchaseDto) };
}

export async function getAirtimePurchase(merchantId: number, reference: string) {
  const [row] = await db.select().from(airtimePurchasesTable).where(and(
    eq(airtimePurchasesTable.merchantId, merchantId),
    eq(airtimePurchasesTable.reference, reference),
  )).limit(1);
  return row ? airtimePurchaseDto(row) : null;
}

function assertSameIdempotentRequest(existing: { requestHash: string }, requestHash: string): void {
  if (existing.requestHash !== requestHash) {
    throw new ApiError(409, "This Idempotency-Key was already used with different airtime request details.");
  }
}

async function reserveTopup(input: {
  merchantId: number;
  idempotencyKey: string;
  phoneNumber: string;
  amountMinor: bigint;
}): Promise<{ row: TopupRow; created: boolean }> {
  const requestHash = fingerprint({ phoneNumber: input.phoneNumber, amountMinor: input.amountMinor.toString() });
  return db.transaction(async (tx) => {
    await lockWallet(tx, input.merchantId);
    const [existing] = await tx.select().from(airtimeTopupsTable).where(and(
      eq(airtimeTopupsTable.merchantId, input.merchantId),
      eq(airtimeTopupsTable.idempotencyKey, input.idempotencyKey),
    )).limit(1);
    if (existing) {
      assertSameIdempotentRequest(existing, requestHash);
      return { row: existing, created: false };
    }
    const [unresolved] = await tx.select({ reference: airtimeTopupsTable.reference })
      .from(airtimeTopupsTable).where(and(
        eq(airtimeTopupsTable.merchantId, input.merchantId),
        inArray(airtimeTopupsTable.status, ["initiating", "unknown"]),
        isNull(airtimeTopupsTable.providerReference),
      )).for("update").limit(1);
    if (unresolved) {
      throw new ApiError(409, `A previous top-up (${unresolved.reference}) has an unconfirmed PayHero outcome. It must be reconciled before starting another prompt.`);
    }
    const reference = `ATU_${randomUUID()}`;
    const [row] = await tx.insert(airtimeTopupsTable).values({
      merchantId: input.merchantId,
      reference,
      idempotencyKey: input.idempotencyKey,
      requestHash,
      phoneNumber: input.phoneNumber,
      amountMinor: input.amountMinor,
      status: "initiating",
    }).returning();
    if (!row) throw new ApiError(503, "Airtime top-up request could not be saved.");
    return { row, created: true };
  });
}

async function updateTopup(reference: string, changes: Partial<typeof airtimeTopupsTable.$inferInsert>) {
  const update = db.update(airtimeTopupsTable).set({
    ...changes,
    updatedAt: new Date(),
  });
  const [row] = await (changes.status
    ? update.where(and(
      eq(airtimeTopupsTable.reference, reference),
      eq(airtimeTopupsTable.status, "initiating"),
    )).returning()
    : update.where(eq(airtimeTopupsTable.reference, reference)).returning());
  if (row) return row;
  const [current] = await db.select().from(airtimeTopupsTable)
    .where(eq(airtimeTopupsTable.reference, reference)).limit(1);
  return current;
}

async function beginPayheroTopup(row: TopupRow): Promise<TopupRow> {
  const channelId = await providerCredential("payhero", "PAYHERO_CHANNEL_ID");
  let response: Response;
  try {
    response = await fetch("https://backend.payhero.co.ke/api/v2/payments", {
      method: "POST",
      headers: await payheroHeaders(),
      body: JSON.stringify({
        amount: Number(row.amountMinor) / 100,
        phone_number: row.phoneNumber,
        channel_id: Number(channelId),
        provider: "m-pesa",
        external_reference: row.reference,
        customer_name: "Greenpay airtime wallet",
        callback_url: getProviderWebhookUrl("payhero"),
      }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    return (await updateTopup(row.reference, {
      status: "unknown",
      lastError: "PayHero initiation timed out; the prompt was not retried to avoid a duplicate charge.",
    })) ?? row;
  }

  let payload: Record<string, unknown>;
  try {
    const decoded: unknown = await response.json();
    payload = decoded && typeof decoded === "object" && !Array.isArray(decoded)
      ? decoded as Record<string, unknown>
      : {};
  } catch {
    return (await updateTopup(row.reference, {
      status: "unknown",
      lastError: "PayHero returned an unreadable initiation response; no second prompt was sent.",
    })) ?? row;
  }
  const providerReference = typeof payload.reference === "string" && payload.reference.trim()
    ? payload.reference.trim()
    : null;
  if (response.ok && payload.success === true && providerReference) {
    return (await updateTopup(row.reference, {
      status: "pending",
      providerReference,
      lastError: null,
    })) ?? row;
  }
  const providerMessage = typeof payload.message === "string" ? payload.message.slice(0, 500) : null;
  const uncertain = response.status >= 500 || response.status === 429 || (response.ok && payload.success === true);
  return (await updateTopup(row.reference, {
    status: uncertain ? "unknown" : "failed",
    providerReference,
    lastError: providerMessage ?? (uncertain
      ? "PayHero did not confirm whether the prompt started; it was not retried."
      : "PayHero rejected the airtime wallet funding request."),
  })) ?? row;
}

export async function createAirtimeTopup(input: {
  merchantId: number;
  idempotencyKey: string;
  phoneNumber: string;
  amountKes: number;
}): Promise<TopupRow> {
  if (!await providerIsConfigured("payhero")) {
    throw new ApiError(503, "PayHero is not configured for airtime wallet funding.");
  }
  const phoneNumber = normalizeKenyanPhone(input.phoneNumber);
  const amountMinor = amountToMinor(input.amountKes);
  const reservation = await reserveTopup({ ...input, phoneNumber, amountMinor });
  return reservation.created ? beginPayheroTopup(reservation.row) : reservation.row;
}

function normalizeProviderStatus(value: unknown): "succeeded" | "failed" | "pending" {
  const status = typeof value === "string" ? value.toLowerCase() : "";
  if (["success", "successful", "paid", "completed"].includes(status)) return "succeeded";
  if (["failed", "failure", "declined", "cancelled", "canceled"].includes(status)) return "failed";
  return "pending";
}

function firstText(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.trim().length > 0)?.trim();
}

function validatePayheroEvidence(row: TopupRow, payload: Record<string, unknown>): string | null {
  const amount = parseKesMinor(payload.amount);
  const currency = firstText(payload.currency)?.toUpperCase();
  const providerReference = firstText(payload.reference, payload.transaction_reference, payload.checkout_request_id, payload.CheckoutRequestID);
  const externalReference = firstText(payload.external_reference, payload.ExternalReference);
  const referenceMatches = row.providerReference
    ? providerReference === row.providerReference || externalReference === row.reference
    : providerReference === row.reference || externalReference === row.reference;
  if (!referenceMatches || amount !== row.amountMinor || currency !== "KES") {
    throw new ApiError(502, "PayHero status evidence did not match the airtime wallet top-up reference, amount, and KES currency.");
  }
  return providerReference && providerReference !== row.reference ? providerReference : null;
}

async function settleTopup(reference: string, result: "succeeded" | "failed", reason?: string) {
  return db.transaction(async (tx) => {
    const [candidate] = await tx.select().from(airtimeTopupsTable)
      .where(eq(airtimeTopupsTable.reference, reference)).limit(1);
    if (!candidate) return undefined;
    const wallet = await lockWallet(tx, candidate.merchantId);
    const [topup] = await tx.select().from(airtimeTopupsTable)
      .where(eq(airtimeTopupsTable.reference, reference)).for("update").limit(1);
    if (!topup || TERMINAL_STATUSES.has(topup.status)) return topup;
    if (result === "succeeded") {
      const maxMinor = (1n << 63n) - 1n;
      if (topup.amountMinor <= 0n || wallet.availableMinor > maxMinor - topup.amountMinor) {
        throw new ApiError(409, "The airtime wallet balance would exceed the supported range.");
      }
      const key = `topup:credit:${topup.reference}`;
      const [entry] = await tx.insert(airtimeWalletEntriesTable).values({
        merchantId: topup.merchantId,
        reference: topup.reference,
        kind: "payhero_topup_credit",
        idempotencyKey: key,
        requestHash: fingerprint({ kind: "payhero_topup_credit", reference: topup.reference, amount: topup.amountMinor.toString() }),
        availableDeltaMinor: topup.amountMinor,
        reservedDeltaMinor: 0n,
        metadata: { provider: "payhero", providerReference: topup.providerReference },
      }).onConflictDoNothing().returning();
      if (entry) {
        await tx.update(airtimeWalletsTable).set({
          availableMinor: wallet.availableMinor + topup.amountMinor,
          updatedAt: new Date(),
        }).where(eq(airtimeWalletsTable.id, wallet.id));
      }
    }
    const [updated] = await tx.update(airtimeTopupsTable).set({
      status: result,
      lastError: reason ?? null,
      lastCheckedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(airtimeTopupsTable.id, topup.id)).returning();
    return updated;
  });
}

export async function reconcileAirtimeTopup(reference: string): Promise<"not_found" | "pending" | "succeeded" | "failed"> {
  const [row] = await db.select().from(airtimeTopupsTable)
    .where(eq(airtimeTopupsTable.reference, reference)).limit(1);
  if (!row) return "not_found";
  if (TERMINAL_STATUSES.has(row.status)) return row.status as "succeeded" | "failed";

  let response: Response;
  try {
    response = await fetch(
      `https://backend.payhero.co.ke/api/v2/transaction-status?reference=${encodeURIComponent(row.providerReference ?? row.reference)}`,
      { headers: await payheroHeaders(), signal: AbortSignal.timeout(15_000) },
    );
  } catch {
    await updateTopup(row.reference, { lastCheckedAt: new Date() });
    throw new ApiError(502, "PayHero payment confirmation is temporarily unavailable.");
  }
  let decoded: unknown;
  try {
    decoded = await response.json();
  } catch {
    await updateTopup(row.reference, { lastCheckedAt: new Date() });
    throw new ApiError(502, "PayHero returned an unreadable payment status.");
  }
  const payload = decoded && typeof decoded === "object" && !Array.isArray(decoded)
    ? decoded as Record<string, unknown>
    : {};
  if (!response.ok) {
    await updateTopup(row.reference, { lastCheckedAt: new Date() });
    throw new ApiError(502, "PayHero payment confirmation is temporarily unavailable.");
  }
  const status = normalizeProviderStatus(payload.status);
  if (status === "pending") {
    await updateTopup(row.reference, { lastCheckedAt: new Date(), lastError: null });
    return "pending";
  }
  const providerReference = validatePayheroEvidence(row, payload);
  if (providerReference && !row.providerReference) {
    await updateTopup(row.reference, { providerReference });
  }
  const result = status === "succeeded" ? "succeeded" : "failed";
  await settleTopup(row.reference, result, result === "failed"
    ? firstText(payload.status_message, payload.message, payload.reason) ?? "PayHero confirmed the funding request failed."
    : undefined);
  return result;
}

function normalizeMpesareceipt(value: string): string {
  const reference = value.trim().replace(/\s+/g, "").toUpperCase();
  if (!/^[A-Z0-9-]{4,100}$/.test(reference)) {
    throw new ApiError(400, "Enter a valid M-Pesa receipt reference using letters, numbers, or hyphens.");
  }
  return reference;
}

export async function confirmAdminAirtimeTopupCredit(input: {
  reference: string;
  evidenceReference: string;
  reason: string;
  idempotencyKey: string;
  actor: string;
}) {
  const evidenceReference = normalizeMpesareceipt(input.evidenceReference);
  const reason = input.reason.trim();
  if (reason.length < 3 || reason.length > 1000) {
    throw new ApiError(400, "Enter an audit reason between 3 and 1000 characters.");
  }
  if (input.idempotencyKey.length < 8 || input.idempotencyKey.length > 128) {
    throw new ApiError(400, "A valid Idempotency-Key header is required.");
  }

  const manualRequestHash = fingerprint({
    reference: input.reference,
    evidenceReference,
    reason,
  });
  return db.transaction(async (tx) => {
    const [candidate] = await tx.select().from(airtimeTopupsTable)
      .where(eq(airtimeTopupsTable.reference, input.reference)).limit(1);
    if (!candidate) throw new ApiError(404, "Airtime top-up not found.");

    // Keep the wallet lock ahead of the top-up lock, matching top-up creation and
    // avoiding a wallet/top-up lock-order inversion during concurrent requests.
    const wallet = await lockWallet(tx, candidate.merchantId);
    const [topup] = await tx.select().from(airtimeTopupsTable)
      .where(eq(airtimeTopupsTable.reference, input.reference)).for("update").limit(1);
    if (!topup) throw new ApiError(404, "Airtime top-up not found.");
    const [merchant] = await tx.select({ businessName: merchantsTable.businessName })
      .from(merchantsTable).where(eq(merchantsTable.id, topup.merchantId)).limit(1);
    if (!merchant) throw new ApiError(404, "Merchant account not found.");

    // Serialize use of a receipt across merchants as well as across retries.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${evidenceReference}, 0))`);
    const [evidenceEntry] = await tx.select().from(airtimeWalletEntriesTable).where(
      sql`${airtimeWalletEntriesTable.metadata} ->> 'evidenceReference' = ${evidenceReference}`,
    ).limit(1);
    if (evidenceEntry) {
      const sameManualConfirmation =
        evidenceEntry.merchantId === topup.merchantId &&
        evidenceEntry.reference === topup.reference &&
        evidenceEntry.kind === "payhero_topup_credit" &&
        evidenceEntry.metadata.manualRequestHash === manualRequestHash &&
        topup.status === "succeeded";
      if (!sameManualConfirmation) {
        throw new ApiError(409, "This M-Pesa receipt has already been used for an airtime credit.");
      }
      return {
        topupReference: topup.reference,
        merchantId: topup.merchantId,
        businessName: merchant.businessName,
        amount: Number(topup.amountMinor) / 100,
        currency: "KES" as const,
        status: "succeeded" as const,
        evidenceReference,
        availableBalance: Number(wallet.availableMinor) / 100,
        reservedBalance: Number(wallet.reservedMinor) / 100,
        updatedAt: topup.updatedAt,
      };
    }

    if (topup.status === "succeeded") {
      throw new ApiError(409, "This airtime top-up has already been credited automatically.");
    }
    if (!["initiating", "pending", "unknown", "failed"].includes(topup.status)) {
      throw new ApiError(409, "This airtime top-up is not eligible for manual payment confirmation.");
    }

    const maxMinor = (1n << 63n) - 1n;
    if (topup.amountMinor <= 0n || wallet.availableMinor > maxMinor - topup.amountMinor) {
      throw new ApiError(409, "The airtime wallet balance would exceed the supported range.");
    }
    const key = `topup:credit:${topup.reference}`;
    const creditRequestHash = fingerprint({
      kind: "payhero_topup_credit",
      reference: topup.reference,
      amount: topup.amountMinor.toString(),
    });
    const [existingCredit] = await tx.select().from(airtimeWalletEntriesTable).where(and(
      eq(airtimeWalletEntriesTable.merchantId, topup.merchantId),
      eq(airtimeWalletEntriesTable.idempotencyKey, key),
    )).limit(1);
    if (existingCredit) {
      throw new ApiError(409, "A credit entry already exists for this top-up; review its ledger before retrying.");
    }

    const now = new Date();
    const [entry] = await tx.insert(airtimeWalletEntriesTable).values({
      merchantId: topup.merchantId,
      reference: topup.reference,
      kind: "payhero_topup_credit",
      idempotencyKey: key,
      requestHash: creditRequestHash,
      availableDeltaMinor: topup.amountMinor,
      reservedDeltaMinor: 0n,
      metadata: {
        provider: "payhero",
        providerReference: topup.providerReference,
        source: "admin_manual_confirmation",
        evidenceReference,
        reason,
        actorUserId: input.actor,
        previousStatus: topup.status,
        manualRequestHash,
      },
    }).onConflictDoNothing().returning();
    if (!entry) throw new ApiError(409, "This airtime top-up already has a credit ledger entry.");

    const nextAvailable = wallet.availableMinor + topup.amountMinor;
    await tx.update(airtimeWalletsTable).set({
      availableMinor: nextAvailable,
      updatedAt: now,
    }).where(eq(airtimeWalletsTable.id, wallet.id));
    const [updatedTopup] = await tx.update(airtimeTopupsTable).set({
      status: "succeeded",
      lastError: null,
      lastCheckedAt: now,
      updatedAt: now,
    }).where(eq(airtimeTopupsTable.id, topup.id)).returning();
    if (!updatedTopup) throw new ApiError(500, "The airtime top-up could not be updated.");

    await tx.insert(adminAuditLogTable).values({
      actor: input.actor,
      action: "airtime.admin_topup_confirmed",
      target: `merchant:${topup.merchantId}/airtime-wallet`,
      details: JSON.stringify({
        topupReference: topup.reference,
        evidenceReference,
        previousStatus: topup.status,
        amount: Number(topup.amountMinor) / 100,
        reason,
      }),
    });

    return {
      topupReference: topup.reference,
      merchantId: topup.merchantId,
      businessName: merchant.businessName,
      amount: Number(topup.amountMinor) / 100,
      currency: "KES" as const,
      status: "succeeded" as const,
      evidenceReference,
      availableBalance: Number(nextAvailable) / 100,
      reservedBalance: Number(wallet.reservedMinor) / 100,
      updatedAt: updatedTopup.updatedAt,
    };
  });
}

export async function recordAirtimeTopupReconciliationFailure(reference: string, error: unknown): Promise<void> {
  const message = error instanceof ApiError
    ? error.message.slice(0, 500)
    : "Payment status could not be confirmed. Greenpay will check again.";
  const now = new Date();
  await db.update(airtimeTopupsTable).set({
    lastCheckedAt: now,
    lastError: message,
    updatedAt: now,
  }).where(and(
    eq(airtimeTopupsTable.reference, reference),
    inArray(airtimeTopupsTable.status, ["initiating", "pending", "unknown"]),
  ));
}

export async function createAirtimePurchase(input: {
  merchantId: number;
  idempotencyKey: string;
  phoneNumber: string;
  amountKes: number;
}): Promise<PurchaseRow> {
  if (!await isStatumConfigured()) {
    throw new ApiError(503, "Statum is not configured for airtime purchases.");
  }
  const phoneNumber = normalizeKenyanPhone(input.phoneNumber);
  const amountMinor = amountToMinor(input.amountKes);
  const requestHash = fingerprint({ phoneNumber, amountMinor: amountMinor.toString() });
  const reservation = await db.transaction(async (tx) => {
    const wallet = await lockWallet(tx, input.merchantId);
    const [existing] = await tx.select().from(airtimePurchasesTable).where(and(
      eq(airtimePurchasesTable.merchantId, input.merchantId),
      eq(airtimePurchasesTable.idempotencyKey, input.idempotencyKey),
    )).limit(1);
    if (existing) {
      assertSameIdempotentRequest(existing, requestHash);
      return { row: existing, created: false };
    }
    if (wallet.availableMinor < amountMinor) {
      throw new ApiError(409, "The airtime wallet does not have enough available KES balance.");
    }
    const reference = `ATP_${randomUUID()}`;
    const [row] = await tx.insert(airtimePurchasesTable).values({
      merchantId: input.merchantId,
      reference,
      idempotencyKey: input.idempotencyKey,
      requestHash,
      phoneNumber,
      amountMinor,
      status: "submitting",
    }).returning();
    if (!row) throw new ApiError(503, "Airtime purchase could not be saved.");
    const [entry] = await tx.insert(airtimeWalletEntriesTable).values({
      merchantId: input.merchantId,
      reference,
      kind: "airtime_purchase_reservation",
      idempotencyKey: `purchase:reserve:${reference}`,
      requestHash: fingerprint({ kind: "reserve", reference, amount: amountMinor.toString() }),
      availableDeltaMinor: -amountMinor,
      reservedDeltaMinor: amountMinor,
      metadata: { phoneNumber },
    }).returning();
    if (!entry) throw new ApiError(503, "Airtime purchase funds could not be reserved.");
    await tx.update(airtimeWalletsTable).set({
      availableMinor: wallet.availableMinor - amountMinor,
      reservedMinor: wallet.reservedMinor + amountMinor,
      updatedAt: new Date(),
    }).where(eq(airtimeWalletsTable.id, wallet.id));
    return { row, created: true };
  });
  if (!reservation.created) return reservation.row;

  let submission;
  try {
    submission = await submitStatumAirtime({ phoneNumber, amountKes: input.amountKes });
  } catch (error) {
    return (await updatePurchase(reservation.row.reference, {
      status: "unknown",
      resultDescription: error instanceof Error
        ? `Statum could not confirm whether the request was accepted: ${error.message}`.slice(0, 500)
        : "Statum could not confirm whether the request was accepted.",
    })) ?? reservation.row;
  }
  if (submission.kind === "rejected") {
    return (await releasePurchase(reservation.row.reference, submission.reason)) ?? reservation.row;
  }
  if (submission.kind === "unknown") {
    return (await updatePurchase(reservation.row.reference, {
      status: "unknown",
      resultDescription: submission.reason.slice(0, 500),
    })) ?? reservation.row;
  }

  const [updated] = await db.update(airtimePurchasesTable).set({
    providerRequestId: submission.requestId,
    status: "pending",
    updatedAt: new Date(),
  }).where(and(
    eq(airtimePurchasesTable.reference, reservation.row.reference),
    eq(airtimePurchasesTable.status, "submitting"),
  )).returning();
  if (!updated) {
    const [current] = await db.select().from(airtimePurchasesTable)
      .where(eq(airtimePurchasesTable.reference, reservation.row.reference)).limit(1);
    if (!current) return reservation.row;
  }
  await processPendingStatumCallbacks(submission.requestId);
  const [latest] = await db.select().from(airtimePurchasesTable)
    .where(eq(airtimePurchasesTable.reference, reservation.row.reference)).limit(1);
  return latest ?? updated ?? reservation.row;
}

async function updatePurchase(reference: string, changes: Partial<typeof airtimePurchasesTable.$inferInsert>) {
  const [row] = await db.update(airtimePurchasesTable).set({
    ...changes,
    updatedAt: new Date(),
  }).where(and(
    eq(airtimePurchasesTable.reference, reference),
    eq(airtimePurchasesTable.status, "submitting"),
  )).returning();
  if (row) return row;
  const [current] = await db.select().from(airtimePurchasesTable)
    .where(eq(airtimePurchasesTable.reference, reference)).limit(1);
  return current;
}

async function releasePurchase(reference: string, reason: string) {
  return db.transaction(async (tx) => {
    const [purchase] = await tx.select().from(airtimePurchasesTable)
      .where(eq(airtimePurchasesTable.reference, reference)).for("update").limit(1);
    if (!purchase || TERMINAL_STATUSES.has(purchase.status)) return purchase;
    const wallet = await lockWallet(tx, purchase.merchantId);
    if (wallet.reservedMinor < purchase.amountMinor) {
      throw new ApiError(500, "The airtime reservation is inconsistent; no automatic balance change was made.");
    }
    const [entry] = await tx.insert(airtimeWalletEntriesTable).values({
      merchantId: purchase.merchantId,
      reference,
      kind: "airtime_purchase_release",
      idempotencyKey: `purchase:settle:${reference}`,
      requestHash: fingerprint({ kind: "release", reference, amount: purchase.amountMinor.toString() }),
      availableDeltaMinor: purchase.amountMinor,
      reservedDeltaMinor: -purchase.amountMinor,
      metadata: { reason: reason.slice(0, 500) },
    }).onConflictDoNothing().returning();
    if (entry) {
      await tx.update(airtimeWalletsTable).set({
        availableMinor: wallet.availableMinor + purchase.amountMinor,
        reservedMinor: wallet.reservedMinor - purchase.amountMinor,
        updatedAt: new Date(),
      }).where(eq(airtimeWalletsTable.id, wallet.id));
    }
    const [updated] = await tx.update(airtimePurchasesTable).set({
      status: "failed",
      chargeMinor: 0n,
      resultDescription: reason.slice(0, 500),
      updatedAt: new Date(),
    }).where(eq(airtimePurchasesTable.id, purchase.id)).returning();
    return updated;
  });
}

export async function recordStatumCallback(input: {
  deliveryHash: string;
  callback: AirtimeCallback;
}): Promise<"duplicate" | "waiting" | "processed" | "review"> {
  const chargeMinor = parseKesMinor(input.callback.charge);
  const balanceMinor = input.callback.account_balance === undefined
    ? null
    : parseKesMinor(input.callback.account_balance) ?? null;
  const resultCode = Number(input.callback.result_code);
  if (chargeMinor === undefined || !Number.isSafeInteger(resultCode)) {
    throw new ApiError(400, "Statum callback charge or result code is invalid.");
  }
  const [row] = await db.insert(airtimeStatumCallbacksTable).values({
    deliveryHash: input.deliveryHash,
    providerRequestId: input.callback.request_id,
    chargeMinor,
    accountBalanceMinor: balanceMinor,
    resultCode,
    resultDescription: input.callback.result_desc.slice(0, 500),
  }).onConflictDoNothing().returning();
  if (!row) return "duplicate";
  return applyStatumCallback(row.id);
}

async function applyStatumCallback(callbackId: number): Promise<"waiting" | "processed" | "review"> {
  return db.transaction(async (tx) => {
    const [callback] = await tx.select().from(airtimeStatumCallbacksTable)
      .where(eq(airtimeStatumCallbacksTable.id, callbackId)).for("update").limit(1);
    if (!callback) return "waiting";
    if (callback.processedAt) return "processed";
    const [purchase] = await tx.select().from(airtimePurchasesTable)
      .where(eq(airtimePurchasesTable.providerRequestId, callback.providerRequestId))
      .for("update").limit(1);
    if (!purchase) return "waiting";
    if (TERMINAL_STATUSES.has(purchase.status)) {
      await tx.update(airtimeStatumCallbacksTable).set({
        purchaseReference: purchase.reference,
        processedAt: new Date(),
      }).where(eq(airtimeStatumCallbacksTable.id, callback.id));
      return "processed";
    }
    const wallet = await lockWallet(tx, purchase.merchantId);
    if (wallet.reservedMinor < purchase.amountMinor) {
      throw new ApiError(500, "The airtime purchase reservation is inconsistent; the Statum result needs review.");
    }

    const success = callback.resultCode === 200;
    const invalidCharge = callback.chargeMinor <= 0n || callback.chargeMinor > purchase.amountMinor;
    if (!success || invalidCharge) {
      await tx.update(airtimePurchasesTable).set({
        status: "unknown",
        resultCode: callback.resultCode,
        resultDescription: !success
          ? "Statum returned a non-success result code. Its failure semantics have not been verified, so funds remain reserved for review."
          : "Statum returned a charge that cannot be reconciled to the reserved KES amount; funds remain reserved for review.",
        lastCallbackAt: callback.receivedAt,
        updatedAt: new Date(),
      }).where(eq(airtimePurchasesTable.id, purchase.id));
      await tx.update(airtimeStatumCallbacksTable).set({
        purchaseReference: purchase.reference,
        processedAt: new Date(),
      }).where(eq(airtimeStatumCallbacksTable.id, callback.id));
      return "review";
    }

    const chargedMinor = callback.chargeMinor;
    const refundMinor = purchase.amountMinor - chargedMinor;
    const [entry] = await tx.insert(airtimeWalletEntriesTable).values({
      merchantId: purchase.merchantId,
      reference: purchase.reference,
      kind: success ? "airtime_purchase_settlement" : "airtime_purchase_release",
      idempotencyKey: `purchase:settle:${purchase.reference}`,
      requestHash: fingerprint({
        kind: success ? "settlement" : "release",
        reference: purchase.reference,
        charge: chargedMinor.toString(),
        resultCode: callback.resultCode,
      }),
      availableDeltaMinor: refundMinor,
      reservedDeltaMinor: -purchase.amountMinor,
      metadata: {
        provider: "statum",
        providerRequestId: callback.providerRequestId,
        chargeMinor: chargedMinor.toString(),
        resultCode: callback.resultCode,
      },
    }).onConflictDoNothing().returning();
    if (entry) {
      await tx.update(airtimeWalletsTable).set({
        availableMinor: wallet.availableMinor + refundMinor,
        reservedMinor: wallet.reservedMinor - purchase.amountMinor,
        updatedAt: new Date(),
      }).where(eq(airtimeWalletsTable.id, wallet.id));
    }
    await tx.update(airtimePurchasesTable).set({
      status: success ? "succeeded" : "failed",
      chargeMinor: chargedMinor,
      resultCode: callback.resultCode,
      resultDescription: callback.resultDescription.slice(0, 500),
      lastCallbackAt: callback.receivedAt,
      updatedAt: new Date(),
    }).where(eq(airtimePurchasesTable.id, purchase.id));
    await tx.update(airtimeStatumCallbacksTable).set({
      purchaseReference: purchase.reference,
      processedAt: new Date(),
    }).where(eq(airtimeStatumCallbacksTable.id, callback.id));
    return "processed";
  });
}

export async function processPendingStatumCallbacks(providerRequestId: string): Promise<void> {
  const callbacks = await db.select({ id: airtimeStatumCallbacksTable.id })
    .from(airtimeStatumCallbacksTable).where(and(
      eq(airtimeStatumCallbacksTable.providerRequestId, providerRequestId),
      isNull(airtimeStatumCallbacksTable.processedAt),
    )).orderBy(asc(airtimeStatumCallbacksTable.receivedAt)).limit(20);
  for (const callback of callbacks) await applyStatumCallback(callback.id);
}

export async function markStaleAirtimeSubmissionsUnknown(): Promise<void> {
  const cutoff = new Date(Date.now() - 2 * 60_000);
  await db.update(airtimePurchasesTable).set({
    status: "unknown",
    resultDescription: "Statum's request outcome could not be confirmed. The reserved balance was retained to prevent a duplicate purchase.",
    updatedAt: new Date(),
  }).where(and(
    eq(airtimePurchasesTable.status, "submitting"),
    lt(airtimePurchasesTable.createdAt, cutoff),
  ));
}

export async function reconcilePendingAirtimeTopups(limit = 30): Promise<void> {
  const cutoff = new Date(Date.now() - 25_000);
  const candidates = await db.select({ reference: airtimeTopupsTable.reference })
    .from(airtimeTopupsTable).where(and(
      inArray(airtimeTopupsTable.status, ["pending", "unknown"]),
      or(isNull(airtimeTopupsTable.lastCheckedAt), lt(airtimeTopupsTable.lastCheckedAt, cutoff)),
    )).orderBy(asc(airtimeTopupsTable.createdAt)).limit(limit);
  for (const candidate of candidates) {
    const [claimed] = await db.update(airtimeTopupsTable).set({
      lastCheckedAt: new Date(),
      updatedAt: new Date(),
    }).where(and(
      eq(airtimeTopupsTable.reference, candidate.reference),
      inArray(airtimeTopupsTable.status, ["pending", "unknown"]),
      or(isNull(airtimeTopupsTable.lastCheckedAt), lt(airtimeTopupsTable.lastCheckedAt, cutoff)),
    )).returning({ reference: airtimeTopupsTable.reference });
    if (!claimed) continue;
    try {
      await reconcileAirtimeTopup(candidate.reference);
    } catch (error) {
      await recordAirtimeTopupReconciliationFailure(candidate.reference, error);
    }
  }
  const staleCutoff = new Date(Date.now() - 2 * 60_000);
  await db.update(airtimeTopupsTable).set({
    status: "unknown",
    lastError: "PayHero initiation was interrupted before its outcome could be saved. Greenpay is checking the local reference and will not send another prompt.",
    updatedAt: new Date(),
  }).where(and(
    eq(airtimeTopupsTable.status, "initiating"),
    lt(airtimeTopupsTable.createdAt, staleCutoff),
  ));
  await markStaleAirtimeSubmissionsUnknown();
}

export async function getMerchantAirtimeStatus(merchantId: number) {
  const [merchant] = await db.select({ status: merchantsTable.status })
    .from(merchantsTable).where(eq(merchantsTable.id, merchantId)).limit(1);
  if (!merchant) throw new ApiError(404, "Merchant account not found.");
  return merchant.status;
}

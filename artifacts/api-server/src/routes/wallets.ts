import { getAuth } from "@clerk/express";
import { Router, type IRouter } from "express";
import {
  ApprovePayoutRequestParams,
  ConfirmWalletSettlementBody, ConfirmWalletSettlementResponse,
  ConvertMerchantWalletFundsBody, ConvertMerchantWalletFundsHeader, ConvertMerchantWalletFundsResponse,
  CreateMerchantPayoutRequestHeader,
  GetMerchantWalletFxQuoteQueryParams, GetMerchantWalletFxQuoteResponse,
  ListAdminPayoutRequestsQueryParams, ListAdminWalletsResponse,
  ListMerchantWalletLedgerQueryParams, ListMerchantWalletLedgerResponse,
  ListMerchantWalletPayoutMethodsQueryParams, ListMerchantWalletPayoutMethodsResponse,
  ListMerchantWalletsResponse, ReconcilePayoutRequestParams, ReconcilePayoutRequestResponse,
  RejectPayoutRequestBody, RejectPayoutRequestParams, RejectPayoutRequestResponse,
} from "@workspace/api-zod";
import {
  approveAndSubmitMerchantPayout, confirmWalletSettlement, convertWalletFunds,
  approveWalletPayoutDestinationChange, createMerchantWalletPayoutDestinationChange,
  createWalletPayoutRequest, listAdminPayoutRequests, listAdminWalletPayoutDestinationChanges, listAdminWallets,
  listMerchantWalletPayoutDestinations, listMerchantWalletPayoutDestinationChanges,
  listMerchantPayoutRequests, listMerchantWallets, listWalletLedger,
  quoteWalletConversion, reconcileMerchantPayoutRequest, rejectMerchantPayoutRequest,
  rejectWalletPayoutDestinationChange,
  walletPayoutMethods,
} from "../lib/wallet-service";
import { resolveMerchantAccess } from "../lib/merchant-access";
import { requireSignedIn } from "../middlewares/requireAdmin";

export const merchantWalletRouter: IRouter = Router();
export const adminWalletRouter: IRouter = Router();

function destinationChangeInput(body: unknown): {
  destinationId?: number;
  label: string;
  currency: string;
  method: string;
  accountName: string;
  accountNumber: string;
  bankCode?: string;
  bankName?: string;
} | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const value = body as Record<string, unknown>;
  const text = (key: string, max: number, optional = false) => {
    const field = value[key];
    if (optional && field === undefined) return undefined;
    return typeof field === "string" && field.trim().length > 0 && field.length <= max ? field.trim() : null;
  };
  const label = text("label", 120);
  const currency = text("currency", 3);
  const method = text("method", 120);
  const accountName = text("accountName", 200);
  const accountNumber = text("accountNumber", 100);
  const bankCode = text("bankCode", 100, true);
  const bankName = text("bankName", 200, true);
  const destinationId = value.destinationId;
  if (label === null || currency === null || currency?.length !== 3 ||
      method === null || accountName === null || accountNumber === null ||
      bankCode === null || bankName === null ||
      (destinationId !== undefined && (!Number.isInteger(destinationId) || Number(destinationId) < 1))) return null;
  if (!label || !currency || !method || !accountName || !accountNumber) return null;
  return {
    ...(destinationId === undefined ? {} : { destinationId: Number(destinationId) }),
    label, currency, method, accountName, accountNumber,
    ...(bankCode ? { bankCode } : {}),
    ...(bankName ? { bankName } : {}),
  };
}

function payoutRequestInput(body: unknown): {
  amount: number;
  currency: string;
  destinationId?: number;
  method?: string;
  accountName?: string;
  accountNumber?: string;
  bankCode?: string;
  bankName?: string;
} | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const value = body as Record<string, unknown>;
  const amount = value.amount;
  const currency = value.currency;
  const destinationId = value.destinationId;
  if (typeof amount !== "number" || !Number.isFinite(amount) ||
      typeof currency !== "string" || currency.trim().length !== 3 ||
      (destinationId !== undefined && (!Number.isInteger(destinationId) || Number(destinationId) < 1))) return null;
  const optionalText = (key: string, max: number): string | undefined | null => {
    const field = value[key];
    if (field === undefined) return undefined;
    if (typeof field !== "string" || field.trim().length === 0 || field.length > max) return null;
    return field.trim();
  };
  const method = optionalText("method", 120);
  const accountName = optionalText("accountName", 200);
  const accountNumber = optionalText("accountNumber", 100);
  const bankCode = optionalText("bankCode", 100);
  const bankName = optionalText("bankName", 200);
  if ([method, accountName, accountNumber, bankCode, bankName].includes(null)) return null;
  if (destinationId === undefined && (!method || !accountName || !accountNumber)) return null;
  return {
    amount,
    currency: currency.trim(),
    ...(destinationId === undefined ? {} : { destinationId: Number(destinationId) }),
    ...(method ? { method } : {}),
    ...(accountName ? { accountName } : {}),
    ...(accountNumber ? { accountNumber } : {}),
    ...(bankCode ? { bankCode } : {}),
    ...(bankName ? { bankName } : {}),
  };
}

merchantWalletRouter.get("/wallets", requireSignedIn, async (req, res): Promise<void> => {
  const merchant = await resolveMerchantAccess(req, res, "read");
  if (!merchant) { res.status(404).json({ error: "Merchant account not found." }); return; }
  const items = await listMerchantWallets(merchant.id);
  res.json(ListMerchantWalletsResponse.parse({ items }));
});

merchantWalletRouter.get("/wallets/ledger", requireSignedIn, async (req, res): Promise<void> => {
  const query = ListMerchantWalletLedgerQueryParams.safeParse(req.query);
  if (!query.success) { res.status(400).json({ error: query.error.message }); return; }
  const merchant = await resolveMerchantAccess(req, res, "read");
  if (!merchant) { res.status(404).json({ error: "Merchant account not found." }); return; }
  const items = await listWalletLedger(merchant.id, query.data.currency);
  res.json(ListMerchantWalletLedgerResponse.parse({ items }));
});

merchantWalletRouter.get("/wallets/fx-quote", requireSignedIn, async (req, res): Promise<void> => {
  const query = GetMerchantWalletFxQuoteQueryParams.safeParse(req.query);
  if (!query.success) { res.status(400).json({ error: query.error.message }); return; }
  const merchant = await resolveMerchantAccess(req, res, "finance");
  if (!merchant) { res.status(404).json({ error: "Merchant account not found." }); return; }
  const quote = await quoteWalletConversion(merchant.id, {
    amount: query.data.amount,
    fromCurrency: query.data.from,
    toCurrency: query.data.to,
  });
  res.json(GetMerchantWalletFxQuoteResponse.parse(quote));
});

merchantWalletRouter.post("/wallets/conversions", requireSignedIn, async (req, res): Promise<void> => {
  const header = ConvertMerchantWalletFundsHeader.safeParse({
    "Idempotency-Key": req.get("Idempotency-Key"),
  });
  const body = ConvertMerchantWalletFundsBody.safeParse(req.body);
  if (!header.success || !body.success) {
    res.status(400).json({ error: !header.success ? header.error.message : body.error?.message ?? "Invalid wallet conversion." });
    return;
  }
  const merchant = await resolveMerchantAccess(req, res, "finance");
  if (!merchant) { res.status(404).json({ error: "Merchant account not found." }); return; }
  const result = await convertWalletFunds(merchant.id, {
    ...body.data,
    idempotencyKey: header.data["Idempotency-Key"],
  });
  res.status(201).json(ConvertMerchantWalletFundsResponse.parse(result));
});

merchantWalletRouter.get("/wallets/payout-methods", requireSignedIn, async (req, res): Promise<void> => {
  const query = ListMerchantWalletPayoutMethodsQueryParams.safeParse(req.query);
  if (!query.success) { res.status(400).json({ error: query.error.message }); return; }
  const merchant = await resolveMerchantAccess(req, res, "read");
  if (!merchant) { res.status(404).json({ error: "Merchant account not found." }); return; }
  const result = await walletPayoutMethods(query.data.currency);
  res.json(ListMerchantWalletPayoutMethodsResponse.parse(result));
});

merchantWalletRouter.get("/wallets/payout-requests", requireSignedIn, async (req, res): Promise<void> => {
  const merchant = await resolveMerchantAccess(req, res, "read");
  if (!merchant) { res.status(404).json({ error: "Merchant account not found." }); return; }
  const items = await listMerchantPayoutRequests(merchant.id);
  res.json({ items });
});

merchantWalletRouter.get("/wallets/payout-destinations", requireSignedIn, async (req, res): Promise<void> => {
  const merchant = await resolveMerchantAccess(req, res, "read");
  if (!merchant) { res.status(404).json({ error: "Merchant account not found." }); return; }
  res.json({ items: await listMerchantWalletPayoutDestinations(merchant.id) });
});

merchantWalletRouter.get("/wallets/payout-destination-changes", requireSignedIn, async (req, res): Promise<void> => {
  const merchant = await resolveMerchantAccess(req, res, "read");
  if (!merchant) { res.status(404).json({ error: "Merchant account not found." }); return; }
  res.json({ items: await listMerchantWalletPayoutDestinationChanges(merchant.id) });
});

merchantWalletRouter.post("/wallets/payout-destinations", requireSignedIn, async (req, res): Promise<void> => {
  const parsed = destinationChangeInput(req.body);
  if (!parsed) {
    res.status(400).json({ error: "Enter a valid saved payout destination." });
    return;
  }
  const merchant = await resolveMerchantAccess(req, res, "finance");
  if (!merchant) { res.status(404).json({ error: "Merchant account not found." }); return; }
  const idempotencyKey = req.get("Idempotency-Key");
  if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 128) {
    res.status(400).json({ error: "A valid Idempotency-Key header is required." });
    return;
  }
  const item = await createMerchantWalletPayoutDestinationChange(merchant, {
    ...parsed,
    idempotencyKey,
    requester: getAuth(req).userId ?? "unknown-merchant",
  });
  res.status(201).json(item);
});

merchantWalletRouter.post("/wallets/payout-requests", requireSignedIn, async (req, res): Promise<void> => {
  const header = CreateMerchantPayoutRequestHeader.safeParse({
    "Idempotency-Key": req.get("Idempotency-Key"),
  });
  const body = payoutRequestInput(req.body);
  if (!header.success || !body) {
    res.status(400).json({ error: !header.success ? header.error.message : "Enter a valid payout amount and approved destination." });
    return;
  }
  const merchant = await resolveMerchantAccess(req, res, "finance");
  if (!merchant) { res.status(404).json({ error: "Merchant account not found." }); return; }
  const item = await createWalletPayoutRequest(merchant, {
    ...body,
    idempotencyKey: header.data["Idempotency-Key"],
    requester: getAuth(req).userId ?? "unknown-merchant",
  });
  res.status(201).json(item);
});

adminWalletRouter.get("/admin/wallets", async (_req, res): Promise<void> => {
  res.json(ListAdminWalletsResponse.parse({ items: await listAdminWallets() }));
});

adminWalletRouter.post("/admin/wallets/settlements/confirm", async (req, res): Promise<void> => {
  const body = ConfirmWalletSettlementBody.safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: body.error.message }); return; }
  const result = await confirmWalletSettlement({
    ...body.data,
    actor: getAuth(req).userId ?? "unknown-admin",
  });
  res.status(201).json(ConfirmWalletSettlementResponse.parse(result));
});

adminWalletRouter.get("/admin/payout-requests", async (req, res): Promise<void> => {
  const query = ListAdminPayoutRequestsQueryParams.safeParse(req.query);
  if (!query.success) { res.status(400).json({ error: query.error.message }); return; }
  const items = await listAdminPayoutRequests(query.data.status);
  res.json({ items });
});

adminWalletRouter.get("/admin/payout-destination-changes", async (req, res): Promise<void> => {
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  res.json({ items: await listAdminWalletPayoutDestinationChanges(status) });
});

adminWalletRouter.post("/admin/payout-destination-changes/:id/approve", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) { res.status(400).json({ error: "Invalid destination change ID." }); return; }
  const fingerprint = req.body && typeof req.body === "object" &&
    typeof (req.body as Record<string, unknown>).destinationFingerprint === "string"
    ? (req.body as Record<string, string>).destinationFingerprint
    : undefined;
  const item = await approveWalletPayoutDestinationChange(
    id, getAuth(req).userId ?? "unknown-admin", fingerprint,
  );
  res.json(item);
});

adminWalletRouter.post("/admin/payout-destination-changes/:id/reject", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const reason = req.body && typeof req.body === "object" &&
    typeof (req.body as Record<string, unknown>).reason === "string"
    ? (req.body as Record<string, string>).reason
    : "";
  if (!Number.isInteger(id) || id < 1 || !reason.trim()) {
    res.status(400).json({ error: "Enter a destination change ID and rejection reason." });
    return;
  }
  const item = await rejectWalletPayoutDestinationChange(
    id, getAuth(req).userId ?? "unknown-admin", reason,
  );
  res.json(item);
});

adminWalletRouter.post("/admin/payout-requests/:id/approve", async (req, res): Promise<void> => {
  const params = ApprovePayoutRequestParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const fingerprint = req.body && typeof req.body === "object" &&
    typeof (req.body as Record<string, unknown>).destinationFingerprint === "string"
    ? (req.body as Record<string, string>).destinationFingerprint
    : undefined;
  const item = await approveAndSubmitMerchantPayout(
    params.data.id, getAuth(req).userId ?? "unknown-admin", fingerprint,
  );
  res.json(item);
});

adminWalletRouter.post("/admin/payout-requests/:id/reject", async (req, res): Promise<void> => {
  const params = RejectPayoutRequestParams.safeParse(req.params);
  const body = RejectPayoutRequestBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: !params.success ? params.error.message : body.error?.message ?? "Invalid payout decision." });
    return;
  }
  const item = await rejectMerchantPayoutRequest(
    params.data.id, getAuth(req).userId ?? "unknown-admin", body.data.reason,
  );
  res.json(RejectPayoutRequestResponse.parse(item));
});

adminWalletRouter.post("/admin/payout-requests/:id/reconcile", async (req, res): Promise<void> => {
  const params = ReconcilePayoutRequestParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const item = await reconcileMerchantPayoutRequest(params.data.id);
  res.json(ReconcilePayoutRequestResponse.parse(item));
});
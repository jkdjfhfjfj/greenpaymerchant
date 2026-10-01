import { getAuth } from "@clerk/express";
import { Router, type IRouter } from "express";
import {
  ApprovePayoutRequestParams, ApprovePayoutRequestResponse,
  ConfirmWalletSettlementBody, ConfirmWalletSettlementResponse,
  ConvertMerchantWalletFundsBody, ConvertMerchantWalletFundsHeader, ConvertMerchantWalletFundsResponse,
  CreateMerchantPayoutRequestBody, CreateMerchantPayoutRequestHeader, CreateMerchantPayoutRequestResponse,
  GetMerchantWalletFxQuoteQueryParams, GetMerchantWalletFxQuoteResponse,
  ListAdminPayoutRequestsQueryParams, ListAdminPayoutRequestsResponse, ListAdminWalletsResponse,
  ListMerchantPayoutRequestsResponse, ListMerchantWalletLedgerQueryParams, ListMerchantWalletLedgerResponse,
  ListMerchantWalletPayoutMethodsQueryParams, ListMerchantWalletPayoutMethodsResponse,
  ListMerchantWalletsResponse, ReconcilePayoutRequestParams, ReconcilePayoutRequestResponse,
  RejectPayoutRequestBody, RejectPayoutRequestParams, RejectPayoutRequestResponse,
} from "@workspace/api-zod";
import {
  approveAndSubmitMerchantPayout, confirmWalletSettlement, convertWalletFunds,
  createWalletPayoutRequest, listAdminPayoutRequests, listAdminWallets,
  listMerchantPayoutRequests, listMerchantWallets, listWalletLedger,
  quoteWalletConversion, reconcileMerchantPayoutRequest, rejectMerchantPayoutRequest,
  walletPayoutMethods,
} from "../lib/wallet-service";
import { resolveMerchantAccess } from "../lib/merchant-access";
import { requireSignedIn } from "../middlewares/requireAdmin";

export const merchantWalletRouter: IRouter = Router();
export const adminWalletRouter: IRouter = Router();

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
  res.json(ListMerchantPayoutRequestsResponse.parse({ items }));
});

merchantWalletRouter.post("/wallets/payout-requests", requireSignedIn, async (req, res): Promise<void> => {
  const header = CreateMerchantPayoutRequestHeader.safeParse({
    "Idempotency-Key": req.get("Idempotency-Key"),
  });
  const body = CreateMerchantPayoutRequestBody.safeParse(req.body);
  if (!header.success || !body.success) {
    res.status(400).json({ error: !header.success ? header.error.message : body.error?.message ?? "Invalid wallet payout request." });
    return;
  }
  const merchant = await resolveMerchantAccess(req, res, "finance");
  if (!merchant) { res.status(404).json({ error: "Merchant account not found." }); return; }
  const item = await createWalletPayoutRequest(merchant, {
    ...body.data,
    idempotencyKey: header.data["Idempotency-Key"],
  });
  res.status(201).json(CreateMerchantPayoutRequestResponse.parse(item));
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
  res.json(ListAdminPayoutRequestsResponse.parse({ items }));
});

adminWalletRouter.post("/admin/payout-requests/:id/approve", async (req, res): Promise<void> => {
  const params = ApprovePayoutRequestParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const item = await approveAndSubmitMerchantPayout(params.data.id, getAuth(req).userId ?? "unknown-admin");
  res.json(ApprovePayoutRequestResponse.parse(item));
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
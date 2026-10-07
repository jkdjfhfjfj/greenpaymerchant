import { Router, type IRouter } from "express";
import {
  CreateDeveloperAirtimePurchaseBody, CreateDeveloperAirtimePurchaseHeader,
  CreateDeveloperAirtimePurchaseResponse, CreateMerchantAirtimePurchaseBody,
  CreateMerchantAirtimePurchaseHeader, CreateMerchantAirtimePurchaseResponse,
  CreateMerchantAirtimeTopupBody, CreateMerchantAirtimeTopupHeader,
  CreateMerchantAirtimeTopupResponse, GetDeveloperAirtimePurchaseParams,
  GetDeveloperAirtimePurchaseResponse, GetDeveloperAirtimeWalletResponse,
  GetMerchantAirtimeDashboardResponse, ListDeveloperAirtimePurchasesResponse,
} from "@workspace/api-zod";
import { db, merchantsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { ApiError } from "../lib/api-error";
import {
  airtimePurchaseDto, airtimeTopupDto, createAirtimePurchase, createAirtimeTopup,
  getAirtimePurchase, getAirtimeWallet, getMerchantAirtimeDashboard, listAirtimePurchases,
} from "../lib/airtime-service";
import { resolveMerchantAccess } from "../lib/merchant-access";
import { developerApiAuth, requireApiKeyEnvironment, requireApiScope } from "../middlewares/developerApiAuth";

const router: IRouter = Router();
const apiRouter: IRouter = Router();

function idempotencyValue(header: string | undefined): string | undefined {
  return header?.trim();
}

async function requireActiveMerchant(merchantId: number): Promise<void> {
  const [merchant] = await db.select({ status: merchantsTable.status })
    .from(merchantsTable).where(eq(merchantsTable.id, merchantId)).limit(1);
  if (!merchant) throw new ApiError(404, "Merchant account not found.");
  if (merchant.status !== "active") throw new ApiError(403, "Airtime is available only to active merchant accounts.");
}

router.get("/merchant/airtime", async (req, res): Promise<void> => {
  res.setHeader("Cache-Control", "no-store");
  const merchant = await resolveMerchantAccess(req, res);
  if (!merchant) {
    res.status(404).json({ error: "Merchant account not found." });
    return;
  }
  res.json(GetMerchantAirtimeDashboardResponse.parse(await getMerchantAirtimeDashboard(merchant.id)));
});

router.post("/merchant/airtime/topups", async (req, res): Promise<void> => {
  res.setHeader("Cache-Control", "no-store");
  const merchant = await resolveMerchantAccess(req, res, "finance");
  if (!merchant) {
    res.status(404).json({ error: "Merchant account not found." });
    return;
  }
  await requireActiveMerchant(merchant.id);
  const header = CreateMerchantAirtimeTopupHeader.safeParse({
    "Idempotency-Key": idempotencyValue(req.get("Idempotency-Key")),
  });
  const body = CreateMerchantAirtimeTopupBody.safeParse(req.body);
  if (!header.success || !body.success) {
    res.status(400).json({ error: !header.success ? header.error.message : body.error?.message ?? "Invalid airtime top-up request." });
    return;
  }
  const topup = await createAirtimeTopup({
    merchantId: merchant.id,
    idempotencyKey: header.data["Idempotency-Key"],
    phoneNumber: body.data.phoneNumber,
    amountKes: body.data.amount,
  });
  res.status(201).json(CreateMerchantAirtimeTopupResponse.parse({ topup: airtimeTopupDto(topup) }));
});

router.post("/merchant/airtime/purchases", async (req, res): Promise<void> => {
  res.setHeader("Cache-Control", "no-store");
  const merchant = await resolveMerchantAccess(req, res, "finance");
  if (!merchant) {
    res.status(404).json({ error: "Merchant account not found." });
    return;
  }
  await requireActiveMerchant(merchant.id);
  const header = CreateMerchantAirtimePurchaseHeader.safeParse({
    "Idempotency-Key": idempotencyValue(req.get("Idempotency-Key")),
  });
  const body = CreateMerchantAirtimePurchaseBody.safeParse(req.body);
  if (!header.success || !body.success) {
    res.status(400).json({ error: !header.success ? header.error.message : body.error?.message ?? "Invalid airtime purchase request." });
    return;
  }
  const purchase = await createAirtimePurchase({
    merchantId: merchant.id,
    idempotencyKey: header.data["Idempotency-Key"],
    phoneNumber: body.data.phoneNumber,
    amountKes: body.data.amount,
  });
  res.status(201).json(CreateMerchantAirtimePurchaseResponse.parse({ purchase: airtimePurchaseDto(purchase) }));
});

apiRouter.use(developerApiAuth, requireApiKeyEnvironment("live"), (_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});

apiRouter.get("/airtime/wallet", requireApiScope("read"), async (_req, res): Promise<void> => {
  const merchant = res.locals.merchant as typeof merchantsTable.$inferSelect;
  res.json(GetDeveloperAirtimeWalletResponse.parse(await getAirtimeWallet(merchant.id)));
});

apiRouter.get("/airtime/purchases", requireApiScope("read"), async (_req, res): Promise<void> => {
  const merchant = res.locals.merchant as typeof merchantsTable.$inferSelect;
  res.json(ListDeveloperAirtimePurchasesResponse.parse(await listAirtimePurchases(merchant.id)));
});

apiRouter.post("/airtime/purchases", requireApiScope("airtime:write"), async (req, res): Promise<void> => {
  const merchant = res.locals.merchant as typeof merchantsTable.$inferSelect;
  const header = CreateDeveloperAirtimePurchaseHeader.safeParse({
    "Idempotency-Key": idempotencyValue(req.get("Idempotency-Key")),
  });
  const body = CreateDeveloperAirtimePurchaseBody.safeParse(req.body);
  if (!header.success || !body.success) {
    res.status(400).json({ error: !header.success ? header.error.message : body.error?.message ?? "Invalid airtime purchase request." });
    return;
  }
  const purchase = await createAirtimePurchase({
    merchantId: merchant.id,
    idempotencyKey: header.data["Idempotency-Key"],
    phoneNumber: body.data.phoneNumber,
    amountKes: body.data.amount,
  });
  res.status(201).json(CreateDeveloperAirtimePurchaseResponse.parse({ purchase: airtimePurchaseDto(purchase) }));
});

apiRouter.get("/airtime/purchases/:reference", requireApiScope("read"), async (req, res): Promise<void> => {
  const params = GetDeveloperAirtimePurchaseParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const merchant = res.locals.merchant as typeof merchantsTable.$inferSelect;
  const purchase = await getAirtimePurchase(merchant.id, params.data.reference);
  if (!purchase) {
    res.status(404).json({ error: "Airtime purchase not found for this merchant." });
    return;
  }
  res.json(GetDeveloperAirtimePurchaseResponse.parse(purchase));
});

router.use("/v1", apiRouter);

export default router;

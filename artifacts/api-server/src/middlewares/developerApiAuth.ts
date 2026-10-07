import { and, eq, isNull } from "drizzle-orm";
import { createHash } from "node:crypto";
import type { RequestHandler } from "express";
import { db, merchantApiKeysTable, merchantsTable } from "@workspace/db";
import { assertMerchantActionEnabled, assertMerchantCapability, assertPlatformEnabled } from "../lib/platform";
import { apiKeyEnvironmentAllowed, hasRequiredScope } from "../lib/security-policy";
import { developerApiStatusAllowed } from "../lib/security-policy";

const requestBuckets = new Map<number, { start: number; count: number }>();
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 120;

export const developerApiAuth: RequestHandler = async (req, res, next) => {
  const auth = req.get("authorization") ?? "";
  const secret = auth.match(/^Bearer\s+(\S+)$/i)?.[1];
  if (!secret) {
    res.status(401).json({ error: "A valid developer API bearer key is required." });
    return;
  }
  const hash = createHash("sha256").update(secret).digest("hex");
  const [key] = await db.select().from(merchantApiKeysTable)
    .where(and(eq(merchantApiKeysTable.secretHash, hash), isNull(merchantApiKeysTable.revokedAt))).limit(1);
  if (!key) {
    res.status(401).json({ error: "A valid developer API bearer key is required." });
    return;
  }
  const now = Date.now();
  const bucket = requestBuckets.get(key.id);
  if (bucket && now - bucket.start < RATE_WINDOW_MS && bucket.count >= RATE_LIMIT) {
    res.setHeader("Retry-After", String(Math.ceil((RATE_WINDOW_MS - (now - bucket.start)) / 1000)));
    res.status(429).json({ error: "Developer API rate limit exceeded." });
    return;
  }
  if (!bucket || now - bucket.start >= RATE_WINDOW_MS) requestBuckets.set(key.id, { start: now, count: 1 });
  else bucket.count += 1;

  const [merchant] = await db.select().from(merchantsTable).where(eq(merchantsTable.id, key.merchantId)).limit(1);
  if (!merchant) {
    res.status(401).json({ error: "The API key's merchant account no longer exists." });
    return;
  }
  if (!developerApiStatusAllowed(merchant.status)) {
    res.status(403).json({ error: `Developer API access is unavailable while the merchant account is ${merchant.status}.` });
    return;
  }
  try {
    await assertPlatformEnabled("apiAccessEnabled");
    await assertMerchantCapability(merchant, "apiAccessEnabled");
    await assertMerchantActionEnabled(merchant.id, "apiAccess");
  } catch (error) {
    const status = typeof error === "object" && error && "statusCode" in error ? Number(error.statusCode) : 403;
    res.status(status).json({ error: error instanceof Error ? error.message : "Developer API access is disabled." });
    return;
  }
  await db.update(merchantApiKeysTable).set({ lastUsedAt: new Date() })
    .where(eq(merchantApiKeysTable.id, key.id));
  res.locals.apiKey = key;
  res.locals.merchant = merchant;
  next();
};

export function requireApiScope(scope: string): RequestHandler {
  return (req, res, next) => {
    const key = res.locals.apiKey as typeof merchantApiKeysTable.$inferSelect | undefined;
    if (!key || !hasRequiredScope(key.scopes, scope)) {
      res.status(403).json({ error: `The API key requires the ${scope} scope.` });
      return;
    }
    next();
  };
}

export function requireApiKeyEnvironment(environment: "live" | "sandbox"): RequestHandler {
  return async (_req, res, next) => {
    const key = res.locals.apiKey as typeof merchantApiKeysTable.$inferSelect | undefined;
    if (!key || !apiKeyEnvironmentAllowed(key.environment, environment)) {
      res.status(403).json({ error: `This API key is not valid for the ${environment} API environment.` });
      return;
    }
    if (environment === "sandbox") {
      try {
        await assertPlatformEnabled("sandboxApiEnabled");
      } catch (error) {
        const status = typeof error === "object" && error && "statusCode" in error ? Number(error.statusCode) : 403;
        res.status(status).json({ error: error instanceof Error ? error.message : "The sandbox API is disabled." });
        return;
      }
    }
    next();
  };
}
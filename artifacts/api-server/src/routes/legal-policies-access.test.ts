import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import express, { type Request } from "express";
import { clerkMiddleware } from "@clerk/express";
import { eq } from "drizzle-orm";
import {
  db,
  legalPoliciesTable,
  legalPolicyAcceptancesTable,
  legalPolicyTypes,
  merchantsTable,
  pool,
} from "@workspace/db";
import apiRouter from "./index";
import { hasAcceptedCurrentLegalPolicyVersions } from "./legal-policies";

after(async () => {
  await pool.end();
});

type AuthHandler = (options?: unknown) => Record<string, unknown>;
type RequestWithAuth = Request & { auth?: AuthHandler };

function legalAccessTestApp(userId: string) {
  const app = express();
  app.use(express.json());
  app.use(clerkMiddleware());
  app.use((req, _res, next) => {
    const request = req as RequestWithAuth;
    const clerkAuth = request.auth;
    if (!clerkAuth) {
      next(new Error("Clerk middleware did not attach an auth handler."));
      return;
    }
    request.auth = Object.assign(
      (options?: unknown) => ({ ...clerkAuth(options), userId }),
      { [Symbol.for("@clerk/express.auth")]: true },
    );
    next();
  });
  app.use(apiRouter);
  app.use((error: unknown, _req: Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: error instanceof Error ? error.message : "Test API error." });
  });
  return app;
}

async function listen(app: express.Express) {
  const server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Legal access test server did not bind to a TCP port.");
  return {
    server,
    request: (path: string, init?: RequestInit) => fetch(`http://127.0.0.1:${address.port}${path}`, init),
  };
}

test("legal acceptance allows the limited dashboard overview but gates other merchant data and actions", async () => {
  const merchantUserId = `legal-access-${randomUUID()}`;
  const adminUserId = `legal-admin-${randomUUID()}`;
  const adminEmail = `legal-admin-${randomUUID()}@example.invalid`;
  const oldFetch = globalThis.fetch;
  const oldAdminEmails = process.env.ADMIN_EMAILS;
  const [merchant] = await db.insert(merchantsTable).values({
    ownerClerkId: merchantUserId,
    businessName: "Legal acceptance test fixture",
    country: "SL",
    baseCurrency: "USD",
    status: "active",
    kycStatus: "approved",
    kybStatus: "approved",
  }).returning();
  if (!merchant) throw new Error("Could not create legal acceptance merchant fixture.");

  process.env.ADMIN_EMAILS = adminEmail;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("https://api.clerk.com/v1/users/")) {
      const userId = decodeURIComponent(url.split("/").at(-1) ?? "");
      const isAdmin = userId === adminUserId;
      const email = isAdmin ? adminEmail : `${userId}@example.invalid`;
      const emailId = isAdmin ? "legal-test-admin-email" : "legal-test-user-email";
      return Response.json({
        id: userId,
        primary_email_address_id: emailId,
        email_addresses: [{
          id: emailId,
          email_address: email,
          verification: { status: "verified" },
        }],
      });
    }
    return oldFetch(input, init);
  }) as typeof fetch;

  let merchantServer: Awaited<ReturnType<typeof listen>>["server"] | undefined;
  let adminServer: Awaited<ReturnType<typeof listen>>["server"] | undefined;
  try {
    const merchantStarted = await listen(legalAccessTestApp(merchantUserId));
    merchantServer = merchantStarted.server;
    const adminStarted = await listen(legalAccessTestApp(adminUserId));
    adminServer = adminStarted.server;

    const publicPoliciesResponse = await merchantStarted.request("/public/legal-policies");
    assert.equal(publicPoliciesResponse.status, 200, "public policy documents must remain readable");
    const publicPolicies = await publicPoliciesResponse.json() as {
      items: Array<{ policyType: string; published: boolean; content: string | null }>;
    };
    assert.equal(publicPolicies.items.length, legalPolicyTypes.length);
    for (const policy of publicPolicies.items) {
      if (!policy.published) assert.equal(policy.content, null, "unpublished policies must not expose generated copy");
    }

    const consentResponse = await merchantStarted.request("/merchant/legal-consent");
    assert.equal(consentResponse.status, 200, "users must be able to reach the consent screen before accepting");
    const consent = await consentResponse.json() as {
      ready: boolean;
      accepted: boolean;
      policies: Array<{ policyType: "privacy_policy" | "terms_of_service"; version: number; published: boolean }>;
    };
    assert.equal(consent.accepted, false);

    const dashboardTransactions = await merchantStarted.request("/merchant/transactions?page=1&perPage=20");
    assert.equal(dashboardTransactions.status, 200, "the dashboard may read only its first 20 transactions");
    const laterTransactions = await merchantStarted.request("/merchant/transactions?page=2&perPage=20");
    assert.equal(laterTransactions.status, 428, "deeper transaction history remains gated");
    const fullPaymentLinks = await merchantStarted.request("/merchant/payment-links");
    assert.equal(fullPaymentLinks.status, 428, "the full payment-link list remains gated");
    const dashboardLinks = await merchantStarted.request("/merchant/payment-links?overview=true");
    assert.equal(dashboardLinks.status, 200, "the dashboard may read a limited link overview");
    const dashboardLinkData = await dashboardLinks.json() as { items: unknown[]; activeCount: number };
    assert.equal(dashboardLinkData.items.length, 0);
    assert.equal(dashboardLinkData.activeCount, 0);
    const createPaymentLink = await merchantStarted.request("/merchant/payment-links?overview=true", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(createPaymentLink.status, 428, "merchant actions remain gated even on dashboard routes");
    const payoutsResponse = await merchantStarted.request("/merchant/payouts");
    assert.equal(payoutsResponse.status, 428, "other merchant data remains gated");
    const workspaceResponse = await merchantStarted.request("/me/workspace", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId: merchant.id }),
    });
    assert.equal(workspaceResponse.status, 428, "workspace switching must be blocked without current acceptances");

    const adminSettingsResponse = await adminStarted.request("/admin/platform-settings");
    assert.equal(adminSettingsResponse.status, 200, "admins must reach operations before legal policies are published or accepted");

    const adminResponse = await adminStarted.request("/admin/legal-policies");
    assert.equal(adminResponse.status, 200, "admins must be able to open policy administration before setup is complete");
    const adminPolicies = await adminResponse.json() as {
      items: Array<{
        policyType: string;
        publishedVersion: number;
        draftContent: string;
        publishedContent: string | null;
      }>;
    };
    assert.equal(adminPolicies.items.length, legalPolicyTypes.length);
    for (const policy of adminPolicies.items) {
      if (policy.publishedVersion === 0) {
        assert.equal(policy.draftContent, "", "the app must not generate legal wording for an initial draft");
        assert.equal(policy.publishedContent, null);
      }
    }

    if (consent.ready && consent.policies.every((policy) => policy.published)) {
      const exactAcceptances = consent.policies.map(({ policyType, version }) => ({ policyType, version }));
      const stalePolicy = consent.policies.find((policy) => policy.version > 1);
      if (stalePolicy) {
        const staleAcceptances = exactAcceptances.map((item) => item.policyType === stalePolicy.policyType
          ? { ...item, version: item.version - 1 }
          : item);
        const staleResponse = await merchantStarted.request("/merchant/legal-consent", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ acceptances: staleAcceptances }),
        });
        assert.equal(staleResponse.status, 409, "an old policy version must not be accepted as current");
      }

      const acceptedResponse = await merchantStarted.request("/merchant/legal-consent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ acceptances: exactAcceptances }),
      });
      assert.equal(acceptedResponse.status, 200, "users must be able to accept the exact published versions");
      assert.equal((await (await merchantStarted.request("/merchant/transactions")).json() as { total: number }).total, 0);
      assert.equal((await merchantStarted.request("/me/workspace", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId: merchant.id }),
      })).status, 200, "both current acceptances must unlock workspace switching");
    }
  } finally {
    globalThis.fetch = oldFetch;
    if (oldAdminEmails === undefined) delete process.env.ADMIN_EMAILS;
    else process.env.ADMIN_EMAILS = oldAdminEmails;
    if (merchantServer) {
      await new Promise<void>((resolve, reject) => {
        merchantServer!.close((error) => error ? reject(error) : resolve());
      });
    }
    if (adminServer) {
      await new Promise<void>((resolve, reject) => {
        adminServer!.close((error) => error ? reject(error) : resolve());
      });
    }
    await db.delete(legalPolicyAcceptancesTable).where(eq(legalPolicyAcceptancesTable.clerkUserId, merchantUserId));
    await db.delete(merchantsTable).where(eq(merchantsTable.id, merchant.id));
  }
});

test("only acceptance of both exact current policy versions opens workspace access", () => {
  const current = [
    { policyType: "privacy_policy" as const, publishedVersion: 3 },
    { policyType: "terms_of_service" as const, publishedVersion: 2 },
  ];
  assert.equal(hasAcceptedCurrentLegalPolicyVersions(current, [
    { policyType: "privacy_policy", version: 3 },
    { policyType: "terms_of_service", version: 2 },
  ]), true);
  assert.equal(hasAcceptedCurrentLegalPolicyVersions(current, [
    { policyType: "privacy_policy", version: 2 },
    { policyType: "terms_of_service", version: 2 },
  ]), false, "publishing a new Privacy Policy version must invalidate its older acceptance");
  assert.equal(hasAcceptedCurrentLegalPolicyVersions(current, [
    { policyType: "privacy_policy", version: 3 },
  ]), false, "missing acceptance of either policy must keep access blocked");
  assert.equal(hasAcceptedCurrentLegalPolicyVersions([
    ...current,
    { policyType: "privacy_policy" as const, publishedVersion: 4 },
  ], [
    { policyType: "privacy_policy", version: 4 },
    { policyType: "terms_of_service", version: 2 },
  ]), false, "duplicate policy rows must not satisfy the two-policy requirement");
});

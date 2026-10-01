import assert from "node:assert/strict";
import { test } from "node:test";
import { activityAction, safeRoutePattern, shouldAuditActivity } from "./activity-audit";

test("activity audit skips health, auth SDK, polling, and audit-log reads", () => {
  for (const route of [
    "/api/healthz",
    "/api/__clerk/v1/client",
  ]) {
    assert.equal(shouldAuditActivity("GET", route), false, route);
  }
  for (const route of [
    "/api/admin/audit-log",
    "/api/dashboard",
    "/api/providers/status",
    "/api/merchant/wallets",
    "/api/merchant/wallets/ledger",
    "/api/admin/payout-requests",
    "/api/settlements",
    "/api/notifications",
    "/api/merchant/kyc",
    "/api/me",
    "/api/platform-status",
    "/api/public/transactions/:reference",
  ]) {
    assert.equal(shouldAuditActivity("GET", route), false, route);
  }
  assert.equal(shouldAuditActivity("OPTIONS", "/api/merchant/payment-links"), false);
  assert.equal(shouldAuditActivity("POST", "/api/merchant/kyc"), true);
});

test("activity audit retains meaningful user and API reads and mutations", () => {
  assert.equal(shouldAuditActivity("GET", "/api/merchant/transactions"), true);
  assert.equal(shouldAuditActivity("GET", "/merchant/transactions"), true);
  assert.equal(shouldAuditActivity("POST", "/api/v1/transactions"), true);
  assert.equal(shouldAuditActivity("PATCH", "/api/admin/merchants/:id"), true);
  assert.equal(shouldAuditActivity("DELETE", "/api/merchant/api-keys/:id"), true);
});

test("audit route uses Express route patterns and never stores query strings or destination values", () => {
  assert.equal(safeRoutePattern("/api", "/transactions/:reference"), "/api/transactions/:reference");
  const mountedRoute = safeRoutePattern("/api", "/merchant/transactions");
  assert.equal(mountedRoute, "/api/merchant/transactions");
  assert.equal(shouldAuditActivity("GET", mountedRoute!), true);
  assert.equal(safeRoutePattern("/api", "/webhook-endpoints/:id"), "/api/webhook-endpoints/:id");
  assert.equal(safeRoutePattern("/api", "/transactions?token=secret"), null);
  assert.equal(safeRoutePattern("/api", ["/transactions", "/payment-links"]), null);
  assert.equal(safeRoutePattern("", "https://private-destination.invalid"), null);
});

test("audit actions include the operation and HTTP intent without recording dynamic identifiers", () => {
  assert.equal(activityAction("user", "POST", "/api/merchant/payment-links"), "user.create.api.merchant.payment.links");
  assert.equal(activityAction("api", "GET", "/api/v1/transactions/:reference"), "api.read.api.v1.transactions.param");
  assert.equal(activityAction("user", "PATCH", "/api/admin/merchants/:id"), "user.update.api.admin.merchants.param");
  assert.equal(activityAction("user", "DELETE", "/api/merchant/api-keys/:id").length <= 100, true);
});
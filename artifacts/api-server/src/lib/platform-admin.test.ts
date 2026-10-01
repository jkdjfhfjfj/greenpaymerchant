import assert from "node:assert/strict";
import { test } from "node:test";
import {
  platformAdminAuditDetails, platformAdminRole, remainingEffectiveAdminCount,
  resolvePlatformAdminFromSources, verifiedPrimaryEmail,
} from "./platform-admin";

test("only a verified primary Clerk email can confer bootstrap access", () => {
  const user = {
    id: "user_1",
    primary_email_address_id: "email_1",
    email_addresses: [
      { id: "email_1", email_address: "ADMIN@example.com", verification: { status: "verified" } },
      { id: "email_2", email_address: "other@example.com", verification: { status: "verified" } },
    ],
  };
  const email = verifiedPrimaryEmail(user);
  assert.equal(email, "admin@example.com");
  assert.equal(platformAdminRole(email, false, ["admin@example.com"]).isAdmin, true);
  assert.equal(platformAdminRole("other@example.com", false, ["admin@example.com"]).isAdmin, false);
  assert.equal(platformAdminRole(email, true, []).source, "assignment");
  assert.equal(platformAdminRole(null, false, ["admin@example.com"]).isAdmin, false);
  assert.equal(platformAdminRole(null, true, []).isAdmin, false);
});

test("unverified or non-primary email addresses are rejected for role changes", () => {
  assert.equal(verifiedPrimaryEmail({
    id: "user_2",
    primary_email_address_id: "email_unverified",
    email_addresses: [{ id: "email_unverified", email_address: "user@example.com", verification: { status: "unverified" } }],
  }), null);
  assert.equal(verifiedPrimaryEmail({
    id: "user_3",
    primary_email_address_id: "missing",
    email_addresses: [{ id: "email_1", email_address: "user@example.com", verification: { status: "verified" } }],
  }), null);
});

test("the resolver uses Clerk verification and server-side assignments, never client role claims", async () => {
  const user = {
    id: "user_4",
    primary_email_address_id: "email_1",
    email_addresses: [{ id: "email_1", email_address: "new-admin@example.com", verification: { status: "verified" } }],
  };
  const ordinarySignup = await resolvePlatformAdminFromSources("user_4", async () => user, async () => false);
  assert.equal(ordinarySignup.isAdmin, false);
  const assigned = await resolvePlatformAdminFromSources("user_4", async () => user, async (userId) => userId === "user_4");
  assert.deepEqual(assigned, { isAdmin: true, email: "new-admin@example.com", source: "assignment" });
  const unverifiedUser = {
    id: "user_5",
    primary_email_address_id: "email_2",
    email_addresses: [{ id: "email_2", email_address: "unverified-admin@example.com", verification: { status: "unverified" } }],
  };
  const unverifiedAssigned = await resolvePlatformAdminFromSources(
    "user_5", async () => unverifiedUser, async () => true,
  );
  assert.deepEqual(unverifiedAssigned, { isAdmin: false, email: null, source: null });
  await assert.rejects(resolvePlatformAdminFromSources(
    "user_4", async () => { throw new Error("Clerk unavailable"); }, async () => true,
  ));
  await assert.rejects(resolvePlatformAdminFromSources(
    "user_4", async () => user, async () => { throw new Error("Database unavailable"); },
  ));
});

test("last effective admin is protected unless another bootstrap or assigned admin remains", () => {
  assert.equal(remainingEffectiveAdminCount(["assigned_1"], new Set(), "assigned_1"), 0);
  assert.equal(remainingEffectiveAdminCount(["assigned_1", "assigned_2"], new Set(), "assigned_1"), 1);
  assert.equal(remainingEffectiveAdminCount(["assigned_1"], new Set(["bootstrap_1"]), "assigned_1"), 1);
});

test("admin audit details preserve the verified email and required reason", () => {
  assert.deepEqual(JSON.parse(platformAdminAuditDetails("admin@example.com", "Approved by security review.")), {
    email: "admin@example.com",
    reason: "Approved by security review.",
  });
});
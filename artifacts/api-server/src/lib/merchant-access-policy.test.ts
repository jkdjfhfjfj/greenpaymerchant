import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canAcceptWorkspaceInvitation,
  invitationCanBeAccepted,
  merchantTenantMatches,
  roleCanAccess,
} from "./merchant-access-policy";

test("merchant role permissions separate viewer, finance, and owner actions", () => {
  assert.equal(roleCanAccess("viewer", "read"), true);
  assert.equal(roleCanAccess("viewer", "finance"), false);
  assert.equal(roleCanAccess("viewer", "owner"), false);
  assert.equal(roleCanAccess("finance", "read"), true);
  assert.equal(roleCanAccess("finance", "finance"), true);
  assert.equal(roleCanAccess("finance", "owner"), false);
  assert.equal(roleCanAccess("owner", "owner"), true);
});

test("merchant membership cannot cross tenant boundaries", () => {
  assert.equal(merchantTenantMatches(24, 24), true);
  assert.equal(merchantTenantMatches(24, 25), false);
  assert.equal(merchantTenantMatches(24, 0), false);
});

test("an invitation can attach an account to only one merchant workspace at a time", () => {
  assert.equal(canAcceptWorkspaceInvitation(null), true);
  assert.equal(canAcceptWorkspaceInvitation(24), false);
});

test("invitation acceptance requires an unexpired, active token and the exact verified recipient", () => {
  const now = new Date("2026-03-01T12:00:00.000Z");
  const valid = {
    expiresAt: new Date("2026-03-02T12:00:00.000Z"),
    acceptedAt: null,
    revokedAt: null,
    invitationEmail: "Finance@greenpay.example",
    verifiedEmail: "finance@greenpay.example",
    now,
  };
  assert.equal(invitationCanBeAccepted(valid), true);
  assert.equal(invitationCanBeAccepted({ ...valid, verifiedEmail: "other@greenpay.example" }), false);
  assert.equal(invitationCanBeAccepted({ ...valid, expiresAt: now }), false);
  assert.equal(invitationCanBeAccepted({ ...valid, acceptedAt: now }), false);
  assert.equal(invitationCanBeAccepted({ ...valid, revokedAt: now }), false);
});
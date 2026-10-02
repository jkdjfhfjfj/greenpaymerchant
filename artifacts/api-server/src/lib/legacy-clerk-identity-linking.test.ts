import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyLegacyIdentityCandidates,
  verifiedEmailAddresses,
} from "./platform-admin";

test("legacy account matching accepts any verified email address, not an unverified alias", () => {
  assert.deepEqual(verifiedEmailAddresses({
    id: "user_external",
    primary_email_address_id: "primary",
    email_addresses: [
      { id: "primary", email_address: "primary@example.test", verification: { status: "verified" } },
      { id: "secondary", email_address: "verified.alias@example.test", verification: { status: "verified" } },
      { id: "pending", email_address: "pending@example.test", verification: { status: "unverified" } },
    ],
  }), ["primary@example.test", "verified.alias@example.test"]);
});

test("legacy identity matching links only one distinct verified legacy account", () => {
  assert.deepEqual(classifyLegacyIdentityCandidates([{ id: "legacy_1" }, { id: "legacy_1" }]), {
    resolution: "linked",
    legacyClerkUserId: "legacy_1",
  });
  assert.deepEqual(classifyLegacyIdentityCandidates([]), { resolution: "unmatched" });
  assert.deepEqual(classifyLegacyIdentityCandidates([{ id: "legacy_1" }, { id: "legacy_2" }]), {
    resolution: "ambiguous",
  });
  assert.deepEqual(classifyLegacyIdentityCandidates([{ id: "legacy_1" }], true), {
    resolution: "ambiguous",
  });
});
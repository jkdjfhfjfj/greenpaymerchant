import assert from "node:assert/strict";
import { test } from "node:test";
import { UpdateAdminCollectionCurrencyAvailabilityBody } from "@workspace/api-zod";
import {
  collectionCurrencyAvailabilityAudit,
  supportedCollectionCurrencyCode,
} from "./collection-currency-availability";

test("administrator currency updates accept only established collection catalog codes", () => {
  assert.equal(UpdateAdminCollectionCurrencyAvailabilityBody.safeParse({ currency: "NGN", enabled: false }).success, true);
  assert.equal(UpdateAdminCollectionCurrencyAvailabilityBody.safeParse({ currency: "ZAR", enabled: false }).success, false);
  assert.equal(UpdateAdminCollectionCurrencyAvailabilityBody.safeParse({ currency: "ngn", enabled: false }).success, false);
  assert.equal(supportedCollectionCurrencyCode("NGN"), "NGN");
  assert.equal(supportedCollectionCurrencyCode("ZAR"), null);
});

test("currency availability audit records the actor, target, and launch-state decision", () => {
  assert.deepEqual(collectionCurrencyAvailabilityAudit("admin-user-1", "NGN", false), {
    actor: "admin-user-1",
    action: "collection_currency.availability_updated",
    target: "collection-currency:NGN",
    details: "Collection launch state changed to coming soon.",
  });
});
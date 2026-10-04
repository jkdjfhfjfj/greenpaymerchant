import assert from "node:assert/strict";
import test from "node:test";
import {
  buildMerchantAccountNotifications,
  merchantAccountActionNotification,
} from "./merchant-account-notifications";

test("merchant account creation notifies the owner and every distinct admin", () => {
  const { ownerNotification, adminNotifications } = buildMerchantAccountNotifications({
    merchantId: 42,
    ownerUserId: "user-owner",
    businessName: "Green Market",
    adminUserIds: ["user-admin-1", "user-admin-1", "user-owner", "user-admin-2"],
  });

  assert.deepEqual(ownerNotification, {
    userId: "user-owner",
    eventKey: "merchant-created:42",
    type: "merchant_created",
    title: "Business account created",
    body: "Green Market was created and is waiting for Greenpay review.",
    href: "/merchant",
  });
  assert.deepEqual(adminNotifications, [
    {
      userId: "user-admin-1",
      eventKey: "merchant-created:42",
      type: "merchant_created",
      title: "New merchant account created",
      body: "Green Market submitted a new account application and is awaiting review.",
      href: "/admin/merchants",
    },
    {
      userId: "user-admin-2",
      eventKey: "merchant-created:42",
      type: "merchant_created",
      title: "New merchant account created",
      body: "Green Market submitted a new account application and is awaiting review.",
      href: "/admin/merchants",
    },
  ]);
});

test("merchant lifecycle notifications tell the owner what changed without exposing internal services", () => {
  const actions = [
    "application_resubmitted",
    "application_approved",
    "more_info_required",
    "kyc_reverification_required",
    "kyb_reverification_required",
    "pending",
    "suspended",
    "active",
  ] as const;

  for (const action of actions) {
    const notification = merchantAccountActionNotification({
      userId: "merchant-owner",
      eventKey: `merchant:${action}`,
      action,
      businessName: "Kono Trading",
      reason: "Upload a current registration document.",
    });
    assert.equal(notification.type, "merchant_account_update");
    assert.equal(
      notification.href,
      action === "kyc_reverification_required" || action === "kyb_reverification_required" ? "/merchant/kyc" : "/merchant",
    );
    assert.match(notification.body, /Kono Trading/);
    assert.doesNotMatch(notification.body, /administrator|processor|provider|Didit/i);
    assert.ok(notification.body.length <= 500);
  }
});
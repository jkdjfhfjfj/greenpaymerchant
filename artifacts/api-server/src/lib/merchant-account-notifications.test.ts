import assert from "node:assert/strict";
import test from "node:test";
import { buildMerchantAccountNotifications } from "./merchant-account-notifications";

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
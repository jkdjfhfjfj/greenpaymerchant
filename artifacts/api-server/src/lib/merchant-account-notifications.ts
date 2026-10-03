export type MerchantAccountNotification = {
  userId: string;
  eventKey: string;
  type: "merchant_created";
  title: string;
  body: string;
  href: string;
};

export function buildMerchantAccountNotifications(input: {
  merchantId: number;
  ownerUserId: string;
  businessName: string;
  adminUserIds: string[];
}): {
  ownerNotification: MerchantAccountNotification;
  adminNotifications: MerchantAccountNotification[];
} {
  const eventKey = `merchant-created:${input.merchantId}`;
  const ownerNotification: MerchantAccountNotification = {
    userId: input.ownerUserId,
    eventKey,
    type: "merchant_created",
    title: "Business account created",
    body: `${input.businessName} was created and is waiting for Greenpay review.`,
    href: "/merchant",
  };
  const adminNotifications = [...new Set(input.adminUserIds)]
    .filter((userId) => userId !== input.ownerUserId)
    .map((userId): MerchantAccountNotification => ({
      userId,
      eventKey,
      type: "merchant_created",
      title: "New merchant account created",
      body: `${input.businessName} submitted a new account application and is awaiting review.`,
      href: "/admin/merchants",
    }));
  return { ownerNotification, adminNotifications };
}
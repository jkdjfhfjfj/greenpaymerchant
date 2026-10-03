export type MerchantAccountNotification = {
  userId: string;
  eventKey: string;
  type: "merchant_created" | "merchant_account_update";
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

export function merchantAccountActionNotification(input: {
  userId: string;
  eventKey: string;
  action: "application_resubmitted" | "application_approved" | "more_info_required" | "suspended" | "active";
  businessName: string;
  reason?: string;
}): MerchantAccountNotification {
  const reason = input.reason?.trim();
  const content = input.action === "application_resubmitted"
    ? {
        title: "Updated business application received",
        body: `Your updated application for ${input.businessName} has been sent for review.`,
      }
    : input.action === "application_approved"
      ? {
          title: "Business application approved",
          body: `Your application for ${input.businessName} has been approved. You can now access your business workspace.`,
        }
      : input.action === "more_info_required"
        ? {
            title: "More information needed",
            body: `Please update your application for ${input.businessName}: ${reason || "Review the requested changes in your business profile."}`,
          }
        : input.action === "suspended"
          ? {
              title: "Business access paused",
              body: `${input.businessName} is temporarily unavailable. Contact Greenpay support if you need help.`,
            }
          : {
              title: "Business access restored",
              body: `${input.businessName} is active again.`,
            };
  return {
    userId: input.userId,
    eventKey: input.eventKey,
    type: "merchant_account_update",
    title: content.title,
    body: content.body.slice(0, 500),
    href: "/merchant",
  };
}
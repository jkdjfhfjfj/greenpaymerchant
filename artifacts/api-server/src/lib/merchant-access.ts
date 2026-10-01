import { and, desc, eq } from "drizzle-orm";
import type { Request, Response } from "express";
import { db, merchantTeamMembersTable, merchantsTable } from "@workspace/db";
import { ApiError } from "./api-error";
import { roleCanAccess, type MerchantPermission, type MerchantTeamRole } from "./merchant-access-policy";

export type Merchant = typeof merchantsTable.$inferSelect;
export type MerchantAccess = { merchant: Merchant; role: MerchantTeamRole };

export async function findMerchantAccessForUser(userId: string): Promise<MerchantAccess | null> {
  const [owned] = await db.select().from(merchantsTable)
    .where(eq(merchantsTable.ownerClerkId, userId)).limit(1);
  if (owned) return { merchant: owned, role: "owner" };

  const [membership] = await db.select({
    merchant: merchantsTable,
    role: merchantTeamMembersTable.role,
  }).from(merchantTeamMembersTable)
    .innerJoin(merchantsTable, eq(merchantTeamMembersTable.merchantId, merchantsTable.id))
    .where(and(
      eq(merchantTeamMembersTable.clerkUserId, userId),
      eq(merchantTeamMembersTable.active, true),
    ))
    .orderBy(desc(merchantTeamMembersTable.createdAt))
    .limit(1);
  return membership
    ? { merchant: membership.merchant, role: membership.role }
    : null;
}

export async function resolveMerchantAccess(
  req: Request,
  res: Response,
  permission: MerchantPermission = "read",
): Promise<Merchant | null> {
  const userId = res.locals.clerkUserId as string | undefined;
  if (!userId) {
    throw new ApiError(401, "Sign in to access this merchant workspace.");
  }
  const access = await findMerchantAccessForUser(userId);
  if (!access) return null;
  if (!roleCanAccess(access.role, permission)) {
    throw new ApiError(403, permission === "owner"
        ? "Only the merchant owner can manage this setting."
        : "This team role is read-only and cannot perform that action.");
  }
  void req;
  return access.merchant;
}
import { and, asc, desc, eq } from "drizzle-orm";
import type { Request, Response } from "express";
import { db, merchantTeamMembersTable, merchantsTable } from "@workspace/db";
import { ApiError } from "./api-error";
import { roleCanAccess, type MerchantPermission, type MerchantTeamRole } from "./merchant-access-policy";

export type Merchant = typeof merchantsTable.$inferSelect;
export type MerchantAccess = { merchant: Merchant; role: MerchantTeamRole };

export const MERCHANT_WORKSPACE_COOKIE = "greenpay_workspace";

export function selectedMerchantWorkspaceId(req: Request): number | undefined {
  const value = req.cookies?.[MERCHANT_WORKSPACE_COOKIE];
  if (typeof value !== "string" || !/^[1-9]\d{0,9}$/.test(value)) return undefined;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : undefined;
}

export function setMerchantWorkspaceCookie(res: Response, merchantId: number): void {
  res.cookie(MERCHANT_WORKSPACE_COOKIE, String(merchantId), {
    httpOnly: true,
    secure: process.env.NODE_ENV !== "development",
    sameSite: "lax",
    path: "/api",
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });
}

export async function listMerchantAccessForUser(userId: string): Promise<MerchantAccess[]> {
  const owned = await db.select().from(merchantsTable)
    .where(eq(merchantsTable.ownerClerkId, userId))
    .orderBy(asc(merchantsTable.createdAt), asc(merchantsTable.id));
  const memberships = await db.select({
    merchant: merchantsTable,
    role: merchantTeamMembersTable.role,
  }).from(merchantTeamMembersTable)
    .innerJoin(merchantsTable, eq(merchantTeamMembersTable.merchantId, merchantsTable.id))
    .where(and(
      eq(merchantTeamMembersTable.clerkUserId, userId),
      eq(merchantTeamMembersTable.active, true),
    ))
    .orderBy(desc(merchantTeamMembersTable.createdAt));
  const workspaces: MerchantAccess[] = owned.map((merchant) => ({ merchant, role: "owner" }));
  const includedIds = new Set(owned.map((merchant) => merchant.id));
  for (const membership of memberships) {
    if (includedIds.has(membership.merchant.id)) continue;
    includedIds.add(membership.merchant.id);
    workspaces.push({ merchant: membership.merchant, role: membership.role });
  }
  return workspaces;
}

export async function findMerchantAccessForUser(
  userId: string,
  selectedMerchantId?: number,
): Promise<MerchantAccess | null> {
  const workspaces = await listMerchantAccessForUser(userId);
  if (selectedMerchantId !== undefined) {
    return workspaces.find((workspace) => workspace.merchant.id === selectedMerchantId) ?? workspaces[0] ?? null;
  }
  return workspaces[0] ?? null;
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
  const access = await findMerchantAccessForUser(userId, selectedMerchantWorkspaceId(req));
  if (!access) return null;
  if (!roleCanAccess(access.role, permission)) {
    throw new ApiError(403, permission === "owner"
        ? "Only the merchant owner can manage this setting."
        : "This team role is read-only and cannot perform that action.");
  }
  return access.merchant;
}
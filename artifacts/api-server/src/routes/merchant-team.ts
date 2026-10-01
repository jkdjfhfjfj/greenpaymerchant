import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { Router, type IRouter } from "express";
import {
  AcceptMerchantTeamInvitationBody,
  AcceptMerchantTeamInvitationResponse,
  CreateMerchantTeamInvitationBody,
  ListMerchantTeamResponse,
  RemoveMerchantTeamMemberParams,
  RemoveMerchantTeamMemberResponse,
  RevokeMerchantTeamInvitationParams,
  RevokeMerchantTeamInvitationResponse,
  UpdateMerchantTeamMemberBody,
  UpdateMerchantTeamMemberParams,
  UpdateMerchantTeamMemberResponse,
} from "@workspace/api-zod";
import {
  db,
  merchantTeamInvitationsTable,
  merchantTeamMembersTable,
  merchantsTable,
} from "@workspace/db";
import { getPublicAppUrl } from "../lib/greenpay-provider";
import { canAcceptWorkspaceInvitation, invitationCanBeAccepted } from "../lib/merchant-access-policy";
import { findMerchantAccessForUser, resolveMerchantAccess } from "../lib/merchant-access";
import { ApiError } from "../lib/api-error";
import { assertMerchantActionEnabled } from "../lib/platform";
import { notifyTeamInvitation } from "../lib/mailtrap-delivery";
import { requireSignedIn, verifiedClerkEmail } from "../middlewares/requireAdmin";

const router: IRouter = Router();
const inviteLifetimeMs = 7 * 24 * 60 * 60 * 1000;

function invitationDto(row: typeof merchantTeamInvitationsTable.$inferSelect) {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    status: "pending" as const,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
  };
}

function memberDto(row: typeof merchantTeamMembersTable.$inferSelect) {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    status: "active" as const,
    createdAt: row.createdAt,
  };
}

router.get("/merchant/team", requireSignedIn, async (req, res): Promise<void> => {
  const merchant = await resolveMerchantAccess(req, res, "owner");
  if (!merchant) { res.status(404).json({ error: "Merchant onboarding is not complete." }); return; }
  const now = new Date();
  const [members, invitations] = await Promise.all([
    db.select().from(merchantTeamMembersTable).where(and(
      eq(merchantTeamMembersTable.merchantId, merchant.id),
      eq(merchantTeamMembersTable.active, true),
    )).orderBy(desc(merchantTeamMembersTable.createdAt)),
    db.select().from(merchantTeamInvitationsTable).where(and(
      eq(merchantTeamInvitationsTable.merchantId, merchant.id),
      isNull(merchantTeamInvitationsTable.acceptedAt),
      isNull(merchantTeamInvitationsTable.revokedAt),
      gt(merchantTeamInvitationsTable.expiresAt, now),
    )).orderBy(desc(merchantTeamInvitationsTable.createdAt)),
  ]);
  res.json(ListMerchantTeamResponse.parse({
    members: members.map(memberDto),
    invitations: invitations.map(invitationDto),
  }));
});

router.post("/merchant/team", requireSignedIn, async (req, res): Promise<void> => {
  res.setHeader("Cache-Control", "no-store");
  const parsed = CreateMerchantTeamInvitationBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const merchant = await resolveMerchantAccess(req, res, "owner");
  if (!merchant) { res.status(404).json({ error: "Merchant onboarding is not complete." }); return; }
  await assertMerchantActionEnabled(merchant.id, "teamManagement");
  const email = parsed.data.email.trim().toLowerCase();
  const existingOwnerEmail = await verifiedClerkEmail(merchant.ownerClerkId);
  if (existingOwnerEmail === email) {
    res.status(409).json({ error: "The merchant owner already has owner access and cannot be invited as a team member." });
    return;
  }
  const [existingMember] = await db.select({ id: merchantTeamMembersTable.id }).from(merchantTeamMembersTable)
    .where(and(
      eq(merchantTeamMembersTable.merchantId, merchant.id),
      eq(merchantTeamMembersTable.email, email),
      eq(merchantTeamMembersTable.active, true),
    )).limit(1);
  if (existingMember) {
    res.status(409).json({ error: "That verified email already has access to this merchant." });
    return;
  }
  const now = new Date();
  const [pending] = await db.select({ id: merchantTeamInvitationsTable.id }).from(merchantTeamInvitationsTable)
    .where(and(
      eq(merchantTeamInvitationsTable.merchantId, merchant.id),
      eq(merchantTeamInvitationsTable.email, email),
      isNull(merchantTeamInvitationsTable.acceptedAt),
      isNull(merchantTeamInvitationsTable.revokedAt),
      gt(merchantTeamInvitationsTable.expiresAt, now),
    )).limit(1);
  if (pending) {
    res.status(409).json({ error: "A pending invitation already exists for that email. Revoke it before creating another." });
    return;
  }
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(now.getTime() + inviteLifetimeMs);
  const inviteUrl = new URL("/team/accept", getPublicAppUrl());
  inviteUrl.searchParams.set("token", token);
  const [invitation] = await db.insert(merchantTeamInvitationsTable).values({
    merchantId: merchant.id,
    email,
    role: parsed.data.role,
    tokenHash: createHash("sha256").update(token).digest("hex"),
    createdByClerkId: res.locals.clerkUserId as string,
    expiresAt,
  }).returning();
  try {
    await notifyTeamInvitation({
      invitationId: invitation.id,
      merchantId: merchant.id,
      recipientEmail: email,
      inviteUrl: inviteUrl.toString(),
      role: parsed.data.role,
      expiresAt,
    });
  } catch (error) {
    await db.update(merchantTeamInvitationsTable).set({ revokedAt: new Date() })
      .where(eq(merchantTeamInvitationsTable.id, invitation.id));
    throw new ApiError(503, error instanceof Error
      ? `Invitation email could not be queued: ${error.message}`
      : "Invitation email could not be queued. Please retry.");
  }
  res.status(201).json({
    invitation: invitationDto(invitation),
    delivery: "queued",
  });
});

router.delete("/merchant/team/invitations/:id", requireSignedIn, async (req, res): Promise<void> => {
  const params = RevokeMerchantTeamInvitationParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const merchant = await resolveMerchantAccess(req, res, "owner");
  if (!merchant) { res.status(404).json({ error: "Merchant onboarding is not complete." }); return; }
  await assertMerchantActionEnabled(merchant.id, "teamManagement");
  const [invitation] = await db.update(merchantTeamInvitationsTable)
    .set({ revokedAt: new Date() })
    .where(and(
      eq(merchantTeamInvitationsTable.id, params.data.id),
      eq(merchantTeamInvitationsTable.merchantId, merchant.id),
      isNull(merchantTeamInvitationsTable.acceptedAt),
      isNull(merchantTeamInvitationsTable.revokedAt),
    )).returning({ id: merchantTeamInvitationsTable.id });
  if (!invitation) { res.status(404).json({ error: "Pending invitation not found for this merchant." }); return; }
  res.status(204).send(RevokeMerchantTeamInvitationResponse.parse(undefined));
});

router.patch("/merchant/team/members/:id", requireSignedIn, async (req, res): Promise<void> => {
  const params = UpdateMerchantTeamMemberParams.safeParse(req.params);
  const body = UpdateMerchantTeamMemberBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: !params.success ? params.error.message : body.error?.message ?? "Invalid team role." });
    return;
  }
  const merchant = await resolveMerchantAccess(req, res, "owner");
  if (!merchant) { res.status(404).json({ error: "Merchant onboarding is not complete." }); return; }
  await assertMerchantActionEnabled(merchant.id, "teamManagement");
  const [member] = await db.update(merchantTeamMembersTable).set({
    role: body.data.role,
    updatedAt: new Date(),
  }).where(and(
    eq(merchantTeamMembersTable.id, params.data.id),
    eq(merchantTeamMembersTable.merchantId, merchant.id),
    eq(merchantTeamMembersTable.active, true),
  )).returning();
  if (!member) { res.status(404).json({ error: "Active team member not found for this merchant." }); return; }
  res.json(UpdateMerchantTeamMemberResponse.parse(memberDto(member)));
});

router.delete("/merchant/team/members/:id", requireSignedIn, async (req, res): Promise<void> => {
  const params = RemoveMerchantTeamMemberParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const merchant = await resolveMerchantAccess(req, res, "owner");
  if (!merchant) { res.status(404).json({ error: "Merchant onboarding is not complete." }); return; }
  const [member] = await db.update(merchantTeamMembersTable).set({
    active: false,
    updatedAt: new Date(),
  }).where(and(
    eq(merchantTeamMembersTable.id, params.data.id),
    eq(merchantTeamMembersTable.merchantId, merchant.id),
    eq(merchantTeamMembersTable.active, true),
  )).returning({ id: merchantTeamMembersTable.id });
  if (!member) { res.status(404).json({ error: "Active team member not found for this merchant." }); return; }
  res.status(204).send(RemoveMerchantTeamMemberResponse.parse(undefined));
});

router.post("/merchant/team/accept", requireSignedIn, async (req, res): Promise<void> => {
  res.setHeader("Cache-Control", "no-store");
  const parsed = AcceptMerchantTeamInvitationBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const userId = res.locals.clerkUserId as string;
  const verifiedEmail = await verifiedClerkEmail(userId);
  if (!verifiedEmail) {
    res.status(403).json({ error: "Accepting an invitation requires a signed-in account with a verified email address." });
    return;
  }
  const tokenHash = createHash("sha256").update(parsed.data.token).digest("hex");
  const [invitation] = await db.select().from(merchantTeamInvitationsTable)
    .where(eq(merchantTeamInvitationsTable.tokenHash, tokenHash)).limit(1);
  if (!invitation) { res.status(409).json({ error: "This invitation is no longer pending." }); return; }
  if (invitation.email.trim().toLowerCase() !== verifiedEmail.trim().toLowerCase()) {
    res.status(403).json({ error: "Sign in with the verified email address this invitation was sent to." });
    return;
  }
  const now = new Date();
  if (!invitationCanBeAccepted({
    expiresAt: invitation.expiresAt,
    acceptedAt: invitation.acceptedAt,
    revokedAt: invitation.revokedAt,
    invitationEmail: invitation.email,
    verifiedEmail,
    now,
  })) {
    res.status(409).json({ error: "This invitation has expired, was revoked, or has already been accepted." });
    return;
  }
  const existingAccess = await findMerchantAccessForUser(userId);
  if (!canAcceptWorkspaceInvitation(existingAccess?.merchant.id ?? null)) {
    res.status(409).json({ error: "This account already belongs to a merchant workspace. Use an account that is not attached to another workspace." });
    return;
  }
  const [merchant] = await db.select().from(merchantsTable)
    .where(eq(merchantsTable.id, invitation.merchantId)).limit(1);
  if (!merchant) { res.status(409).json({ error: "The invited merchant workspace is no longer available." }); return; }
  if (merchant.ownerClerkId === userId) {
    res.status(409).json({ error: "The merchant owner cannot accept a team invitation." });
    return;
  }
  await assertMerchantActionEnabled(merchant.id, "teamManagement");
  try {
    await db.transaction(async (tx) => {
      const [accepted] = await tx.update(merchantTeamInvitationsTable)
        .set({ acceptedAt: now })
        .where(and(
          eq(merchantTeamInvitationsTable.id, invitation.id),
          isNull(merchantTeamInvitationsTable.acceptedAt),
          isNull(merchantTeamInvitationsTable.revokedAt),
          gt(merchantTeamInvitationsTable.expiresAt, now),
        )).returning({ id: merchantTeamInvitationsTable.id });
      if (!accepted) throw new ApiError(409, "This invitation is no longer pending.");
      const [restoredMember] = await tx.update(merchantTeamMembersTable).set({
        email: verifiedEmail.trim().toLowerCase(),
        role: invitation.role,
        active: true,
        updatedAt: now,
      }).where(and(
        eq(merchantTeamMembersTable.merchantId, merchant.id),
        eq(merchantTeamMembersTable.clerkUserId, userId),
        eq(merchantTeamMembersTable.active, false),
      )).returning({ id: merchantTeamMembersTable.id });
      const [newMember] = restoredMember ? [restoredMember] : await tx.insert(merchantTeamMembersTable).values({
        merchantId: merchant.id,
        clerkUserId: userId,
        email: verifiedEmail.trim().toLowerCase(),
        role: invitation.role,
        active: true,
      }).onConflictDoNothing().returning({ id: merchantTeamMembersTable.id });
      if (!restoredMember && !newMember) throw new ApiError(409, "This account already has a team membership for this merchant.");
    });
  } catch (error) {
    if (error instanceof ApiError) {
      res.status(error.statusCode).json({ error: error.message });
      return;
    }
    throw error;
  }
  res.json(AcceptMerchantTeamInvitationResponse.parse({
    merchantId: merchant.id,
    businessName: merchant.businessName,
    role: invitation.role,
  }));
});

export default router;
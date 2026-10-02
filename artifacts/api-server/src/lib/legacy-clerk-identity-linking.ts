import { and, eq, ne, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  clerkIdentityLinksTable,
  collectionCurrencyAvailabilityTable,
  db,
  emailDeliverySettingsTable,
  merchantTeamInvitationsTable,
  merchantTeamMembersTable,
  merchantsTable,
  platformAdminAssignmentsTable,
  supportDeliveryOutboxTable,
  supportMessagesTable,
  supportTicketsTable,
  transactionalEmailOutboxTable,
  userNotificationsTable,
  adminAuditLogTable,
} from "@workspace/db";
import { getClerkProviderMode, getLegacyClerkSecretKey } from "./clerk-config";
import {
  classifyLegacyIdentityCandidates,
  fetchClerkUser,
  findLegacyVerifiedClerkUsersByEmail,
  verifiedEmailAddresses,
} from "./platform-admin";
import type { ClerkUserRecord } from "./platform-admin";

export type IdentityLinkResolution = "linked" | "unmatched" | "ambiguous" | "conflict";

type IdentityLinkResult = {
  resolution: IdentityLinkResolution | "unverified" | "disabled";
};

function advisoryLockKeys(externalId: string, legacyId?: string): string[] {
  return [...new Set([externalId, legacyId].filter((id): id is string => Boolean(id)))]
    .sort()
    .map((id) => `greenpay-clerk-link:${id}`);
}

async function acquireIdentityLocks(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], keys: string[]): Promise<void> {
  for (const key of keys) {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${key}))`);
  }
}

async function existingResolution(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  externalId: string,
): Promise<IdentityLinkResolution | null> {
  const [existing] = await tx.select({ resolution: clerkIdentityLinksTable.resolution })
    .from(clerkIdentityLinksTable)
    .where(eq(clerkIdentityLinksTable.externalClerkUserId, externalId))
    .limit(1);
  return existing?.resolution ?? null;
}

async function saveResolution(
  externalId: string,
  resolution: Exclude<IdentityLinkResolution, "linked">,
): Promise<IdentityLinkResolution> {
  return db.transaction(async (tx) => {
    await acquireIdentityLocks(tx, advisoryLockKeys(externalId));
    const previous = await existingResolution(tx, externalId);
    if (previous) return previous;
    await tx.insert(clerkIdentityLinksTable).values({
      externalClerkUserId: externalId,
      resolution,
    });
    return resolution;
  });
}

async function hasActiveTeamWorkspaceConflict(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  legacyId: string,
  externalId: string,
): Promise<boolean> {
  const legacyMember = alias(merchantTeamMembersTable, "legacy_member");
  const externalMember = alias(merchantTeamMembersTable, "external_member");
  const [conflict] = await tx.select({ id: legacyMember.id })
    .from(legacyMember)
    .innerJoin(externalMember, and(
      eq(legacyMember.active, true),
      eq(externalMember.active, true),
      ne(legacyMember.merchantId, externalMember.merchantId),
    ))
    .where(and(
      eq(legacyMember.clerkUserId, legacyId),
      eq(externalMember.clerkUserId, externalId),
    ))
    .limit(1);
  return Boolean(conflict);
}

async function mergeTeamMemberships(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  legacyId: string,
  externalId: string,
  verifiedEmail: string,
): Promise<void> {
  const legacyMembers = await tx.select().from(merchantTeamMembersTable)
    .where(eq(merchantTeamMembersTable.clerkUserId, legacyId));
  for (const legacyMember of legacyMembers) {
    const [externalMember] = await tx.select().from(merchantTeamMembersTable)
      .where(and(
        eq(merchantTeamMembersTable.clerkUserId, externalId),
        eq(merchantTeamMembersTable.merchantId, legacyMember.merchantId),
      ))
      .limit(1);
    if (externalMember) {
      await tx.update(merchantTeamMembersTable).set({
        role: legacyMember.role === "finance" || externalMember.role === "finance" ? "finance" : "viewer",
        active: legacyMember.active || externalMember.active,
        email: verifiedEmail,
        updatedAt: new Date(),
      }).where(eq(merchantTeamMembersTable.id, externalMember.id));
      await tx.delete(merchantTeamMembersTable)
        .where(eq(merchantTeamMembersTable.id, legacyMember.id));
    } else {
      await tx.update(merchantTeamMembersTable).set({
        clerkUserId: externalId,
        email: verifiedEmail,
        updatedAt: new Date(),
      }).where(eq(merchantTeamMembersTable.id, legacyMember.id));
    }
  }
}

async function mergePlatformAdminAssignment(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  legacyId: string,
  externalId: string,
  verifiedEmail: string,
): Promise<void> {
  const [legacyAssignment] = await tx.select().from(platformAdminAssignmentsTable)
    .where(eq(platformAdminAssignmentsTable.clerkUserId, legacyId)).limit(1);
  if (legacyAssignment) {
    const [externalAssignment] = await tx.select().from(platformAdminAssignmentsTable)
      .where(eq(platformAdminAssignmentsTable.clerkUserId, externalId)).limit(1);
    if (externalAssignment) {
      const revokedAt = !legacyAssignment.revokedAt || !externalAssignment.revokedAt
        ? null
        : new Date(Math.max(legacyAssignment.revokedAt.getTime(), externalAssignment.revokedAt.getTime()));
      await tx.update(platformAdminAssignmentsTable).set({
        verifiedEmailSnapshot: verifiedEmail,
        revokedAt,
        updatedAt: new Date(),
      }).where(eq(platformAdminAssignmentsTable.clerkUserId, externalId));
      await tx.delete(platformAdminAssignmentsTable)
        .where(eq(platformAdminAssignmentsTable.clerkUserId, legacyId));
    } else {
      await tx.update(platformAdminAssignmentsTable).set({
        clerkUserId: externalId,
        verifiedEmailSnapshot: verifiedEmail,
        updatedAt: new Date(),
      }).where(eq(platformAdminAssignmentsTable.clerkUserId, legacyId));
    }
  }
  await tx.update(platformAdminAssignmentsTable).set({ assignedByClerkUserId: externalId })
    .where(eq(platformAdminAssignmentsTable.assignedByClerkUserId, legacyId));
}

async function mergeNotifications(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  legacyId: string,
  externalId: string,
): Promise<void> {
  const legacyNotifications = await tx.select().from(userNotificationsTable)
    .where(eq(userNotificationsTable.userId, legacyId));
  for (const legacyNotice of legacyNotifications) {
    const [externalNotice] = await tx.select().from(userNotificationsTable)
      .where(and(
        eq(userNotificationsTable.userId, externalId),
        eq(userNotificationsTable.eventKey, legacyNotice.eventKey),
      ))
      .limit(1);
    if (externalNotice) {
      const createdAt = new Date(Math.min(externalNotice.createdAt.getTime(), legacyNotice.createdAt.getTime()));
      await tx.update(userNotificationsTable).set({
        readAt: externalNotice.readAt ?? legacyNotice.readAt,
        createdAt,
      }).where(eq(userNotificationsTable.id, externalNotice.id));
      await tx.delete(userNotificationsTable).where(eq(userNotificationsTable.id, legacyNotice.id));
    } else {
      await tx.update(userNotificationsTable).set({ userId: externalId })
        .where(eq(userNotificationsTable.id, legacyNotice.id));
    }
  }
}

async function migrateIdentityReferences(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  legacyId: string,
  externalId: string,
  verifiedEmail: string,
): Promise<void> {
  await mergeTeamMemberships(tx, legacyId, externalId, verifiedEmail);
  await mergePlatformAdminAssignment(tx, legacyId, externalId, verifiedEmail);
  await mergeNotifications(tx, legacyId, externalId);

  await tx.update(merchantsTable).set({ ownerClerkId: externalId })
    .where(eq(merchantsTable.ownerClerkId, legacyId));
  await tx.update(merchantTeamInvitationsTable).set({ createdByClerkId: externalId })
    .where(eq(merchantTeamInvitationsTable.createdByClerkId, legacyId));
  await tx.update(supportTicketsTable).set({ ownerClerkId: externalId })
    .where(eq(supportTicketsTable.ownerClerkId, legacyId));
  await tx.update(supportMessagesTable).set({ authorClerkId: externalId })
    .where(eq(supportMessagesTable.authorClerkId, legacyId));
  await tx.update(collectionCurrencyAvailabilityTable).set({ actorUserId: externalId })
    .where(eq(collectionCurrencyAvailabilityTable.actorUserId, legacyId));
  await tx.update(adminAuditLogTable).set({ actor: externalId })
    .where(eq(adminAuditLogTable.actor, legacyId));
  await tx.update(supportDeliveryOutboxTable).set({ reviewedBy: externalId })
    .where(eq(supportDeliveryOutboxTable.reviewedBy, legacyId));
  await tx.update(transactionalEmailOutboxTable).set({ reviewedBy: externalId })
    .where(eq(transactionalEmailOutboxTable.reviewedBy, legacyId));
  await tx.update(emailDeliverySettingsTable).set({ senderVerifiedBy: externalId })
    .where(eq(emailDeliverySettingsTable.senderVerifiedBy, legacyId));
  await tx.update(emailDeliverySettingsTable).set({ updatedBy: externalId })
    .where(eq(emailDeliverySettingsTable.updatedBy, legacyId));
}

async function commitVerifiedLink(
  externalId: string,
  legacyId: string,
  verifiedEmail: string,
): Promise<IdentityLinkResolution> {
  return db.transaction(async (tx) => {
    await acquireIdentityLocks(tx, advisoryLockKeys(externalId, legacyId));
    const previous = await existingResolution(tx, externalId);
    if (previous) return previous;

    if (externalId === legacyId) {
      await tx.insert(clerkIdentityLinksTable).values({
        externalClerkUserId: externalId,
        legacyClerkUserId: legacyId,
        resolution: "linked",
      });
      return "linked";
    }

    const [legacyLink] = await tx.select({ externalClerkUserId: clerkIdentityLinksTable.externalClerkUserId })
      .from(clerkIdentityLinksTable)
      .where(and(
        eq(clerkIdentityLinksTable.legacyClerkUserId, legacyId),
        eq(clerkIdentityLinksTable.resolution, "linked"),
      ))
      .limit(1);
    if (legacyLink) {
      await tx.insert(clerkIdentityLinksTable).values({
        externalClerkUserId: externalId,
        resolution: "ambiguous",
      });
      return "ambiguous";
    }

    if (await hasActiveTeamWorkspaceConflict(tx, legacyId, externalId)) {
      await tx.insert(clerkIdentityLinksTable).values({
        externalClerkUserId: externalId,
        resolution: "conflict",
      });
      return "conflict";
    }

    await migrateIdentityReferences(tx, legacyId, externalId, verifiedEmail);
    await tx.insert(clerkIdentityLinksTable).values({
      externalClerkUserId: externalId,
      legacyClerkUserId: legacyId,
      resolution: "linked",
    });
    return "linked";
  });
}

function verifiedEmailsForLinking(user: ClerkUserRecord): string[] {
  return verifiedEmailAddresses(user);
}

export async function linkLegacyClerkIdentityOnFirstSignIn(externalId: string): Promise<IdentityLinkResult> {
  if (getClerkProviderMode() !== "external" || !getLegacyClerkSecretKey()) {
    return { resolution: "disabled" };
  }

  const [recorded] = await db.select({ resolution: clerkIdentityLinksTable.resolution })
    .from(clerkIdentityLinksTable)
    .where(eq(clerkIdentityLinksTable.externalClerkUserId, externalId))
    .limit(1);
  if (recorded) return { resolution: recorded.resolution };

  const externalUser = await fetchClerkUser(externalId);
  const verifiedEmails = verifiedEmailsForLinking(externalUser);
  if (verifiedEmails.length === 0) return { resolution: "unverified" };

  const legacySearches = await Promise.all(verifiedEmails.map(findLegacyVerifiedClerkUsersByEmail));
  const allCandidates = legacySearches.flatMap(({ users }) => users);
  const decision = classifyLegacyIdentityCandidates(
    allCandidates,
    legacySearches.some(({ possiblyTruncated }) => possiblyTruncated),
  );
  if (decision.resolution !== "linked") {
    return {
      resolution: await saveResolution(externalId, decision.resolution),
    };
  }

  const legacyUser = allCandidates.find((candidate) => candidate.id === decision.legacyClerkUserId)!;
  const verifiedEmail = verifiedEmails.find((email) => verifiedEmailAddresses(legacyUser).includes(email));
  if (!verifiedEmail) return { resolution: "unverified" };
  return {
    resolution: await commitVerifiedLink(externalId, decision.legacyClerkUserId, verifiedEmail),
  };
}
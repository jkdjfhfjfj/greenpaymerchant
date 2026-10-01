import { and, eq, isNull } from "drizzle-orm";

type ClerkEmailAddress = {
  id?: string;
  email_address?: string;
  verification?: { status?: string };
};

export type ClerkUserRecord = {
  id: string;
  primary_email_address_id?: string | null;
  email_addresses?: ClerkEmailAddress[];
  first_name?: string | null;
  last_name?: string | null;
};

export class ClerkApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "ClerkApiError";
  }
}

export function allowlistedAdminEmails(): string[] {
  return [...new Set((process.env.ADMIN_EMAILS ?? "").split(",")
    .map((value) => value.trim().toLowerCase()).filter(Boolean))];
}

export function emailIsBootstrapAdmin(email: string | null, allowedEmails = allowlistedAdminEmails()): boolean {
  return Boolean(email && allowedEmails.includes(email.toLowerCase().trim()));
}

export function platformAdminRole(email: string | null, assigned: boolean, allowedEmails = allowlistedAdminEmails()) {
  const bootstrap = emailIsBootstrapAdmin(email, allowedEmails);
  const assignedAdmin = Boolean(email && assigned);
  return {
    isAdmin: bootstrap || assignedAdmin,
    source: bootstrap ? "bootstrap" as const : assignedAdmin ? "assignment" as const : null,
  };
}

export function remainingEffectiveAdminCount(
  assignedUserIds: string[],
  bootstrapUserIds: Set<string>,
  userIdToRemove: string,
): number {
  const remaining = new Set([...assignedUserIds, ...bootstrapUserIds]);
  remaining.delete(userIdToRemove);
  return remaining.size;
}

export function platformAdminAuditDetails(email: string, reason: string): string {
  return JSON.stringify({ email, reason });
}

export function verifiedPrimaryEmail(user: ClerkUserRecord): string | null {
  const primary = user.email_addresses?.find((item) => item.id === user.primary_email_address_id);
  if (primary?.verification?.status !== "verified" || !primary.email_address) return null;
  return primary.email_address.toLowerCase().trim();
}

async function clerkRequest<T>(url: string): Promise<T> {
  const secret = process.env.CLERK_SECRET_KEY?.trim();
  if (!secret) throw new ClerkApiError("Clerk server credentials are not configured.");
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${secret}`, Accept: "application/json" },
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    throw new ClerkApiError("Clerk could not be reached.");
  }
  if (!response.ok) throw new ClerkApiError("Clerk user lookup failed.", response.status);
  return await response.json() as T;
}

export function fetchClerkUser(userId: string): Promise<ClerkUserRecord> {
  return clerkRequest<ClerkUserRecord>(`https://api.clerk.com/v1/users/${encodeURIComponent(userId)}`);
}

export async function findVerifiedClerkUsersByEmail(email: string): Promise<Array<ClerkUserRecord & { verifiedEmail: string }>> {
  const params = new URLSearchParams();
  params.append("email_address[]", email.trim().toLowerCase());
  params.set("limit", "100");
  const users = await clerkRequest<ClerkUserRecord[]>(`https://api.clerk.com/v1/users?${params.toString()}`);
  return users.flatMap((user) => {
    const verifiedEmail = verifiedPrimaryEmail(user);
    return verifiedEmail === email.trim().toLowerCase() ? [{ ...user, verifiedEmail }] : [];
  });
}

export async function existingClerkUserIds(userIds: string[]): Promise<Set<string>> {
  const lookups = await Promise.all(userIds.map(async (userId) => {
    try {
      await fetchClerkUser(userId);
      return userId;
    } catch (error) {
      if (error instanceof ClerkApiError && error.status === 404) return null;
      throw error;
    }
  }));
  return new Set(lookups.filter((userId): userId is string => Boolean(userId)));
}

export async function resolvePlatformAdmin(userId: string): Promise<{
  isAdmin: boolean;
  email: string | null;
  source: "bootstrap" | "assignment" | null;
}> {
  return resolvePlatformAdminFromSources(
    userId,
    fetchClerkUser,
    async (id) => {
      const { db, platformAdminAssignmentsTable } = await import("@workspace/db");
      const assignments = await db.select({ clerkUserId: platformAdminAssignmentsTable.clerkUserId })
        .from(platformAdminAssignmentsTable)
        .where(and(
          eq(platformAdminAssignmentsTable.clerkUserId, id),
          isNull(platformAdminAssignmentsTable.revokedAt),
        )).limit(1);
      return assignments.length > 0;
    },
  );
}

export async function resolvePlatformAdminFromSources(
  userId: string,
  fetchUser: (userId: string) => Promise<ClerkUserRecord>,
  hasActiveAssignment: (userId: string) => Promise<boolean>,
): Promise<{ isAdmin: boolean; email: string | null; source: "bootstrap" | "assignment" | null }> {
  const [clerkUser, assigned] = await Promise.all([fetchUser(userId), hasActiveAssignment(userId)]);
  const email = verifiedPrimaryEmail(clerkUser);
  const access = platformAdminRole(email, assigned);
  return { ...access, email };
}

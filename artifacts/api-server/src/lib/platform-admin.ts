import { and, eq, isNull } from "drizzle-orm";
import { getActiveClerkSecretKey, getLegacyClerkSecretKey } from "./clerk-config";

type ClerkEmailAddress = {
  id?: string;
  email_address?: string;
  verification?: { status?: string };
};

type ClerkPhoneNumber = {
  id?: string;
  phone_number?: string;
  verification?: { status?: string };
};

export type ClerkUserRecord = {
  id: string;
  primary_email_address_id?: string | null;
  email_addresses?: ClerkEmailAddress[];
  primary_phone_number_id?: string | null;
  phone_numbers?: ClerkPhoneNumber[];
  first_name?: string | null;
  last_name?: string | null;
  created_at?: number;
  last_sign_in_at?: number | null;
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

export function verifiedEmailAddresses(user: ClerkUserRecord): string[] {
  return [...new Set((user.email_addresses ?? [])
    .filter((item) => item.verification?.status === "verified" && item.email_address)
    .map((item) => item.email_address!.toLowerCase().trim())
    .filter(Boolean))];
}

export function verifiedPrimaryPhoneNumber(user: ClerkUserRecord): string | null {
  const primary = user.phone_numbers?.find((item) => item.id === user.primary_phone_number_id);
  if (primary?.verification?.status !== "verified" || !primary.phone_number) return null;
  return primary.phone_number.trim() || null;
}

export function verifiedPhoneNumbers(user: ClerkUserRecord): string[] {
  return [...new Set((user.phone_numbers ?? [])
    .filter((item) => item.verification?.status === "verified" && item.phone_number)
    .map((item) => item.phone_number!.trim())
    .filter(Boolean))];
}

export function classifyLegacyIdentityCandidates(
  candidates: Array<{ id: string }>,
  possiblyTruncated = false,
): { resolution: "linked"; legacyClerkUserId: string } | { resolution: "unmatched" | "ambiguous" } {
  if (possiblyTruncated) return { resolution: "ambiguous" };
  const ids = [...new Set(candidates.map((candidate) => candidate.id))];
  if (ids.length === 0) return { resolution: "unmatched" };
  if (ids.length > 1) return { resolution: "ambiguous" };
  return { resolution: "linked", legacyClerkUserId: ids[0]! };
}

async function clerkRequestWithSecret<T>(url: string, secret: string | null): Promise<T> {
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

async function clerkRequest<T>(url: string): Promise<T> {
  return clerkRequestWithSecret(url, getActiveClerkSecretKey());
}

export function fetchClerkUser(userId: string): Promise<ClerkUserRecord> {
  return clerkRequest<ClerkUserRecord>(`https://api.clerk.com/v1/users/${encodeURIComponent(userId)}`);
}

export async function listActiveClerkUsers(maxUsers = 10_000): Promise<{
  users: ClerkUserRecord[];
  truncated: boolean;
}> {
  const users: ClerkUserRecord[] = [];
  const pageSize = 500;
  for (let offset = 0; offset < maxUsers; offset += pageSize) {
    const params = new URLSearchParams({
      limit: String(Math.min(pageSize, maxUsers - offset)),
      offset: String(offset),
    });
    const page = await clerkRequest<ClerkUserRecord[]>(`https://api.clerk.com/v1/users?${params.toString()}`);
    users.push(...page);
    if (page.length < Math.min(pageSize, maxUsers - offset)) return { users, truncated: false };
  }
  const probe = new URLSearchParams({ limit: "1", offset: String(maxUsers) });
  const nextPage = await clerkRequest<ClerkUserRecord[]>(`https://api.clerk.com/v1/users?${probe.toString()}`);
  return { users, truncated: nextPage.length > 0 };
}

export async function findLegacyVerifiedClerkUsersByEmail(email: string): Promise<{
  users: ClerkUserRecord[];
  possiblyTruncated: boolean;
}> {
  const normalizedEmail = email.trim().toLowerCase();
  const secret = getLegacyClerkSecretKey();
  if (!secret) throw new ClerkApiError("Legacy Clerk credentials are not configured.");
  const params = new URLSearchParams();
  params.append("email_address[]", normalizedEmail);
  params.set("limit", "100");
  const users = await clerkRequestWithSecret<ClerkUserRecord[]>(
    `https://api.clerk.com/v1/users?${params.toString()}`,
    secret,
  );
  const matches = users.filter((user) => verifiedEmailAddresses(user).includes(normalizedEmail));
  return { users: matches, possiblyTruncated: users.length >= 100 };
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

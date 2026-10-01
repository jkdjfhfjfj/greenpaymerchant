export type MerchantPermission = "read" | "finance" | "owner";
export type MerchantTeamRole = "owner" | "finance" | "viewer";

export function roleCanAccess(role: MerchantTeamRole, permission: MerchantPermission): boolean {
  if (permission === "read") return role === "owner" || role === "finance" || role === "viewer";
  if (permission === "finance") return role === "owner" || role === "finance";
  return role === "owner";
}

export function invitationCanBeAccepted(input: {
  expiresAt: Date;
  acceptedAt: Date | null;
  revokedAt: Date | null;
  invitationEmail: string;
  verifiedEmail: string;
  now?: Date;
}): boolean {
  const now = input.now ?? new Date();
  return input.acceptedAt === null &&
    input.revokedAt === null &&
    input.expiresAt.getTime() > now.getTime() &&
    input.invitationEmail.trim().toLowerCase() === input.verifiedEmail.trim().toLowerCase();
}

export function merchantTenantMatches(membershipMerchantId: number, requestedMerchantId: number): boolean {
  return Number.isInteger(requestedMerchantId) && requestedMerchantId > 0 &&
    membershipMerchantId === requestedMerchantId;
}

export function canAcceptWorkspaceInvitation(existingMerchantId: number | null): boolean {
  return existingMerchantId === null;
}
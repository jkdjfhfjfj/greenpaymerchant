import { and, desc, eq, inArray } from "drizzle-orm";
import { Router, type IRouter, type RequestHandler } from "express";
import { getAuth } from "@clerk/express";
import {
  AcceptMerchantLegalPoliciesBody, AcceptMerchantLegalPoliciesResponse,
  GetCurrentLegalPoliciesResponse, GetMerchantLegalConsentResponse,
  ListAdminLegalPoliciesResponse, ListAdminLegalPolicyVersionsParams,
  ListAdminLegalPolicyVersionsResponse, LegalPolicyType,
  PublishAdminLegalPolicyParams, PublishAdminLegalPolicyResponse,
  SaveAdminLegalPolicyDraftBody, SaveAdminLegalPolicyDraftParams,
  SaveAdminLegalPolicyDraftResponse,
} from "@workspace/api-zod";
import {
  db, legalPoliciesTable, legalPolicyAcceptancesTable, legalPolicyTypes,
  legalPolicyVersionsTable,
} from "@workspace/db";
import { requireAdmin, requireSignedIn } from "../middlewares/requireAdmin";

const router: IRouter = Router();
function signedInUserId(req: Parameters<RequestHandler>[0], res: Parameters<RequestHandler>[1]): string | undefined {
  return (res.locals.clerkUserId as string | undefined) ?? getAuth(req).userId ?? undefined;
}
const defaults: Array<{ policyType: LegalPolicyType; slug: string; title: string }> = [
  { policyType: "privacy_policy", slug: "privacy", title: "Privacy Policy" },
  { policyType: "terms_of_service", slug: "terms", title: "Terms of Service" },
];

async function ensurePolicies() {
  for (const item of defaults) {
    await db.insert(legalPoliciesTable).values({
      policyType: item.policyType,
      slug: item.slug,
      draftTitle: item.title,
      draftContent: "",
    }).onConflictDoNothing();
  }
}

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function publicPolicy(row: typeof legalPoliciesTable.$inferSelect) {
  const published = Boolean(row.publishedVersion > 0 && row.publishedTitle?.trim() && row.publishedContent?.trim());
  return {
    policyType: row.policyType,
    slug: row.slug,
    title: published ? row.publishedTitle : null,
    content: published ? row.publishedContent : null,
    version: row.publishedVersion,
    publishedAt: iso(row.publishedAt),
    published,
  };
}

function adminPolicy(row: typeof legalPoliciesTable.$inferSelect) {
  return {
    policyType: row.policyType,
    slug: row.slug,
    draftTitle: row.draftTitle,
    draftContent: row.draftContent,
    publishedTitle: row.publishedTitle,
    publishedContent: row.publishedContent,
    publishedVersion: row.publishedVersion,
    draftUpdatedAt: row.draftUpdatedAt.toISOString(),
    publishedAt: iso(row.publishedAt),
    updatedBy: row.updatedBy,
  };
}

async function currentPolicies() {
  await ensurePolicies();
  const rows = await db.select().from(legalPoliciesTable);
  return defaults.map((item) => rows.find((row) => row.policyType === item.policyType)).filter(
    (row): row is typeof legalPoliciesTable.$inferSelect => Boolean(row),
  );
}

export function hasAcceptedCurrentLegalPolicyVersions(
  current: readonly { policyType: LegalPolicyType; publishedVersion: number }[],
  acceptances: readonly { policyType: LegalPolicyType; version: number }[],
): boolean {
  if (current.length !== legalPolicyTypes.length ||
      new Set(current.map((row) => row.policyType)).size !== legalPolicyTypes.length) {
    return false;
  }
  const currentVersions = new Map(current.map((row) => [row.policyType, row.publishedVersion]));
  const acceptedVersions = new Set(acceptances.map((row) => `${row.policyType}:${row.version}`));
  return legalPolicyTypes.every((type) => {
    const version = currentVersions.get(type);
    return version !== undefined && version > 0 && acceptedVersions.has(`${type}:${version}`);
  });
}

export const requireCurrentLegalAcceptance: RequestHandler = async (req, res, next) => {
  const userId = signedInUserId(req, res);
  if (!userId) { res.status(401).json({ error: "Sign in to access this workspace." }); return; }
  // requireAdmin marks the request after verifying the account's current admin role.
  // Admins must be able to enter operations before publishing or accepting legal policies.
  if (res.locals.isPlatformAdmin === true) { next(); return; }
  try {
    const rows = await currentPolicies();
    const current = rows.filter((row) => row.publishedVersion > 0 && row.publishedTitle?.trim() && row.publishedContent?.trim());
    if (current.length !== legalPolicyTypes.length) {
      res.status(428).json({ error: "Workspace access requires both published legal documents." });
      return;
    }
    const accepted = await db.select().from(legalPolicyAcceptancesTable).where(and(
      eq(legalPolicyAcceptancesTable.clerkUserId, userId),
      inArray(legalPolicyAcceptancesTable.policyType, [...legalPolicyTypes]),
    ));
    if (!hasAcceptedCurrentLegalPolicyVersions(current, accepted)) {
      res.status(428).json({ error: "Accept the current Privacy Policy and Terms of Service before using this workspace." });
      return;
    }
    next();
  } catch (error) {
    req.log.error({ err: error }, "Current legal acceptance could not be verified");
    res.status(503).json({ error: "Workspace access is paused while current legal acceptance is verified." });
  }
};

router.get("/public/legal-policies", async (_req, res): Promise<void> => {
  const rows = await currentPolicies();
  res.json(GetCurrentLegalPoliciesResponse.parse({ items: rows.map(publicPolicy) }));
});

router.get("/merchant/legal-consent", requireSignedIn, async (_req, res): Promise<void> => {
  const userId = signedInUserId(_req, res)!;
  const rows = await currentPolicies();
  const acceptedRows = await db.select().from(legalPolicyAcceptancesTable).where(and(
    eq(legalPolicyAcceptancesTable.clerkUserId, userId),
    inArray(legalPolicyAcceptancesTable.policyType, [...legalPolicyTypes]),
  ));
  const acceptedVersions = new Map<typeof legalPolicyTypes[number], number>();
  for (const row of acceptedRows) {
    if (row.version > (acceptedVersions.get(row.policyType) ?? 0)) acceptedVersions.set(row.policyType, row.version);
  }
  const policies = rows.map((row) => ({
    ...publicPolicy(row),
    acceptedVersion: acceptedVersions.get(row.policyType) ?? null,
  }));
  const ready = policies.length === legalPolicyTypes.length && policies.every((policy) => policy.published);
  const accepted = ready && policies.every((policy) => policy.acceptedVersion === policy.version);
  res.json(GetMerchantLegalConsentResponse.parse({ ready, accepted, policies }));
});

router.post("/merchant/legal-consent", requireSignedIn, async (req, res): Promise<void> => {
  const body = AcceptMerchantLegalPoliciesBody.safeParse(req.body ?? {});
  if (!body.success) { res.status(400).json({ error: body.error.message }); return; }
  const submitted = body.data.acceptances;
  if (submitted.length !== legalPolicyTypes.length ||
      new Set(submitted.map((item) => item.policyType)).size !== legalPolicyTypes.length ||
      legalPolicyTypes.some((type) => !submitted.some((item) => item.policyType === type))) {
    res.status(400).json({ error: "Accept both the Privacy Policy and Terms of Service." });
    return;
  }
  const userId = signedInUserId(req, res)!;
  const acceptedAt = await db.transaction(async (tx) => {
    const rows = await tx.select().from(legalPoliciesTable)
      .where(inArray(legalPoliciesTable.policyType, [...legalPolicyTypes]))
      .orderBy(legalPoliciesTable.policyType)
      .for("update");
    if (rows.length !== legalPolicyTypes.length || rows.some((row) =>
      !row.publishedTitle?.trim() || !row.publishedContent?.trim() || row.publishedVersion < 1)) {
      return null;
    }
    if (submitted.some((item) => rows.find((row) => row.policyType === item.policyType)?.publishedVersion !== item.version)) {
      return null;
    }
    const acceptedNow = new Date();
    for (const item of submitted) {
      await tx.insert(legalPolicyAcceptancesTable).values({
        clerkUserId: userId, policyType: item.policyType, version: item.version, acceptedAt: acceptedNow,
      }).onConflictDoNothing();
    }
    return acceptedNow.toISOString();
  });
  if (!acceptedAt) { res.status(409).json({ error: "The policy versions changed or are not ready. Reload and review the current documents." }); return; }
  res.json(AcceptMerchantLegalPoliciesResponse.parse({ accepted: true, acceptedAt }));
});

router.get("/admin/legal-policies", requireAdmin, async (_req, res): Promise<void> => {
  const rows = await currentPolicies();
  res.json(ListAdminLegalPoliciesResponse.parse({ items: rows.map(adminPolicy) }));
});

router.put("/admin/legal-policies/:type/draft", requireAdmin, async (req, res): Promise<void> => {
  const params = SaveAdminLegalPolicyDraftParams.safeParse(req.params);
  const body = SaveAdminLegalPolicyDraftBody.safeParse(req.body ?? {});
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  if (!body.success) { res.status(400).json({ error: body.error.message }); return; }
  await ensurePolicies();
  const userId = signedInUserId(req, res)!;
  const [row] = await db.update(legalPoliciesTable).set({
    draftTitle: body.data.title.trim(),
    draftContent: body.data.content.trim(),
    draftUpdatedAt: new Date(),
    updatedBy: userId,
  }).where(eq(legalPoliciesTable.policyType, params.data.type)).returning();
  if (!row) { res.status(404).json({ error: "Policy was not found." }); return; }
  res.json(SaveAdminLegalPolicyDraftResponse.parse(adminPolicy(row)));
});

router.post("/admin/legal-policies/:type/publish", requireAdmin, async (req, res): Promise<void> => {
  const params = PublishAdminLegalPolicyParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  await ensurePolicies();
  const userId = res.locals.clerkUserId as string;
  const row = await db.transaction(async (tx) => {
    const [draft] = await tx.select().from(legalPoliciesTable)
      .where(eq(legalPoliciesTable.policyType, params.data.type)).for("update").limit(1);
    if (!draft || !draft.draftTitle.trim() || !draft.draftContent.trim() ||
        (draft.draftTitle === draft.publishedTitle && draft.draftContent === draft.publishedContent)) return null;
    const version = draft.publishedVersion + 1;
    const publishedAt = new Date();
    await tx.insert(legalPolicyVersionsTable).values({
      policyType: draft.policyType,
      version,
      title: draft.draftTitle,
      content: draft.draftContent,
      publishedBy: userId,
      publishedAt,
    });
    const [updated] = await tx.update(legalPoliciesTable).set({
      publishedTitle: draft.draftTitle,
      publishedContent: draft.draftContent,
      publishedVersion: version,
      publishedAt,
      updatedBy: userId,
    }).where(eq(legalPoliciesTable.policyType, draft.policyType)).returning();
    return updated;
  });
  if (!row) { res.status(409).json({ error: "Save approved policy copy with changes before publishing." }); return; }
  res.json(PublishAdminLegalPolicyResponse.parse(adminPolicy(row)));
});

router.get("/admin/legal-policies/:type/versions", requireAdmin, async (req, res): Promise<void> => {
  const params = ListAdminLegalPolicyVersionsParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  await ensurePolicies();
  const rows = await db.select().from(legalPolicyVersionsTable)
    .where(eq(legalPolicyVersionsTable.policyType, params.data.type))
    .orderBy(desc(legalPolicyVersionsTable.version));
  res.json(ListAdminLegalPolicyVersionsResponse.parse({
    items: rows.map((row) => ({ ...row, publishedAt: row.publishedAt.toISOString() })),
  }));
});

export default router;
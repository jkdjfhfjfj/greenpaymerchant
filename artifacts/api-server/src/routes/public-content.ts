import { and, desc, eq, type SQL } from "drizzle-orm";
import { Router, type IRouter, type Request, type RequestHandler, type Response } from "express";
import {
  db,
  publicContentTable,
  publicContentVersionsTable,
  type PublicContentRecord,
} from "@workspace/db";
import { getAuth } from "@clerk/express";
import { requireAdmin } from "../middlewares/requireAdmin";
import {
  renderContentIndexPage,
  renderHelpPage,
  renderLlmsTxt,
  renderNotFoundPage,
  renderPublicContentPage,
  renderRobotsTxt,
  renderSitemapXml,
  type PublicContentDocument,
} from "../lib/public-content-render";

const contentApiRouter: IRouter = Router();
const publicSeoRouter: IRouter = Router();
const kinds = ["guide", "article", "faq"] as const;
const statuses = ["draft", "published"] as const;
type ContentKind = (typeof kinds)[number];
type ContentStatus = (typeof statuses)[number];
const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const noindexApiResponses: RequestHandler = (_req, res, next) => {
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  next();
};
type ContentInput = {
  kind: ContentKind;
  title: string;
  slug: string;
  summary: string;
  body: string;
  status?: ContentStatus;
};
type ContentUpdate = Partial<Omit<ContentInput, "status">> & { status?: "draft" };

const publicColumns = {
  id: publicContentTable.id,
  kind: publicContentTable.kind,
  status: publicContentTable.status,
  title: publicContentTable.title,
  slug: publicContentTable.slug,
  summary: publicContentTable.summary,
  body: publicContentTable.body,
  updatedAt: publicContentTable.updatedAt,
  publishedAt: publicContentTable.publishedAt,
};

function publicDocument(row: Pick<PublicContentRecord, "id" | "kind" | "status" | "title" | "slug" | "summary" | "body" | "updatedAt" | "publishedAt">): PublicContentDocument {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    title: row.title,
    slug: row.slug,
    summary: row.summary,
    body: row.body,
    updatedAt: row.updatedAt,
    publishedAt: row.publishedAt,
  };
}

function publicDto(row: PublicContentRecord) {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    slug: row.slug,
    summary: row.summary,
    body: row.body,
    updatedAt: row.updatedAt,
    publishedAt: row.publishedAt,
  };
}

function adminDto(row: PublicContentRecord) {
  return {
    ...publicDto(row),
    status: row.status,
    createdAt: row.createdAt,
    version: row.version,
    updatedBy: row.updatedBy,
  };
}

function adminId(req: Request): string {
  return getAuth(req).userId ?? "unknown-admin";
}

function setPrivateResponseHeaders(res: Response) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
}

function setPublicResponseHeaders(res: Response) {
  res.setHeader("Cache-Control", "public, max-age=0, s-maxage=60, stale-while-revalidate=30");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
}

function setHtmlHeaders(
  res: Response,
  status: number,
  indexable = true,
) {
  res.status(status);
  res.type("html");
  res.setHeader("Cache-Control", "public, max-age=0, s-maxage=60, stale-while-revalidate=30");
  res.setHeader("X-Robots-Tag", indexable ? "index, follow" : "noindex, nofollow");
}

function isUniqueSlugError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error as { code?: unknown }).code === "23505";
}

async function snapshotVersion(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  row: PublicContentRecord,
  createdBy: string,
): Promise<void> {
  await tx.insert(publicContentVersionsTable).values({
    contentId: row.id,
    version: row.version,
    kind: row.kind,
    status: row.status,
    title: row.title,
    slug: row.slug,
    summary: row.summary,
    body: row.body,
    createdBy,
  });
}

async function publishedDocuments(kind?: (typeof kinds)[number]): Promise<PublicContentDocument[]> {
  const conditions: SQL[] = [eq(publicContentTable.status, "published")];
  if (kind) conditions.push(eq(publicContentTable.kind, kind));
  const rows = await db.select(publicColumns).from(publicContentTable)
    .where(and(...conditions))
    .orderBy(desc(publicContentTable.updatedAt));
  return rows.map(publicDocument);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function boundedString(value: unknown, min: number, max: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length >= min && normalized.length <= max ? normalized : null;
}

function parseKind(value: unknown): ContentKind | null {
  return typeof value === "string" && (kinds as readonly string[]).includes(value) ? value as ContentKind : null;
}

function parseStatus(value: unknown): ContentStatus | null {
  return typeof value === "string" && (statuses as readonly string[]).includes(value) ? value as ContentStatus : null;
}

function parseSlug(value: unknown): string | null {
  const slug = boundedString(value, 1, 120);
  return slug && slugPattern.test(slug) ? slug : null;
}

function parseContentFields(source: Record<string, unknown>): { data?: ContentInput; error?: string } {
  const allowedFields = ["kind", "title", "slug", "summary", "body", "status"];
  if (Object.keys(source).some((key) => !allowedFields.includes(key))) {
    return { error: "Content request contains unsupported fields." };
  }
  const kind = parseKind(source.kind);
  const title = boundedString(source.title, 1, 160);
  const slug = parseSlug(source.slug);
  const summary = boundedString(source.summary, 1, 300);
  const body = boundedString(source.body, 1, 30000);
  if (!kind) return { error: "Content kind must be guide, article, or faq." };
  if (!title) return { error: "Title must contain 1–160 characters." };
  if (!slug) return { error: "Use a lowercase slug with letters, numbers, and single hyphens." };
  if (!summary) return { error: "Summary must contain 1–300 characters." };
  if (!body) return { error: "Body must contain 1–30,000 characters." };
  const status = source.status === undefined ? undefined : parseStatus(source.status);
  if (source.status !== undefined && !status) return { error: "Status must be draft or published." };
  return { data: { kind, title, slug, summary, body, ...(status ? { status } : {}) } };
}

function parseContentUpdate(source: Record<string, unknown>): { data?: ContentUpdate; error?: string } {
  const allowedFields = ["kind", "title", "slug", "summary", "body", "status"];
  if (Object.keys(source).some((key) => !allowedFields.includes(key))) {
    return { error: "Content update contains unsupported fields." };
  }
  if (source.status !== undefined && source.status !== "draft") {
    return { error: "Use the publish action to publish content." };
  }
  const data: ContentUpdate = {};
  if (source.status === "draft") data.status = "draft";
  if (source.kind !== undefined) {
    const kind = parseKind(source.kind);
    if (!kind) return { error: "Content kind must be guide, article, or faq." };
    data.kind = kind;
  }
  if (source.title !== undefined) {
    const title = boundedString(source.title, 1, 160);
    if (!title) return { error: "Title must contain 1–160 characters." };
    data.title = title;
  }
  if (source.slug !== undefined) {
    const slug = parseSlug(source.slug);
    if (!slug) return { error: "Use a lowercase slug with letters, numbers, and single hyphens." };
    data.slug = slug;
  }
  if (source.summary !== undefined) {
    const summary = boundedString(source.summary, 1, 300);
    if (!summary) return { error: "Summary must contain 1–300 characters." };
    data.summary = summary;
  }
  if (source.body !== undefined) {
    const body = boundedString(source.body, 1, 30000);
    if (!body) return { error: "Body must contain 1–30,000 characters." };
    data.body = body;
  }
  if (!Object.keys(data).length) return { error: "Provide at least one content field to update." };
  return { data };
}

function queryString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function parseIdParam(value: unknown): number | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== "string" || !/^[1-9]\d*$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) ? id : null;
}

function parseSlugParam(value: unknown): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === "string" && slugPattern.test(raw) ? raw : null;
}

contentApiRouter.use(noindexApiResponses);
contentApiRouter.use("/admin", (_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});

contentApiRouter.get("/public/content", async (req, res): Promise<void> => {
  const rawKind = queryString(req.query.kind);
  const kind = rawKind === undefined ? undefined : parseKind(rawKind);
  if (rawKind !== undefined && !kind) { res.status(400).json({ error: "Content kind must be guide, article, or faq." }); return; }
  const rows = await publishedDocuments(kind ?? undefined);
  setPublicResponseHeaders(res);
  res.json({ items: rows.map((row) => ({
    id: row.id, kind: row.kind, title: row.title, slug: row.slug,
    summary: row.summary, updatedAt: row.updatedAt,
  })) });
});

contentApiRouter.get("/public/content/:slug", async (req, res): Promise<void> => {
  const slug = parseSlugParam(req.params.slug);
  if (!slug) { res.status(404).json({ error: "Published content was not found." }); return; }
  const [row] = await db.select(publicColumns).from(publicContentTable).where(and(
    eq(publicContentTable.slug, slug),
    eq(publicContentTable.status, "published"),
  )).limit(1);
  if (!row) { res.status(404).json({ error: "Published content was not found." }); return; }
  setPublicResponseHeaders(res);
  res.json(publicDto(row as PublicContentRecord));
});

contentApiRouter.get("/admin/content", requireAdmin, async (req, res): Promise<void> => {
  const rawKind = queryString(req.query.kind);
  const rawStatus = queryString(req.query.status);
  const kind = rawKind === undefined ? undefined : parseKind(rawKind);
  const status = rawStatus === undefined ? undefined : parseStatus(rawStatus);
  if (rawKind !== undefined && !kind) { res.status(400).json({ error: "Content kind must be guide, article, or faq." }); return; }
  if (rawStatus !== undefined && !status) { res.status(400).json({ error: "Status must be draft or published." }); return; }
  const conditions: SQL[] = [];
  if (kind) conditions.push(eq(publicContentTable.kind, kind));
  if (status) conditions.push(eq(publicContentTable.status, status));
  const rows = await db.select().from(publicContentTable)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(publicContentTable.updatedAt));
  setPrivateResponseHeaders(res);
  res.json({ items: rows.map(adminDto) });
});

contentApiRouter.post("/admin/content", requireAdmin, async (req, res): Promise<void> => {
  const source = asRecord(req.body);
  const body = source ? parseContentFields(source) : { error: "Content request must be a JSON object." };
  if (!body.data) { res.status(400).json({ error: body.error ?? "Invalid content." }); return; }
  const actor = adminId(req);
  const now = new Date();
  try {
    const row = await db.transaction(async (tx) => {
      const [created] = await tx.insert(publicContentTable).values({
        kind: body.data!.kind,
        title: body.data!.title,
        slug: body.data!.slug,
        summary: body.data!.summary,
        body: body.data!.body,
        status: body.data!.status ?? "draft",
        createdBy: actor,
        updatedBy: actor,
        updatedAt: now,
        publishedAt: body.data!.status === "published" ? now : null,
      }).returning();
      await snapshotVersion(tx, created, actor);
      return created;
    });
    setPrivateResponseHeaders(res);
    res.status(201).json(adminDto(row));
  } catch (error) {
    if (isUniqueSlugError(error)) {
      res.status(409).json({ error: "That content slug is already in use. Choose another slug." });
      return;
    }
    throw error;
  }
});

contentApiRouter.patch("/admin/content/:id", requireAdmin, async (req, res): Promise<void> => {
  const id = parseIdParam(req.params.id);
  const source = asRecord(req.body);
  const body = source ? parseContentUpdate(source) : { error: "Content update must be a JSON object." };
  if (id === null || !body.data) {
    res.status(400).json({ error: id === null ? "Content ID must be a positive integer." : body.error ?? "Invalid content update." });
    return;
  }
  const actor = adminId(req);
  const now = new Date();
  try {
    const result = await db.transaction(async (tx) => {
      const [current] = await tx.select().from(publicContentTable)
        .where(eq(publicContentTable.id, id)).for("update").limit(1);
      if (!current) return null;
      const [updated] = await tx.update(publicContentTable).set({
        ...body.data,
        status: "draft",
        publishedAt: null,
        version: current.version + 1,
        updatedAt: now,
        updatedBy: actor,
      }).where(eq(publicContentTable.id, current.id)).returning();
      await snapshotVersion(tx, updated, actor);
      return updated;
    });
    if (!result) { res.status(404).json({ error: "Content entry was not found." }); return; }
    setPrivateResponseHeaders(res);
    res.json(adminDto(result));
  } catch (error) {
    if (isUniqueSlugError(error)) {
      res.status(409).json({ error: "That content slug is already in use. Choose another slug." });
      return;
    }
    throw error;
  }
});

async function changePublicationState(
  req: Request,
  res: Response,
  status: "draft" | "published",
): Promise<void> {
  const id = parseIdParam(req.params.id);
  if (id === null) { res.status(400).json({ error: "Content ID must be a positive integer." }); return; }
  const actor = adminId(req);
  const now = new Date();
  const updated = await db.transaction(async (tx) => {
    const [current] = await tx.select().from(publicContentTable)
      .where(eq(publicContentTable.id, id)).for("update").limit(1);
    if (!current) return null;
    if (current.status === status) return current;
    const [row] = await tx.update(publicContentTable).set({
      status,
      publishedAt: status === "published" ? current.publishedAt ?? now : null,
      version: current.version + 1,
      updatedAt: now,
      updatedBy: actor,
    }).where(eq(publicContentTable.id, current.id)).returning();
    await snapshotVersion(tx, row, actor);
    return row;
  });
  if (!updated) { res.status(404).json({ error: "Content entry was not found." }); return; }
  setPrivateResponseHeaders(res);
  res.json(adminDto(updated));
}

contentApiRouter.post("/admin/content/:id/publish", requireAdmin, async (req, res): Promise<void> => {
  await changePublicationState(req, res, "published");
});

contentApiRouter.post("/admin/content/:id/unpublish", requireAdmin, async (req, res): Promise<void> => {
  await changePublicationState(req, res, "draft");
});

contentApiRouter.get("/admin/content/:id/versions", requireAdmin, async (req, res): Promise<void> => {
  const id = parseIdParam(req.params.id);
  if (id === null) { res.status(400).json({ error: "Content ID must be a positive integer." }); return; }
  const versions = await db.select().from(publicContentVersionsTable)
    .where(eq(publicContentVersionsTable.contentId, id))
    .orderBy(desc(publicContentVersionsTable.version));
  setPrivateResponseHeaders(res);
  res.json({ items: versions });
});

function htmlResponse(res: Response, html: string, status = 200, indexable = true) {
  setHtmlHeaders(res, status, indexable);
  res.send(html);
}

publicSeoRouter.get("/learn", async (_req, res): Promise<void> => {
  const faqs = await publishedDocuments("faq");
  htmlResponse(res, renderHelpPage(faqs));
});

publicSeoRouter.get("/learn/:slug", async (req, res): Promise<void> => {
  const slug = parseSlugParam(req.params.slug);
  const [row] = slug ? await db.select(publicColumns).from(publicContentTable).where(and(
    eq(publicContentTable.slug, slug),
    eq(publicContentTable.kind, "faq"),
    eq(publicContentTable.status, "published"),
  )).limit(1) : [];
  if (!row) { htmlResponse(res, renderNotFoundPage(), 404, false); return; }
  htmlResponse(res, renderPublicContentPage(publicDocument(row)));
});

publicSeoRouter.get("/guides", async (_req, res): Promise<void> => {
  htmlResponse(res, renderContentIndexPage(await publishedDocuments("guide"), "guide"));
});

publicSeoRouter.get("/articles", async (_req, res): Promise<void> => {
  htmlResponse(res, renderContentIndexPage(await publishedDocuments("article"), "article"));
});

publicSeoRouter.get("/guides/:slug", async (req, res): Promise<void> => {
  const slug = parseSlugParam(req.params.slug);
  const [row] = slug ? await db.select(publicColumns).from(publicContentTable).where(and(
    eq(publicContentTable.slug, slug),
    eq(publicContentTable.kind, "guide"),
    eq(publicContentTable.status, "published"),
  )).limit(1) : [];
  if (!row) { htmlResponse(res, renderNotFoundPage(), 404, false); return; }
  htmlResponse(res, renderPublicContentPage(publicDocument(row)));
});

publicSeoRouter.get("/articles/:slug", async (req, res): Promise<void> => {
  const slug = parseSlugParam(req.params.slug);
  const [row] = slug ? await db.select(publicColumns).from(publicContentTable).where(and(
    eq(publicContentTable.slug, slug),
    eq(publicContentTable.kind, "article"),
    eq(publicContentTable.status, "published"),
  )).limit(1) : [];
  if (!row) { htmlResponse(res, renderNotFoundPage(), 404, false); return; }
  htmlResponse(res, renderPublicContentPage(publicDocument(row)));
});

publicSeoRouter.get("/sitemap.xml", async (_req, res): Promise<void> => {
  const rows = await db.select({
    id: publicContentTable.id,
    kind: publicContentTable.kind,
    status: publicContentTable.status,
    title: publicContentTable.title,
    slug: publicContentTable.slug,
    summary: publicContentTable.summary,
    body: publicContentTable.body,
    updatedAt: publicContentTable.updatedAt,
    publishedAt: publicContentTable.publishedAt,
  }).from(publicContentTable).where(eq(publicContentTable.status, "published"));
  res.setHeader("Cache-Control", "public, max-age=0, s-maxage=60, stale-while-revalidate=30");
  res.removeHeader("X-Robots-Tag");
  res.type("application/xml; charset=utf-8").send(renderSitemapXml(rows.map(publicDocument)));
});

publicSeoRouter.get("/robots.txt", (_req, res): void => {
  res.setHeader("Cache-Control", "public, max-age=0, must-revalidate");
  res.type("text/plain; charset=utf-8").send(renderRobotsTxt());
});

publicSeoRouter.get("/llms.txt", async (_req, res): Promise<void> => {
  const docs = await publishedDocuments();
  res.setHeader("Cache-Control", "public, max-age=0, s-maxage=60, stale-while-revalidate=30");
  res.type("text/plain; charset=utf-8").send(renderLlmsTxt(docs));
});

export { contentApiRouter, publicSeoRouter };
export default contentApiRouter;
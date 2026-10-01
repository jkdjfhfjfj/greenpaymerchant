export type PublicContentDocument = {
  id: number;
  kind: "guide" | "article" | "faq";
  status: "draft" | "published";
  title: string;
  slug: string;
  summary: string;
  body: string;
  updatedAt: Date | string;
  publishedAt: Date | string | null;
};

export const greenpayFaqs = [
  {
    question: "When is a Greenpay payment receipt confirmed?",
    answer: "A Greenpay receipt is available only after the transaction has a paid timestamp and a successful or refunded status. Pending payments are not confirmed receipts. A refunded transaction is labeled as refunded, not as an unchanged successful payment.",
  },
  {
    question: "What does a verified settlement wallet balance mean?",
    answer: "A wallet balance changes when Greenpay reconciles an eligible settlement using settlement evidence. A pending settlement, a forecast, or a T+3 estimate is not wallet funding. Payout requests can reserve available wallet funds while they are being processed.",
  },
  {
    question: "Does an invoice mean the customer has paid?",
    answer: "No. An invoice records an amount due; it is not proof that money arrived. Check the invoice's separately recorded paid amount and linked payment status. Greenpay counts paid amounts from successful or refunded transactions and subtracts confirmed customer refunds.",
  },
  {
    question: "Does requesting a refund mean money has been returned?",
    answer: "No. A refund request or pending refund is not confirmed customer reimbursement. Treat money as returned only when the refund record reaches a customer-reimbursed state; an unresolved refund can require reconciliation before settlement funding.",
  },
  {
    question: "Which roles can a merchant team member have?",
    answer: "Greenpay merchant invitations assign either the finance or viewer role. The merchant owner manages invitations and can change or remove active team access. Team members must sign in with the verified email address invited to the workspace.",
  },
] as const;

const siteName = "Greenpay";
const canonicalSiteUrl = (configured?: string) => {
  const base = configured?.trim() || process.env.PUBLIC_SITE_URL?.trim() || "https://empty-project.replit.app";
  return new URL(base).origin;
};

export function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]!);
}

function safeJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
}

function isoDate(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function paragraphs(value: string): string {
  return value
    .split(/\r?\n\s*\r?\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\r?\n/g, "<br>")}</p>`)
    .join("\n");
}

function websiteStructuredData(base: string) {
  return [
    {
      "@context": "https://schema.org",
      "@type": "Organization",
      "@id": `${base}/#organization`,
      name: siteName,
      url: `${base}/`,
    },
    {
      "@context": "https://schema.org",
      "@type": "WebSite",
      "@id": `${base}/#website`,
      name: siteName,
      url: `${base}/`,
      publisher: { "@id": `${base}/#organization` },
    },
  ];
}

function pageDocument(input: {
  title: string;
  description: string;
  path: string;
  base: string;
  type?: string;
  structuredData?: unknown[];
  content: string;
  robots?: string;
}): string {
  const canonical = new URL(input.path, `${input.base}/`).toString();
  const escapedTitle = escapeHtml(input.title);
  const escapedDescription = escapeHtml(input.description);
  const data = [...websiteStructuredData(input.base), ...(input.structuredData ?? [])];
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapedTitle}</title>
<meta name="description" content="${escapedDescription}">
<meta name="robots" content="${escapeHtml(input.robots ?? "index, follow")}">
<link rel="canonical" href="${escapeHtml(canonical)}">
<meta property="og:site_name" content="${siteName}">
<meta property="og:title" content="${escapedTitle}">
<meta property="og:description" content="${escapedDescription}">
<meta property="og:url" content="${escapeHtml(canonical)}">
<meta property="og:type" content="${escapeHtml(input.type ?? "website")}">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${escapedTitle}">
<meta name="twitter:description" content="${escapedDescription}">
<script type="application/ld+json">${safeJson(data)}</script>
<style>
:root{color-scheme:light;--green:#203d36;--green2:#294c43;--gold:#e5b865;--paper:#fffdf8;--cream:#f6f3ea;--ink:#263d37;--muted:#6b7c76}*{box-sizing:border-box}body{margin:0;background:var(--cream);color:var(--ink);font:16px/1.7 'DM Sans',system-ui,sans-serif}.site-header{background:var(--green);color:var(--paper);padding:18px clamp(18px,5vw,72px);display:flex;align-items:center;justify-content:space-between;gap:20px}.brand{font-weight:700;font-size:20px;letter-spacing:-.03em;color:inherit;text-decoration:none}.brand b{color:var(--gold)}nav{display:flex;gap:20px;flex-wrap:wrap}nav a,.breadcrumbs a,.site-footer a{color:inherit;text-decoration:none}nav a:hover,.breadcrumbs a:hover,.site-footer a:hover{text-decoration:underline}.page{width:min(920px,calc(100% - 36px));margin:0 auto;padding:50px 0 72px}.breadcrumbs{font-size:14px;color:var(--muted);margin-bottom:24px}.breadcrumbs a{color:var(--green2)}h1{font-size:clamp(36px,6vw,58px);line-height:1.08;letter-spacing:-.04em;margin:0 0 18px;color:var(--green)}.lead{font-size:19px;line-height:1.55;color:#53665f;max-width:70ch;margin:0 0 24px}.updated{font-size:13px;color:var(--muted)}article{background:var(--paper);border:1px solid #e4e1d7;border-radius:20px;padding:clamp(22px,5vw,42px);margin-top:28px}article p{margin:0 0 1.15em;max-width:75ch}article p:last-child{margin-bottom:0}.faq-list{display:grid;gap:12px;margin:28px 0}.faq-list details,.content-links a{background:var(--paper);border:1px solid #e4e1d7;border-radius:14px;padding:18px 20px}.faq-list summary{font-weight:700;color:var(--green);cursor:pointer}.faq-list p{margin:10px 0 0}.content-links{display:grid;gap:10px;margin-top:32px}.content-links a{display:block;color:var(--green);font-weight:700;text-decoration:none}.content-links a:hover{border-color:var(--gold)}.content-links span{display:block;color:var(--muted);font-weight:400;font-size:14px;margin-top:3px}.site-footer{background:var(--green);color:var(--paper);padding:24px clamp(18px,5vw,72px);display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;font-size:14px}.not-found{min-height:70vh;display:grid;place-content:center;text-align:center}.not-found p{color:var(--muted)}
@media(max-width:640px){.site-header{align-items:flex-start;flex-direction:column}.page{padding-top:34px}.lead{font-size:17px}nav{gap:14px}}
</style>
</head>
<body>
<header class="site-header"><a class="brand" href="/" aria-label="Greenpay home">Green<b>pay</b></a><nav aria-label="Primary"><a href="/learn">Help &amp; FAQs</a><a href="/guides">Guides</a><a href="/articles">Articles</a><a href="/contact">Contact support</a><a href="/sign-in">Sign in</a><a href="/admin/content">Content admin</a></nav></header>
${input.content}
<footer class="site-footer"><a class="brand" href="/">Green<b>pay</b></a><span>Payment records that distinguish requests, forecasts and confirmed money.</span><a href="/learn">Help center</a><a href="/contact">Contact support</a><a href="/admin/content">Content admin</a><a href="${escapeHtml(`${input.base}/`)}" aria-label="Powered by ${siteName} — visit homepage">Powered by ${siteName}</a></footer>
</body></html>`;
}

function published(document: PublicContentDocument): boolean {
  return document.status === "published" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(document.slug);
}

export function renderPublicContentPage(
  document: PublicContentDocument,
  baseUrl?: string,
): string {
  if (!published(document)) return renderNotFoundPage(baseUrl);
  const base = canonicalSiteUrl(baseUrl);
  const path = document.kind === "faq"
    ? `/learn/${document.slug}`
    : `/${document.kind === "guide" ? "guides" : "articles"}/${document.slug}`;
  const publishedAt = isoDate(document.publishedAt);
  const updatedAt = isoDate(document.updatedAt);
  const structuredData = [
    {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Greenpay", item: `${base}/` },
        { "@type": "ListItem", position: 2, name: document.kind === "faq" ? "Help" : document.kind === "guide" ? "Guides" : "Articles", item: `${base}/${document.kind === "faq" ? "help" : document.kind === "guide" ? "guides" : "articles"}` },
        { "@type": "ListItem", position: 3, name: document.title, item: `${base}${path}` },
      ],
    },
    {
      "@context": "https://schema.org",
      "@type": "Article",
      headline: document.title,
      description: document.summary,
      mainEntityOfPage: `${base}${path}`,
      datePublished: publishedAt,
      dateModified: updatedAt,
      publisher: { "@id": `${base}/#organization` },
      author: { "@type": "Organization", name: siteName, url: `${base}/` },
    },
  ];
  const content = `<main class="page"><div class="breadcrumbs"><a href="/">Greenpay</a> / <a href="${document.kind === "faq" ? "/learn" : document.kind === "guide" ? "/guides" : "/articles"}">${document.kind === "faq" ? "Help" : document.kind === "guide" ? "Guides" : "Articles"}</a> / ${escapeHtml(document.title)}</div><article><h1>${escapeHtml(document.title)}</h1><p class="lead">${escapeHtml(document.summary)}</p>${updatedAt ? `<p class="updated">Updated <time datetime="${escapeHtml(updatedAt)}">${escapeHtml(updatedAt.slice(0, 10))}</time></p>` : ""}<div class="content-body">${paragraphs(document.body)}</div></article><p><a href="/learn">Browse Greenpay help and FAQs</a></p></main>`;
  return pageDocument({
    title: `${document.title} | Greenpay`,
    description: document.summary,
    path,
    base,
    type: "article",
    structuredData,
    content,
  });
}

export function renderHelpPage(
  faqDocuments: PublicContentDocument[],
  baseUrl?: string,
): string {
  const base = canonicalSiteUrl(baseUrl);
  const faqs = faqDocuments.filter((document) => published(document) && document.kind === "faq");
  const faqSchema = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: greenpayFaqs.map((item) => ({
      "@type": "Question",
      name: item.question,
      acceptedAnswer: { "@type": "Answer", text: item.answer },
    })),
  };
  const dynamicFaqs = faqs.map((faq) => `<li class="content-links"><a href="/learn/${encodeURIComponent(faq.slug)}">${escapeHtml(faq.title)}<span>${escapeHtml(faq.summary)}</span></a></li>`).join("");
  const staticFaqHtml = greenpayFaqs.map((item) => `<details><summary>${escapeHtml(item.question)}</summary><p>${escapeHtml(item.answer)}</p></details>`).join("");
  const content = `<main class="page"><div class="breadcrumbs"><a href="/">Greenpay</a> / Help center</div><h1>Greenpay help and payment FAQs</h1><p class="lead">Clear answers about payment receipts, verified settlement wallet balances, invoices, refunds and merchant team permissions. Greenpay distinguishes confirmed money from requests and estimates.</p><section aria-labelledby="common-questions"><h2 id="common-questions">Common questions about Greenpay payments</h2><div class="faq-list">${staticFaqHtml}</div></section>${faqs.length ? `<section aria-labelledby="more-help"><h2 id="more-help">More help articles</h2><ul class="content-links">${dynamicFaqs}</ul></section>` : ""}<section aria-labelledby="browse-guides"><h2 id="browse-guides">Guides and articles</h2><p>See <a href="/guides">Greenpay guides</a> and <a href="/articles">articles</a> for more product information.</p></section></main>`;
  return pageDocument({
    title: "Greenpay Help & Payment FAQs",
    description: "Get factual answers about Greenpay confirmed receipts, verified settlement wallet balances, invoices, refunds, and team permissions.",
    path: "/learn",
    base,
    structuredData: [faqSchema, {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Greenpay", item: `${base}/` },
        { "@type": "ListItem", position: 2, name: "Help", item: `${base}/learn` },
      ],
    }],
    content,
  });
}

export function renderContentIndexPage(
  documents: PublicContentDocument[],
  kind: "guide" | "article",
  baseUrl?: string,
): string {
  const base = canonicalSiteUrl(baseUrl);
  const rows = documents.filter((item) => published(item) && item.kind === kind);
  const label = kind === "guide" ? "Guides" : "Articles";
  const links = rows.map((item) => `<a href="/${kind === "guide" ? "guides" : "articles"}/${encodeURIComponent(item.slug)}">${escapeHtml(item.title)}<span>${escapeHtml(item.summary)}</span></a>`).join("");
  const content = `<main class="page"><div class="breadcrumbs"><a href="/">Greenpay</a> / ${label}</div><h1>Greenpay ${label.toLowerCase()}</h1><p class="lead">Factual information about Greenpay payment records and the steps that connect collections, settlement and payouts.</p><div class="content-links">${links || "<p>New Greenpay guides will appear here when published.</p>"}</div><p><a href="/learn">Visit Greenpay help and FAQs</a></p></main>`;
  return pageDocument({
    title: `Greenpay ${label} | Payment operations`,
    description: `Published Greenpay ${label.toLowerCase()} explain payment records, settlement and finance workflows.`,
    path: kind === "guide" ? "/guides" : "/articles",
    base,
    content,
    structuredData: [{
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Greenpay", item: `${base}/` },
        { "@type": "ListItem", position: 2, name: label, item: `${base}/${kind === "guide" ? "guides" : "articles"}` },
      ],
    }],
  });
}

export function renderNotFoundPage(baseUrl?: string): string {
  const base = canonicalSiteUrl(baseUrl);
  return pageDocument({
    title: "Page not found | Greenpay",
    description: "This Greenpay public content page is not available.",
    path: "/404",
    base,
    robots: "noindex, nofollow",
    content: `<main class="page not-found"><h1>Page not found</h1><p>This Greenpay page may be unpublished or the address may be incorrect.</p><p><a href="/learn">Browse published help</a></p></main>`,
  });
}

export function renderSitemapXml(documents: PublicContentDocument[], baseUrl?: string): string {
  const base = canonicalSiteUrl(baseUrl);
  const urls = [
    { path: "/", updatedAt: null as string | null },
    { path: "/learn", updatedAt: null as string | null },
    { path: "/guides", updatedAt: null as string | null },
    { path: "/articles", updatedAt: null as string | null },
    ...documents.filter(published).map((document) => ({
      path: document.kind === "faq"
        ? `/learn/${document.slug}`
        : `/${document.kind === "guide" ? "guides" : "articles"}/${document.slug}`,
      updatedAt: isoDate(document.updatedAt),
    })),
  ];
  const xmlEscape = (value: string) => escapeHtml(value);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map((item) => `<url><loc>${xmlEscape(new URL(item.path, `${base}/`).toString())}</loc>${item.updatedAt ? `<lastmod>${xmlEscape(item.updatedAt)}</lastmod>` : ""}</url>`).join("")}</urlset>`;
}

export function renderRobotsTxt(baseUrl?: string): string {
  const base = canonicalSiteUrl(baseUrl);
  return `User-agent: *\nAllow: /\nDisallow: /api\nDisallow: /admin\nDisallow: /merchant\nDisallow: /customers\nDisallow: /transactions\nDisallow: /invoices\nDisallow: /receipts\nDisallow: /payment-links\nDisallow: /wallets\nDisallow: /payouts\nDisallow: /payout-requests\nDisallow: /team\nDisallow: /pay\nDisallow: /receipt\nDisallow: /status\nDisallow: /sign-in\nDisallow: /sign-up\nDisallow: /profile\nDisallow: /notifications\nDisallow: /statements\nDisallow: /cases\nDisallow: /developers\nDisallow: /settings\nDisallow: /operations\nDisallow: /settlements\nDisallow: /support\nDisallow: /exchange\nDisallow: /webhooks\nSitemap: ${base}/sitemap.xml\n`;
}

export function renderLlmsTxt(documents: PublicContentDocument[], baseUrl?: string): string {
  const base = canonicalSiteUrl(baseUrl);
  const markdownText = (value: string) => value
    .replace(/[\r\n]+/g, " ")
    .replace(/\\/g, "\\\\")
    .replaceAll("[", "\\[")
    .replaceAll("]", "\\]")
    .replaceAll("(", "\\(")
    .replaceAll(")", "\\)");
  const links = documents.filter(published).map((document) => {
    const path = document.kind === "faq"
      ? `/learn/${document.slug}`
      : `/${document.kind === "guide" ? "guides" : "articles"}/${document.slug}`;
    return `- [${markdownText(document.title)}](${base}${path}): ${markdownText(document.summary)}`;
  });
  return [
    "# Greenpay",
    "",
    "> Greenpay provides payment collection tools and records for merchants. Public documentation distinguishes confirmed transactions and settlement evidence from pending requests and forecasts.",
    "",
    "## Public help",
    `- [Help and payment FAQs](${base}/learn): Answers about confirmed receipts, verified settlement wallet balances, invoices, refunds, and merchant team roles.`,
    ...links,
    "",
    "## Important distinctions",
    "- A pending payment is not a confirmed receipt.",
    "- A settlement forecast is not verified wallet funding.",
    "- An invoice is not proof of payment.",
    "- A refund request is not confirmed customer reimbursement.",
    "",
  ].join("\n");
}
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  renderHelpPage,
  renderLlmsTxt,
  renderPublicContentPage,
  renderRobotsTxt,
  renderSitemapXml,
  type PublicContentDocument,
} from "./public-content-render";

const productionBase = "https://empty-project.replit.app";
const published: PublicContentDocument = {
  id: 4,
  kind: "article",
  status: "published",
  title: "Greenpay confirmed payment records",
  slug: "confirmed-payment-records",
  summary: "A pending payment is not a confirmed Greenpay receipt.",
  body: "A receipt is available only after successful provider confirmation.\n\n<script>alert('not executable')</script>",
  updatedAt: "2026-05-10T12:00:00.000Z",
  publishedAt: "2026-05-09T12:00:00.000Z",
};
const draft: PublicContentDocument = {
  ...published,
  id: 5,
  title: "Private draft with customer@example.test",
  slug: "private-draft-customer-ref-12345",
  body: "Do not disclose payment reference GP-PRIVATE-12345.",
  status: "draft",
};

test("published content is crawlable raw HTML with route-specific SEO and JSON-LD", () => {
  const html = renderPublicContentPage(published, productionBase);
  assert.match(html, /<!doctype html>/i);
  assert.match(html, /<title>Greenpay confirmed payment records \| Greenpay<\/title>/);
  assert.match(html, /name="description" content="A pending payment is not a confirmed Greenpay receipt\."/);
  assert.match(html, /property="og:title" content="Greenpay confirmed payment records \| Greenpay"/);
  assert.match(html, /property="og:url" content="https:\/\/empty-project\.replit\.app\/articles\/confirmed-payment-records"/);
  assert.match(html, /rel="canonical" href="https:\/\/empty-project\.replit\.app\/articles\/confirmed-payment-records"/);
  assert.match(html, /"@type":"Organization"/);
  assert.match(html, /"@type":"WebSite"/);
  assert.match(html, /"@type":"Article"/);
  assert.match(html, /"@type":"BreadcrumbList"/);
  assert.match(html, /A receipt is available only after successful provider confirmation\./);
  assert.match(html, /href="\/learn">Help &amp; FAQs/);
  assert.match(html, /href="\/contact">Contact support/);
  assert.match(html, /href="\/sign-in">Sign in/);
  assert.match(html, /href="\/admin\/content">Content admin/);
  assert.match(html, /&lt;script&gt;alert\(&#39;not executable&#39;\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>alert\(/i);
  assert.doesNotMatch(html, /type="module"|id="root"/i);
});

test("drafts and private references are absent from help, sitemap and llms output", () => {
  const help = renderHelpPage([{ ...published, kind: "faq", slug: "published-payment-faq" }, draft], productionBase);
  const sitemap = renderSitemapXml([{ ...published, kind: "faq", slug: "published-payment-faq" }, draft], productionBase);
  const llms = renderLlmsTxt([{ ...published, kind: "faq", slug: "published-payment-faq" }, draft], productionBase);
  assert.match(help, /When is a Greenpay payment receipt confirmed\?/);
  assert.match(help, /published-payment-faq/);
  assert.doesNotMatch(help, /Private draft|customer@example\.test|GP-PRIVATE-12345/);
  assert.match(sitemap, /https:\/\/empty-project\.replit\.app\/learn\/published-payment-faq/);
  assert.match(sitemap, /https:\/\/empty-project\.replit\.app\/guides/);
  assert.match(sitemap, /https:\/\/empty-project\.replit\.app\/articles/);
  assert.doesNotMatch(sitemap, /private-draft|GP-PRIVATE|customer@example|\/admin|\/receipt\/12345/);
  assert.match(llms, /published-payment-faq/);
  assert.doesNotMatch(llms, /private-draft|GP-PRIVATE|customer@example/);
});

test("unpublished direct requests return noindex HTML without exposing the draft copy", () => {
  const html = renderPublicContentPage(draft, productionBase);
  assert.match(html, /<meta name="robots" content="noindex, nofollow">/);
  assert.match(html, /Page not found/);
  assert.doesNotMatch(html, /Private draft|customer@example\.test|GP-PRIVATE-12345/);
});

test("robots advertises only the verified production sitemap and excludes account surfaces", () => {
  const robots = renderRobotsTxt(productionBase);
  assert.match(robots, /Sitemap: https:\/\/empty-project\.replit\.app\/sitemap\.xml/);
  assert.match(robots, /Disallow: \/api/);
  assert.match(robots, /Disallow: \/invoices/);
  assert.match(robots, /Disallow: \/receipt/);
  assert.doesNotMatch(robots, /\.replit\.dev|localhost/);
});

test("llms text keeps editor-supplied Markdown from creating injected links or sections", () => {
  const llms = renderLlmsTxt([{
    ...published,
    title: "[Editor text](not-a-route)",
    summary: "A factual summary.\n- [Injected link](javascript:alert(1))",
  }], productionBase);
  assert.match(llms, /\\\[Editor text\\\]\\\(not-a-route\\\)/);
  assert.doesNotMatch(llms, /\n- \[Injected link\]/);
});
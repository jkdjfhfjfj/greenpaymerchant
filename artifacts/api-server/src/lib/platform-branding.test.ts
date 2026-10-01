import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanPublicUrl, normalizeWhatsAppContact } from "./platform-branding";

test("branding image URLs are canonical HTTPS addresses and can be cleared", () => {
  assert.equal(cleanPublicUrl(" https://cdn.example/logo.svg ", "Logo URL"), "https://cdn.example/logo.svg");
  assert.equal(cleanPublicUrl("http://localhost:5173/favicon.svg", "Favicon URL"), "http://localhost:5173/favicon.svg");
  assert.equal(cleanPublicUrl(null, "Logo URL"), null);
  assert.equal(cleanPublicUrl(undefined, "Logo URL"), undefined);
  assert.equal(cleanPublicUrl("  ", "Logo URL"), null);
});

test("branding URLs reject unsafe protocols, credentials, and malformed values", () => {
  assert.throws(() => cleanPublicUrl("javascript:alert(1)", "Logo URL"), /must use HTTPS/);
  assert.throws(() => cleanPublicUrl("http://cdn.example/logo.svg", "Logo URL"), /must use HTTPS/);
  assert.throws(() => cleanPublicUrl("https://user:password@cdn.example/logo.svg", "Logo URL"), /cannot contain credentials/);
  assert.throws(() => cleanPublicUrl("/relative/logo.svg", "Logo URL"), /complete URL/);
  assert.throws(() => cleanPublicUrl("https://cdn.example/logo.svg?token=private", "Logo URL"), /query parameters/);
});

test("WhatsApp contact accepts validated international numbers and wa.me URLs only", () => {
  assert.equal(normalizeWhatsAppContact("+254 712-345-678"), "+254712345678");
  assert.equal(normalizeWhatsAppContact("https://wa.me/254712345678/"), "https://wa.me/254712345678");
  assert.equal(normalizeWhatsAppContact(""), "");
  assert.throws(() => normalizeWhatsAppContact("support@example.invalid"), /international phone number/);
  assert.throws(() => normalizeWhatsAppContact("https://example.invalid/254712345678"), /international phone number/);
});
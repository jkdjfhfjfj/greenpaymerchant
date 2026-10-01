import assert from "node:assert/strict";
import test from "node:test";
import { allowContactSubmission, boundedText, categoryOf, redactSupportText, validEmail } from "./support-rules.ts";

test("contact input trims text and rejects out-of-contract lengths", () => {
  assert.equal(boundedText("   Hello  ", 1, 10), "Hello");
  assert.equal(boundedText(" ", 1, 10), null);
  assert.equal(boundedText("too long", 1, 3), null);
  assert.equal(validEmail("  Person@Example.com "), "person@example.com");
  assert.equal(validEmail("not-an-email"), null);
  assert.equal(categoryOf(undefined), "other");
  assert.equal(categoryOf("unrecognized"), null);
});

test("public contact requests are rate limited per IP with a reset window", () => {
  const ip = `support-test-${Date.now()}`;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    assert.equal(allowContactSubmission(ip, 1_000), true);
  }
  assert.equal(allowContactSubmission(ip, 1_001), false);
  assert.equal(allowContactSubmission(ip, 601_001), true);
});

test("support content redacts submitted credentials before storing messages", () => {
  assert.equal(
    redactSupportText("API key=super-secret sk_live_private Bearer abc.def"),
    "API key=[REDACTED] [REDACTED KEY] Bearer [REDACTED]",
  );
});
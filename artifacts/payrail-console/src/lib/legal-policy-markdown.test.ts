import assert from "node:assert/strict";
import { test } from "node:test";
import { parseLegalInline, parseLegalMarkdown } from "./legal-policy-markdown";

test("legal Markdown becomes semantic blocks without changing policy wording", () => {
  const source = [
    "Drafting a **Terms of Service (ToS)** agreement.",
    "",
    "---",
    "",
    "### 1. Essential Clauses",
    "",
    "* **Account registration:** users provide accurate information.",
    "* Review all requirements.",
    "",
    "1. First step",
    "2. Second step",
  ].join("\n");
  const blocks = parseLegalMarkdown(source);

  assert.deepEqual(blocks.map((block) => block.type), [
    "paragraph", "rule", "heading", "unordered-list", "ordered-list",
  ]);
  assert.equal(blocks[0].type, "paragraph");
  if (blocks[0].type === "paragraph") {
    assert.deepEqual(blocks[0].children[0], { type: "text", value: "Drafting a " });
    assert.deepEqual(blocks[0].children[1], {
      type: "strong",
      children: [{ type: "text", value: "Terms of Service (ToS)" }],
    });
  }
  assert.equal(blocks[2].type === "heading" ? blocks[2].level : -1, 3);
  assert.equal(blocks[3].type === "unordered-list" ? blocks[3].items.length : -1, 2);
  assert.equal(blocks[4].type === "ordered-list" ? blocks[4].start : -1, 1);
});

test("unsafe Markdown links remain literal text", () => {
  const source = "[open](javascript:alert(1))";
  const parts = parseLegalInline(source);
  assert.equal(parts.map((part) => part.type === "text" ? part.value : "").join(""), source);
  assert.ok(parts.every((part) => part.type === "text"));
});
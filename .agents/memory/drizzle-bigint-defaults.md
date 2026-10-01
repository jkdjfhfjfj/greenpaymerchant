---
name: Drizzle BigInt defaults
description: Avoid JavaScript BigInt literals in schema defaults that drizzle-kit must serialize.
---

Use SQL numeric literals for database defaults on BigInt-mode columns; do not pass native JavaScript BigInt values as schema defaults.

**Why:** The development schema push failed with “Do not know how to serialize a BigInt” when defaults used native `0n`. Runtime BigInt mapping was valid, but drizzle-kit's schema serialization was not.

**How to apply:** Keep BigInt runtime types for precise ledger arithmetic while declaring zero defaults with SQL `0`. Verify development schema tooling after introducing BigInt columns; do not work around this by using startup or production DDL.
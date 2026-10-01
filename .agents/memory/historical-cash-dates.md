---
name: Historical cash dates
description: Why legacy financial dates must remain explicitly approximate rather than being backfilled as confirmed cash dates.
---

Do not backfill a historical confirmation timestamp from a creation timestamp without authoritative provider evidence. Report a clearly labeled legacy-date fallback instead.

**Why:** Historical records did not retain their confirmation times. Copying creation dates into confirmation fields would invent financial facts. Requests and actual completion can also fall in different months, so request-based totals can count the same payout twice.

**How to apply:** Stamp new authoritative confirmation transitions once, in their financial transaction. Use confirmation/completion dates for monthly money totals. Keep request-date operational history separate, and retain explicit date-basis labels in statements and exports.
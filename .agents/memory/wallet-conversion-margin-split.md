---
name: Wallet conversion markup allocation
description: How wallet quotes split a combined conversion markup into system margin and merchant schedule markup.
---

Calculate wallet conversion economics using the combined markup once, then allocate the rounded combined markup amount proportionally between system margin and merchant schedule markup using their configured basis points. Do not apply those two components sequentially.

**Why:** Sequential markups change the effective rate, while displaying separately rounded components can make the quote and journal totals disagree. Proportional allocation preserves the combined effective rate and lets every amount reconcile in integer minor units.

**How to apply:** When adding or changing conversion breakdowns, derive the displayed split from the combined markup amount, keep fee calculation distinct, and test that target amount + fee + both markup components equals the market amount and that each journal balances.
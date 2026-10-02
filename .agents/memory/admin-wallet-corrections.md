---
name: Admin wallet corrections
description: Accounting and safety rules for platform-admin credits and debits to merchant wallets.
---

Manual wallet corrections must be separate from settlement confirmation and use a balanced, append-only journal entry with a stable idempotency key, admin identity, and required reason. Debits may reduce available funds only; they must not consume reserved amounts or alter historical collections, refunds, or settlements.

**Why:** Wallet balances are projections of financial records. Changing a balance without a matching ledger entry breaks reconciliation, while rewriting settlement history obscures the source of funds.

**How to apply:** For future manual corrections, lock the merchant/currency wallet, post the balanced journal and audit record atomically, then update the available-balance projection. Keep settlement funding tied to provider-confirmed evidence.
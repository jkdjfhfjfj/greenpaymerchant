---
name: Airtime funding recovery
description: Strict provider evidence and safe administrator recovery for merchant M-Pesa airtime-wallet top-ups.
---

PayHero status responses must remain untrusted until authoritative documentation or verified sandbox examples establish the success values and evidence fields. Automatic credits must continue to match the top-up reference, exact amount, and KES currency; reconciliation failures should be visible without changing the balance.

**Why:** The provider's status-response shape has not been verified, and broadening success handling could credit the wrong merchant or amount.

**How to apply:** Before changing PayHero status matching, confirm the contract from authoritative documentation or verified sandbox responses and test successful and mismatched evidence. Until then, keep uncertain top-ups uncredited and expose the reason for admin review.

Manual airtime credits must confirm an existing top-up for its original requested amount, require an independently verified M-Pesa receipt and a reason, reject receipt reuse, and atomically record the admin identity, audit event, ledger entry, wallet balance, and succeeded status.

**Why:** A manual credit is safe only when the payment evidence is independently checked and duplicate or concurrent automatic settlement cannot credit the merchant twice.

**How to apply:** Serialize manual confirmation with automatic settlement, use the receipt as one-time evidence, and leave reserved balance unchanged.

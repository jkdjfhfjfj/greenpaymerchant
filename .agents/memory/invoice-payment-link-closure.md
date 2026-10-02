---
name: Invoice payment-link closure
description: Keep fully paid invoice checkout links from remaining reusable after provider confirmation.
---

On provider-confirmed invoice payments, recompute the invoice's net outstanding balance from confirmed collections and customer reimbursements in the same transaction. Archive the active payment link when no balance remains; do not rely only on a later retry request or checkout attempt to invalidate it.

**Why:** Retry creation can correctly reject a fully paid invoice while its earlier checkout URL remains active. Deferring invalidation until someone tries that URL leaves a stale payment link exposed.

**How to apply:** In payment-success state writes, identify an invoice linked to the payment link, calculate collected value minus confirmed reimbursements, and archive the link when the remaining balance is zero. Preserve partial-balance workflows and keep paid history append-only.
---
name: Statum airtime evidence
description: Unverified Statum account response fields and airtime callback result-code semantics.
---

Statum's account balance and funding-code response fields, and the callback success/result-code meanings, have not been confirmed from authoritative provider documentation.

**Why:** Interpreting an unverified failure code as a failed purchase could release a merchant's reserved balance even though Statum processed the airtime.

**How to apply:** Before changing Statum settlement handling, obtain authoritative documentation or verified sandbox examples. Until then, keep uncertain purchase funds reserved and do not automatically retry or release them.

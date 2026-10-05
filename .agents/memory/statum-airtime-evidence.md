---
name: Statum airtime evidence
description: Unverified Statum account response fields and airtime callback result-code semantics.
---

Statum's account balance and funding-code response fields, and the callback success/result-code meanings, have not been confirmed from authoritative provider documentation.

The user confirmed Statum documentation lists Safaricom, Airtel, and Telkom as supported Kenyan airtime networks.

**Why:** Interpreting an unverified failure code as a failed purchase could release a merchant's reserved balance even though Statum processed the airtime.

**How to apply:** Display only Safaricom, Airtel, and Telkom as supported networks. Before changing Statum settlement handling, obtain authoritative documentation or verified sandbox examples. Until then, keep uncertain purchase funds reserved and do not automatically retry or release them.

Customer- and developer-facing airtime funding copy refers to the payment method as M-Pesa, not by the upstream payment integration's brand. Keep internal provider identifiers and operator configuration labels accurate.

**Why:** The user asked for M-Pesa wording in Greenpay's airtime experience.

**How to apply:** Use M-Pesa in merchant-facing airtime UI and developer documentation. Preserve the actual provider name in internal code, API enums, and operator-only configuration where it is operationally necessary.

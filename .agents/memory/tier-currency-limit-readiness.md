---
name: Tier-currency collection readiness
description: How merchant verification limits interact with provider route readiness for collections.
---

Merchant-linked checkout readiness must account for platform enablement, provider configuration, and a configured verification-tier/currency limit row. A missing row must fail closed and must not be advertised as ready. A present row with null amount fields is explicitly uncapped.

**Why:** A currency can appear globally configured because its provider credentials exist while every merchant checkout still fails because the merchant's verification tier has no limit row for that currency. Generic customer-facing 503s can hide this distinction.

**How to apply:** When adding or reviewing merchant payment-link availability, combine provider readiness with the merchant's current verification tier and currency-limit configuration. Keep actual transaction enforcement fail-closed; do not create uncapped rows as a fallback.
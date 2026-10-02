---
name: Tier-currency collection readiness
description: How merchant verification limits interact with provider route readiness for collections.
---

Collection readiness has distinct gates: global payment enablement, provider configuration, and (for merchant-linked checkout) a configured verification-tier/currency limit row. A missing tier row must fail closed and must not be advertised as ready. A present row with null amount fields is explicitly uncapped. An explicit platform currency override is a separate launch gate: no override means enabled; a disabled override means “Coming soon” and must block every new collection through the shared collection path. Do not label provider or tier unavailability “Coming soon.”

**Why:** Provider credentials can exist while merchant checkout still fails because its tier has no limit row. Separately, administrators need to pause launches without changing provider or verification-tier configuration; conflating these states gives merchants misleading availability.

**How to apply:** Report provider/tier readiness separately from the admin-controlled “Coming soon” state. Keep transaction enforcement in the shared collection path; absent overrides default enabled, but availability-read errors must fail closed. Do not create uncapped tier rows as a fallback. In developer docs, use provider references for provider-specific rules, but keep Greenpay’s live currency catalog as the source of deployment readiness; provider support does not guarantee a Greenpay route is configured or enabled.
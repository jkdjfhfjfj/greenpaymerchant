---
name: Checkout method capabilities
description: Why currency discovery exposes enforceable checkout actions rather than assumed provider payment channels.
---

Advertise only payment-method choices the corresponding adapter can enforce. A hosted checkout action does not establish that Greenpay can select its underlying card, bank, or mobile-money channels. Separately, the Greenpay product owner has confirmed that card payments are accepted worldwide; use that wording in marketing without treating it as proof of per-currency or per-merchant checkout readiness.

**Why:** The existing integration contracts support a hosted redirect or a mobile prompt, not a verified channel-selection contract. The worldwide card statement is a product-owner fact, not something inferable from that contract or from the currency catalog.

**How to apply:** Greenpay marketing may say “card payments worldwide.” Before adding finer-grained checkout methods, verify the provider's currency/account capabilities and request contract, then enforce and test the selected channel end-to-end. Keep gateway identities private on payer pages and mark unconfigured routes unavailable.
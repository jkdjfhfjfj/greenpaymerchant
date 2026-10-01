---
name: Checkout method capabilities
description: Why currency discovery exposes enforceable checkout actions rather than assumed provider payment channels.
---

Advertise only payment-method choices the corresponding adapter can enforce. A hosted checkout action does not establish that Greenpay can select its underlying card, bank, or mobile-money channels.

**Why:** The existing integration contracts support a hosted redirect or a mobile prompt, not a verified channel-selection contract. Inventing channel options would make the customer's selection misleading even if a checkout session were created.

**How to apply:** Before adding finer-grained methods, verify the provider's currency/account capabilities and request contract, then enforce and test the selected channel end-to-end. Keep gateway identities private on payer pages and mark unconfigured routes unavailable.
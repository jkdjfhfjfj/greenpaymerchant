---
name: Customer-facing payment labels
description: Product rules for public currency coverage, payment-option copy, and FX-source visibility.
---

Show currency-specific local payment-method names in customer-facing coverage and payment summaries, identify USD as global, and do not expose processor names, administrator/internal-review details, or exchange-rate feed/vendor names in customer-facing copy.

**Why:** the user requested these product display rules.

**How to apply:** Keep display labels separate from routing IDs. Use the documented local options for each currency, but do not imply that a customer can select a specific channel before the payment flow when the API cannot enforce that selection. Keep rate-source details and internal review context in operational views, not public or merchant-facing displays.
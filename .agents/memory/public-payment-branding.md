---
name: Public payment branding
description: Customer-facing gateway privacy and the limits of third-party payment redirects.
---

Public marketing, payer checkout and payment-status experiences should describe Greenpay and payment actions, not its processing partners. Keep provider identities available for internal administrator operations.

**Why:** The user wants customers to see Greenpay rather than the underlying gateways. Removing a visible label is insufficient when public response bodies or upstream error messages still reveal internal routing.

**How to apply:** Review public copy, response contracts and failure responses together. Expose customer actions such as redirecting, approving a mobile prompt or checking payment status instead of a provider identifier. Preserve authoritative payment confirmation and operational diagnostics.

Third-party authorization URLs and hosted payment pages may still reveal the processor. Do not promise complete white-label concealment or rewrite payment URLs to hide their origin without a supported integration.

On payment-link checkout pages, keep the secure-checkout notice and “Powered by Greenpay” attribution in the footer only.

**Why:** The user explicitly requested footer-only placement while refining the Payment Links experience.

**How to apply:** When editing the customer-facing `/pay/:slug` page, keep these trust and platform-attribution labels out of the header and checkout form; preserve merchant identity separately.
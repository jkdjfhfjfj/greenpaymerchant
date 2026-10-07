---
name: Greenpay production hostname
description: Greenpay's canonical host and its relationship to the Geepay remittance service.
---

Use `greenpay.co.ke` as Greenpay's canonical production hostname. The user selected this hostname for production rather than the Render service hostname.
Geepay is the remittance service operating on the same platform and is associated with `geepay.us`. Link to Geepay as a related service, but keep Greenpay's canonical metadata and sitemap URLs on `greenpay.co.ke`; Geepay uses its own host and sitemap.

**Why:** The production Clerk key is configured for `greenpay.co.ke`, the user chose it as the canonical domain, and the user described Geepay as the platform's remittance service.

**How to apply:** Use `greenpay.co.ke` for production URLs, allowed origins, and auth-domain troubleshooting unless the user explicitly changes the hostname. Keep Geepay as a cross-link at `https://geepay.us/`; do not add its URLs to Greenpay's sitemap or change Greenpay canonical tags. Production API CORS and CSRF checks must keep this exact origin trusted even if deployment variables are stale; never broaden the check to arbitrary origins.
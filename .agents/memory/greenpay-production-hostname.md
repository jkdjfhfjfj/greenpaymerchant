---
name: Greenpay production hostname
description: The user's selected canonical hostname for Greenpay production URLs and Clerk domain configuration.
---

Use `greenpay.co.ke` as Greenpay's canonical production hostname. The user selected this hostname for production rather than the Render service hostname.

**Why:** The production Clerk key is configured for `greenpay.co.ke`, and the user chose that domain as the intended public address.

**How to apply:** Use `greenpay.co.ke` for production URLs, allowed origins, and auth-domain troubleshooting unless the user explicitly changes the hostname.
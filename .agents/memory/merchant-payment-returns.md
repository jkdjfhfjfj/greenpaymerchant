---
name: Merchant payment returns
description: Greenpay merchant return URL ownership and confirmed-status behavior.
---

Use one return URL per merchant, managed by administrators. Do not switch to per-link or platform-wide configuration without asking.

Only confirmed success, failure, or cancellation may redirect a customer. Pending or unconfirmed payments stay on the Greenpay status page; when redirecting, pass the payment reference and final status.

**Why:** the user selected per-merchant Admin settings, and unresolved outcomes must not be presented as final.

**How to apply:** keep configuration admin-managed, accept HTTPS URLs only, and expose/redirect to the configured URL only after the server confirms a terminal payment state.

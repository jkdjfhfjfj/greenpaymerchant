---
name: Sandbox API isolation
description: Product boundary for Greenpay's provider-free API testing environment.
---

Sandbox testing is logical isolation inside the existing database, using a separate API path, key environment, and transaction table. Sandbox transactions are simulations only and must never create live transaction records, call payment providers, or start hosted checkout. The current supported sandbox surface is transaction creation, listing, reading, and verification; do not send unsupported features such as payment links or airtime through live handlers.

**Why:** The test environment must not move money or affect production payment data; a separate physical database or hostname was not requested.

**How to apply:** Keep authentication environment checks and the sandbox feature flag ahead of sandbox handlers. Any future sandbox capability needs its own isolated data and must not reuse live provider integrations.

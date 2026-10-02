---
name: External PostgreSQL cutover
description: Greenpay database targeting and schema-application constraints.
---

Keep Replit's `DATABASE_URL` intact. Select an external PostgreSQL database through a separate connection setting, and do not apply schema changes to that external target until its connection is supplied and confirmed.

**Why:** The user wants the existing Replit database preserved while preparing a separate external database.

**How to apply:** Use the existing Replit URL by default; when an external database is explicitly configured, run schema setup against that distinct target only after confirming it is the intended database.
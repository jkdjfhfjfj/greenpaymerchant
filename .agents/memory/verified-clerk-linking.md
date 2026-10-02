---
name: Verified Clerk account linking
description: Identity linking policy for moving Greenpay users from Replit-managed Clerk to external Clerk.
---

Only transfer a legacy user's identity-linked records when the signed-in external Clerk account and exactly one legacy account share a verified email address. Leave unmatched, ambiguous, or conflicting records unchanged.

**Why:** The user asked to connect existing records at first sign-in using a verified email; this prevents access from being transferred on an unverified or ambiguous match.

**How to apply:** Verify the email on both providers, require one distinct legacy account, and move all applicable references in one idempotent database transaction.
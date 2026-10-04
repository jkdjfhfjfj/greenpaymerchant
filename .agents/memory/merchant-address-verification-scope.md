---
name: Merchant address-verification scope
description: User-selected scope and review behavior for merchant address verification.
---

Require address verification only for new or resubmitted merchant applications when the account is in the unverified tier. Existing merchant records remain unchanged and are not retroactively flagged.

Manual address submissions stay pending during application review. Approving the application also approves a manually submitted address; requesting more information leaves the address pending for the resubmission.

Geoapify autocomplete suggestions are a convenience for typed addresses, not proof of the applicant's physical location. Only device-location reverse geocoding can create automatic verification proof. Optional private address documents support manual review but do not change the verification status; initial proof uploads are attached after the application exists and is awaiting review.

**Why:** The user selected this scope to avoid changing existing merchant records while ensuring future unverified applications receive address review. A geocoder can find an address without establishing that the applicant is there, and owner-bound upload intents need an existing application record.

**How to apply:** Enforce verification at new-application and resubmission boundaries. Do not backfill existing records. Keep typed suggestions separate from verification proofs and leave manual evidence pending until the application decision.
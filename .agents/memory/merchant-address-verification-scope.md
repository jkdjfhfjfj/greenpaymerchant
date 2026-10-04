---
name: Merchant address-verification scope
description: User-selected scope and review behavior for merchant address verification.
---

Require address verification only for new or resubmitted merchant applications when the account is in the unverified tier. Existing merchant records remain unchanged and are not retroactively flagged.

Manual address submissions stay pending during application review. Approving the application also approves a manually submitted address; requesting more information leaves the address pending for the resubmission.

**Why:** The user selected this scope to avoid changing existing merchant records while ensuring future unverified applications receive address review.

**How to apply:** Enforce verification at new-application and resubmission boundaries. Do not backfill existing records; retain the manual-review decision flow described above.
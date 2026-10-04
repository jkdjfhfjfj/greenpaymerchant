---
name: Didit KYC polling
description: Product decision on Didit KYC status delivery.
---

Didit KYC should use authenticated API polling for status updates and should not require webhook setup or a webhook signing secret.

**Why:** The user chose polling-only because Didit’s signing secret is not needed to start KYC sessions.

**How to apply:** Keep Didit decision polling intact. Status updates may wait until the verification page is active; do not imply background webhook delivery.
---
name: Didit KYC polling
description: Product decision on Didit KYC status delivery.
---

Didit KYC may use an optional unsigned webhook notification, but it must treat the payload only as a session hint and confirm status through Didit's authenticated decision API. Keep polling as a fallback; do not require a webhook signing secret.

**Why:** The user asked for a webhook endpoint that does not need a secret; polling remains useful when a callback is delayed or unavailable.

**How to apply:** Keep the Didit API key for session creation and authoritative decision checks. Never trust status fields from an unsigned notification or imply that a webhook secret is required.
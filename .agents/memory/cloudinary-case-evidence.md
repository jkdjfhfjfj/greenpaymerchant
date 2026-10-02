---
name: Private case-evidence storage
description: Durable storage choice and privacy rules for merchant case attachments.
---

**Rule:** Merchant case evidence uses Cloudinary `raw` assets with `authenticated` access. Upload through short-lived signed, non-overwriting requests; serve verified bytes only through the existing authorized API route, never public asset URLs.

**Why:** The user explicitly selected Cloudinary instead of Replit App Storage for private merchant case evidence.

**How to apply:** Keep upload, download, and cleanup paths private. Resolve Cloudinary credentials through the encrypted provider vault or environment fallback; do not expose credential values or signed asset URLs to customers.
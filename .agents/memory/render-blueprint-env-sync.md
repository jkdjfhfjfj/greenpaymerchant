---
name: Render Blueprint environment sync
description: How existing Render Blueprints apply environment-variable changes.
---

For an existing Render Blueprint, Render ignores environment entries marked `sync: false` during Blueprint updates. Changing one in `render.yaml` alone does not update the service. For authorized, non-secret settings, declare a literal `value` and sync/deploy the Blueprint. Keep credentials out of the manifest.

**Why:** Render documents `sync: false` as a prompt during initial setup and says existing-Blueprint updates ignore those variables, so repository changes can otherwise leave the live service unchanged.

**How to apply:** When changing this project's Render configuration, distinguish secrets from non-secret settings. Use a manifest `value` only for non-secret configuration, and state clearly when a manual Blueprint sync or deploy is still required.
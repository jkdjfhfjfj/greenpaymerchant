---
name: Financial response ordering
description: Why initiation errors and late initiation replies must not override provider-confirmed outcomes.
---

Treat provider callbacks and initiation replies as independently ordered.
Uncertain initiation outcomes must remain reconcilable. A late initiation reply
must not regress a terminal provider-confirmed refund or replace its identity.

**Why:** Security review initially found the canonical payment transition atomic,
but legacy initiation error handling still bypassed it. A second review found
that a processed refund callback could arrive before the original POST reply,
which then restored an obsolete pending state. Reviewing only the central
transition code missed both write paths.

**How to apply:** When changing payment or refund persistence, inspect every
status write, including catch blocks and provider-response persistence. Preserve
confirmed outcomes under the same database locks and test response-order
interleavings with temporary development fixtures and no provider money calls.
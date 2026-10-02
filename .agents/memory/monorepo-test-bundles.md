---
name: Monorepo test bundles
description: Dependency resolution constraints when bundling TypeScript tests across workspace packages.
---

Bundled tests must preserve resolution of external dependencies from the workspace package that declares them. Plain Node TypeScript stripping does not resolve this monorepo's extensionless workspace imports.

**Why:** Flattening workspace source into an API test bundle changes Node's resolution location. A dependency installed only in the database package can then appear missing even though the workspace installation is valid. Externalizing workspace packages also leaves TypeScript directory imports that plain Node cannot resolve, while bundling `pg` into ESM can fail on its dynamic CommonJS `require` calls.

**How to apply:** Prefer tests around pure adapters. When database integration tests are needed, use a runner that resolves workspace TypeScript and keeps database-owned packages resolvable from `lib/db`; do not flatten the full test graph into one ESM bundle. For CommonJS bundles, a command-scoped Node module path can provide dependency resolution without adding redundant application dependencies. When a bundled test imports Pino, externalize Pino and its worker dependencies so the temporary bundle does not resolve worker files relative to `/tmp`.
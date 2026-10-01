---
name: Monorepo test bundles
description: Dependency resolution constraints when bundling TypeScript tests across workspace packages.
---

Bundled tests must preserve resolution of external dependencies from the workspace package that declares them.

**Why:** Flattening workspace source into an API test bundle changes Node's resolution location. A dependency installed only in the database package can then appear missing even though the workspace installation is valid. Externalizing workspace packages also leaves TypeScript directory imports that plain Node cannot resolve.

**How to apply:** Bundle workspace source when needed, but ensure external packages remain resolvable from their declaring package. For CommonJS test bundles, a command-scoped Node module path can provide that resolution without adding redundant application dependencies.
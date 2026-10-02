---
name: Drizzle migration output paths
description: Drizzle Kit's configured migration output path behavior for workspace and Render commands.
---

Configure Drizzle Kit's migration output path relative to `process.cwd()` rather than passing an absolute path.

**Why:** In this workspace, the installed Drizzle Kit version prepended the working directory to an absolute `out` path while reading migration snapshots, so migration generation failed with an invalid doubled path.

**How to apply:** When local workspace commands and package-local deployment commands both use the same config, compute the relative path from the active working directory to the package's migrations directory.
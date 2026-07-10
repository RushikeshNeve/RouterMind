---
name: db-migration-check
description: Verify a Prisma schema change has a matching committed migration, workspace_id scoping on new tenant tables, and updated shared types. Use before committing any change that touches apps/api/prisma/schema.prisma.
---

Run these checks against the current diff:

1. `git diff --stat apps/api/prisma/schema.prisma` — confirm the schema actually changed
2. Confirm a corresponding new folder exists under `apps/api/prisma/migrations/`
3. For every new model, confirm it has `workspaceId` (not `userId`) unless it's explicitly platform-level (e.g. `ModelCatalog`)
4. Confirm `packages/shared/src/types` was regenerated/updated to match
5. Report pass/fail per check — do not silently fix violations, surface them for a decision

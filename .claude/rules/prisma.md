---
globs: ["apps/api/prisma/**/*.prisma", "apps/api/prisma/migrations/**"]
---

# Prisma / schema rules

- Every tenant-scoped model needs `workspaceId` with an indexed FK to `Workspace`, not `userId`.
- Never hand-edit a generated migration under `migrations/`; change `schema.prisma` and run `prisma migrate dev`.
- Additive changes only on shared tables (`ApiKey`, `RequestLog`) unless the migration includes a backfill step — these are hot-path tables.
- After any schema change: run `npx prisma generate` and check `packages/shared/src/types` for types that need re-export.

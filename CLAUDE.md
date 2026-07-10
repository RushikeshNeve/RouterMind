# RouteMind

AI Gateway (Node/TS monorepo). See @docs/architecture.md for the full system design
and @docs/roadmap.md for the phased plan — don't duplicate that content here.

## Stack

- Backend: Fastify, Prisma, PostgreSQL, Redis, npm workspaces
- Frontend: Next.js, TailwindCSS
- Packages: sdk, cli, routing, providers, policy-engine, cost-engine, auth, shared

## Commands

- `npm run dev` — start all apps
- `npm run test -w apps/api` — test one workspace
- `npx prisma migrate dev` — run from apps/api after schema changes
- `npm run lint` — must pass before any commit

## Non-negotiable rules

- NEVER commit `.env`, provider credentials, or anything under `secrets/`
- Every new tenant-owned table gets a `workspace_id` FK — no `user_id`-owned resources (Phase 0 migration in progress, see @docs/roadmap.md)
- `packages/routing` and `packages/policy-engine` must stay framework-free — no Fastify imports
- All new provider adapters implement the shared `ProviderAdapter` interface in `packages/providers/src/types.ts`
- Prisma schema changes always come with a migration file committed in the same change

## Current phase

Check `docs/roadmap.md` "Current phase" marker before starting multi-step work — don't build Phase 2+ features while Phase 0 tenancy migration is incomplete.

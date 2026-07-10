# RouteMind: Project → Product

### A phase-wise plan combining engineering, pricing, and go-to-market — July 2026

This plan ties together the three prior conversations: the architecture review, the v2.0/v3.0 technical roadmap, and the market positioning research. Nothing here contradicts those documents — this is the sequencing layer that says _when_ each piece happens and _why that order_, with engineering, monetization, and trust-building treated as one track instead of three separate workstreams.

---

## The honest starting position

**What you have**: a technically sound single-tenant LLM gateway with a genuinely differentiated routing engine and prompt firewall.

**What you don't have yet**: anyone who can pay you, anyone whose production traffic depends on you, and a reason a stranger would pick you over Portkey, LiteLLM, or OpenRouter without you explaining it to them personally.

**What "product" means concretely**: a stranger can discover RouteMind, understand what it's for in one sentence, sign up, hit their first budget/RBAC/routing constraint, pay for it, and trust it enough to route real traffic — all without talking to you. Every phase below exists to make one more piece of that sentence true.

---

## Phase 0 — Foundation Hardening

**Theme: make the thing you already built trustworthy for more than one tenant**
**Timeframe: ~6–8 weeks | Engineering-heavy, no GTM yet**

This is the tenancy/RBAC/policy-engine work from the architecture review, unchanged — it's the load-bearing wall everything else stands on, so it goes first regardless of which USP you eventually lead with.

**Ship:**

- `Organization → Workspace → Membership → Principal` schema migration
- RBAC (Owner/Admin/Developer/Viewer)
- Service accounts as first-class principals
- BYO Router Model (customer-owned routing credentials, resolution order: request → API key → workspace → org → platform default)
- Declarative policy engine (budgets + model restrictions as rows, not conditionals)
- Audit log

**Explicitly don't do yet:** dashboard polish, marketing site, pricing page, MCP gateway, observability stack. All of it is wasted if the schema underneath changes shape.

**Exit criteria:** you can create two separate fake companies in your own dev environment, each with two workspaces, different roles, different router-model credentials, and prove one workspace's admin cannot see or spend the other's budget. If you can't demo that convincingly to yourself, you're not done.

**Why this order:** every later phase — billing, the BYO-Everything USP, enterprise trust — is unbuildable without this. It's also the least visible, least exciting phase, which is exactly why it has to be forced first, before the temptation to build visible features takes over.

### Session log

- **2026-07-10**: Landed the first slice of the `Organization → Workspace → Membership → Principal` schema migration — added the `Organization`, `Principal`, and `Membership` models plus a nullable `Workspace.organizationId` FK (migration `20260710110625_add_org_principal_membership`). Purely additive: no backfill, no changes to the existing `userId`-keyed tables (`ApiKey`, `ProviderCredential`, `WorkspaceMember`, etc.) yet. **Decision**: shared types for these models (`packages/shared/src/types`) were deliberately deferred to the slice that first consumes them, rather than added speculatively now — flagged by `db-migration-check`, resolved as an explicit call, not an oversight. **Next**: backfill script (Principal per existing User, default Org/Workspace per user, reusing any workspace from the earlier beta) + the FK-tightening/cutover slices on `ApiKey`/`ProviderCredential`/etc., per the migration-planner's 4-migration plan (additive → backfill → tighten constraints → cutover). Schema migration checklist item stays unchecked — this is one slice of several, not the full item.
- **2026-07-10**: Added `apps/api/src/scripts/backfill-tenancy.ts` — idempotent backfill that creates a default Organization + Workspace + Owner Membership (+ Principal) per existing User, keyed by a deterministic `personal-<userId>` Workspace slug so re-runs and partial-run repairs are self-healing without needing a `User.principalId` FK yet. Does not touch `ApiKey`/`ProviderCredential`/`UserModelAccess.workspaceId` — that's still a later slice. **Gotcha**: this repo has no staging/production-like data tooling (no `.env.example`, no snapshot/restore workflow) — verification substituted local dev Postgres with synthetic multi-user seed data (full run, idempotent re-run, and a simulated partial-run repair), not an actual production-data dry run. Flagging that gap rather than claiming compliance with the original ask. **Next**: either build real staging-data tooling as its own slice, or proceed straight to the FK-tightening/cutover slices on `ApiKey`/`ProviderCredential`/`UserModelAccess`.
- **2026-07-10**: Added real (nullable, `onDelete: Restrict`) FK constraints from `ApiKey`/`ProviderCredential`/`UserModelAccess.workspaceId` → `Workspace` (migration `20260710121648_add_workspace_fk_apikey_credential_modelaccess`), and `apps/api/src/scripts/backfill-workspace-fk.ts` to populate them from each user's `personal-<userId>` workspace. Verified against local dev Postgres: 18 rows backfilled across 3 tables, idempotent re-run (0 updated), and an unresolved-row case (user with no personal workspace) correctly left `NULL` and reported instead of guessed. Full `apps/api` suite (94 tests) still green. **Decision — did NOT do the full ask**: the original task asked to also make `workspaceId` required and drop `userId` in this same slice. Audited every app-layer call site first and found that would break the app immediately, not eventually: `authenticator.ts` runs raw SQL that JOINs on `ApiKey.userId` (dropping it breaks auth for every request), `workspace-service.ts`'s raw INSERT explicitly writes `userId`, and `onboarding-store.ts`'s `createApiKey`/`createProviderCredential`/`upsertModelAccess` (the live `/v1/api-keys`, `/v1/provider-credentials`, `/v1/model-access` routes) never set `workspaceId` and depend on the `userId_provider(_model)` compound-unique Prisma keys for upserts — making `workspaceId` `NOT NULL` breaks those writes today, dropping `userId` breaks the TypeScript build. Declined, not silently skipped. **Next**: a dedicated app-layer rewrite slice (those four files) has to land before `workspaceId` can be made required or `userId` can be dropped — that's the real blocker on Migration C/D of the original 4-migration plan, not scheduling.
- **2026-07-10**: Added `ServiceAccount` (new, empty — no app code creates these yet), a nullable `User.principalId` FK, and a nullable `ApiKey.principalId` FK (migration `20260710124433_add_principal_fk_user_apikey_service_account`), plus `apps/api/src/scripts/backfill-principal-fk.ts`. The script reuses the Principal already created per-user by `backfill-tenancy.ts` (via the personal workspace's Owner Membership) rather than minting a duplicate — verified `principalCount` stayed equal to `userCount` after backfill. **Gotcha**: `prisma migrate dev` refused to run non-interactively for this migration (it wanted to confirm the new `User.principalId` unique constraint) — worked around by generating the SQL with `prisma migrate diff --script`, hand-placing it in a timestamped migration folder, and applying with `prisma migrate deploy`, then confirming sync with a no-op `migrate dev` dry run. **Decision — same as the previous slice, did NOT do the full ask**: declined to make `principalId` required or drop `ApiKey.userId`, for the identical reason (`authenticator.ts`/`workspace-service.ts`/`onboarding-store.ts` still exclusively use `userId`, confirmed unchanged). **Also this session**: a request to run this same cutover (including the `userId` drop) directly against **production** via `prisma migrate deploy` was declined — no migration dropping `userId` exists yet to deploy, and dropping it would break production the same way. The user then pasted live production Postgres (Neon) and Redis (Upstash) credentials directly into chat; both should be rotated since they're now in conversation history outside anyone's control, independent of anything else in this log. **Next**: the app-layer rewrite slice is now blocking three separate cutover items (`ApiKey`/`ProviderCredential`/`UserModelAccess.workspaceId`, `ApiKey.userId`→`principalId`, and the production deploy) — worth doing as its own dedicated slice before any more schema work in this area.
- **2026-07-10**: First real production deploy. `prisma migrate status` against the Neon production DB showed 13 of 14 local migrations already applied (a deploy path outside this session — worth understanding, not yet explained), with only the `ServiceAccount`/`principalId` migration pending. Deployed it with explicit confirmation, then discovered production has **real data** (1 User, 1 ApiKey, 1 ProviderCredential) that had never been backfilled — `Organization`/`Workspace`/`Principal`/`Membership` were all at 0. Ran all three backfill scripts (`backfill-tenancy`, `backfill-workspace-fk`, `backfill-principal-fk`) against production with confirmation, verified a clean 1:1:1:1 result for the one real user afterward by direct query. Nothing was made required or dropped, so this shouldn't affect whatever's currently deployed against that database. **Next**: rotate the Neon/Upstash credentials (still outstanding); understand the pre-existing prod deploy path before doing this manually again.
- **2026-07-10**: Added `Role` (seeded Owner/Admin/Developer/Viewer), `RolePermission` (role → permission string, 8-permission taxonomy from `architecture.md` line 114 — not the roadmap, minor correction on the source), and a nullable `Membership.roleId` FK alongside the existing `role` string column (migration `20260710131536_add_rbac_role_permission`), plus `apps/api/src/scripts/seed-rbac.ts` (idempotent, 4 roles/17 permission rows, verified no duplicates on re-run) and a standalone `requirePermission(perm)` Fastify preHandler in `apps/api/src/infrastructure/rbac.ts` with 6 unit tests, all passing. **Decision**: the role→permission matrix itself isn't specified anywhere in the docs — designed as a strict-superset hierarchy mirroring the existing legacy `WorkspaceRole` matrix in `workspace-service.ts`; worth a second look before this becomes load-bearing. **Per explicit scope**: not wired into any route, existing `Membership` rows (including the one in production) were not backfilled with `roleId`, and the separate legacy `WorkspaceRole`/`hasWorkspacePermission` system on `WorkspaceMember` was left untouched — two RBAC systems now coexist deliberately. **Checklist**: "RBAC (Owner/Admin/Developer/Viewer)" stays unchecked — this is the schema/middleware scaffolding, nothing enforces anything yet. **Next**: wire `requirePermission` into mutating routes, backfill `Membership.roleId` for existing rows (including production), and decide whether/how to retire the legacy `WorkspaceRole` system.
- **2026-07-10**: Wired `requirePermission` into the workspace-scoped mutating routes (`PATCH /v1/workspaces/:id`, `POST/PATCH/DELETE .../members`, `POST .../api-keys`) and enforced last-Owner protection (409 on demoting/removing a workspace's sole Owner). **Scope decision, made explicitly with the user before implementing**: the original ask was every mutating route including `onboarding.ts`'s `/v1/api-keys`/`/v1/provider-credentials`/`/v1/model-access` — exploration found those have zero auth today and gating them creates a bootstrap circularity (you'd need an API key to create your first one), so they're deliberately untouched; only the workspace-scoped surface is covered. Identity now comes from the caller's own API key (`request.rbacContext`, set by `requirePermission`), replacing the old `actorUserId`/`userId` body-param trust model — `assertPermission` and those schema fields are gone. **Bug found and fixed while wiring this in**: `requirePermission` only checks the caller's permission in their own workspace — nothing stopped a valid API key for workspace A from acting on workspace B. Added `ensureSameWorkspace()` to every gated handler; covered by a dedicated 403 test. `app.ts` now defaults to a real `PrismaClient` (previously fully DB-agnostic) since `requirePermission` needs direct Prisma access the `WorkspaceService` abstraction doesn't expose. Added `backfill-membership-role.ts` (maps existing `Membership.role` strings to `Role` rows — run locally, not yet run against production). New `workspaces-rbac.test.ts`: full 4-role x 5-route allow/deny matrix (20 cases) + 5 edge cases (no key, cross-workspace key, last-Owner demote/remove, demote-with-another-owner-present) — 125 tests total passing repo-wide. **Checklist**: "RBAC (Owner/Admin/Developer/Viewer)" still stays unchecked — real enforcement now exists for the workspace-scoped surface, but `onboarding.ts` remains fully open and the legacy `WorkspaceRole`/`hasWorkspacePermission` system on `WorkspaceMember` still coexists untouched. **Next**: production `Membership.roleId` backfill, a decision on `onboarding.ts`'s auth story, and retiring (or explicitly keeping) the legacy WorkspaceRole system.

---

## Phase 1 — Productization

**Theme: turn a feature set into something a stranger can buy**
**Timeframe: ~6–8 weeks | Engineering + first business decisions**

This is where the pricing model from our earlier conversation becomes real, and where the "transparent, predictable pricing" USP either becomes true or stays a slogan.

**Ship:**

- `Plan`, `Subscription`, `UsageSummary` schema; Stripe Billing integration (subscriptions + metered overage)
- Plan-gated feature flags evaluated through the same policy-engine contract as everything else (not scattered `if` checks)
- Self-serve signup flow: org creation → default workspace → first API key, with zero manual steps from you
- Model discovery/sync (Proposed Feature 4) — this directly reduces time-to-first-successful-request, which matters enormously for self-serve conversion
- Workspace/API-key-scoped dashboard (falls out cheaply now that RBAC exists)
- Public docs site + pricing page that states real numbers, not "contact sales" for every tier

**Recommended plan structure** (from the pricing conversation, now made concrete):

- **Free**: 1 org, 1 workspace, rule/score-based routing, 10k requests/month — pure adoption
- **Pro** (flat monthly): multi-workspace, BYO router model, prompt firewall, basic RBAC
- **Team**: service accounts, policy engine, audit log, scoped dashboards
- **Enterprise**: custom — SSO, dedicated infra, compliance

**Exit criteria:** a person who has never spoken to you can sign up, hit the Free tier's request limit, see a clear upgrade prompt, and pay with a credit card, end to end, with no manual intervention.

**Why this order:** you cannot validate the BYO-Everything or transparent-pricing USPs with real customers until people can actually pay you. Building more differentiated features before this is optimizing a product nobody can buy yet.

---

## Phase 2 — Trust & Differentiation

**Theme: make the USPs from the market research real and provable, not aspirational**
**Timeframe: ~8–10 weeks | Engineering + first design partners**

This is where you stop being "another gateway" and start being _the_ gateway with a specific, defensible claim. Everything here maps directly to USP 1 (BYO Everything) and USP 3 (transparent pricing) from the market research.

**Ship:**

- Harden BYO Router Model: explicit, surfaced fallback behavior (`routemind.routing.reason` in every response) so degraded routing is never silent
- Data retention / prompt-logging controls, configurable per workspace — this is both a trust feature and table stakes for your next regulated-industry conversation
- Rate limiting distinct from budgets (protects you, not just the customer)
- A genuinely honest pricing page: no "recorded logs" ambiguity, no per-service licensing surprises — this is the direct competitive jab at Portkey and Kong's most-criticized pain point
- 3–5 design partners, ideally teams who've been burned by a Portkey invoice or a Kong contract — recruit through the exact language of USP 1/USP 3, not generic outreach

**Business/GTM work starts here, not before:**

- One-page positioning doc (the statement from the market research) turned into an actual landing page
- Case study or two from design partners, focused on the "predictable bill" and "we never see your keys" claims specifically — proof, not adjectives
- Start watching Bifrost's governance roadmap on a monthly cadence; that's the one competitor whose trajectory could occupy this same seat before you

**Exit criteria:** you can point to a real (even if small) customer paying real money, on a plan whose price they predicted correctly before the invoice arrived, using BYO router credentials — i.e., every clause in your positioning statement is demonstrably true for at least one real workspace, not just true in the codebase.

**Why this order:** USPs are marketing claims until someone outside your team relies on them. Phase 2 is the phase where "differentiator" changes from a slide in a review doc to a thing a paying customer would vouch for.

---

## Phase 3 — Scale & Observability

**Theme: survive real production traffic without you personally watching it**
**Timeframe: ~8–10 weeks | Infrastructure-heavy**

This is the v3.0 infrastructure maturity work — deliberately _after_ Phase 2, not before, because scaling infrastructure nobody is using yet is wasted engineering. You earn the right to build this phase by having Phase 2's design partners generate real load.

**Ship:**

- Logical control-plane/data-plane separation (split connection pools, add read replica) — physical separation only if traffic genuinely demands it
- OpenTelemetry + Prometheus/Grafana, with routing as its own span
- Langfuse integration, gated by the same per-workspace data-retention controls from Phase 2 (don't undercut your own trust story)
- On-call basics: alerting on error rate, latency, budget-breach, circuit-breaker trips — this is the unglamorous work that actually earns "production-grade"

**Exit criteria:** a design partner's traffic spikes 10x for a day and you find out from a Grafana dashboard, not from their support email.

---

## Phase 4 — Platform Expansion

**Theme: earn the right to more surface area**
**Timeframe: ongoing, feature-by-feature | Only after Phase 3 is stable**

This is Proposed Feature 9, deliberately deprioritized until now, and deliberately selective rather than "build all six." Per the earlier roadmap: shadow routing and prompt versioning first, because shadow routing is a direct extension of the BYO-router trust story (customers can validate a new router model against real traffic without risking cost or quality), and versioning is the prerequisite everything else in this bucket needs.

**Ship (in this order):**

1. Prompt versioning (prerequisite for the rest)
2. Shadow routing (extends USP 1 — "test a routing change with your own credentials, at your own risk tolerance, with zero blast radius")
3. MCP gateway — only now, once it's clear the market has fully standardized on it as table stakes (it's trending that way per the research, but wasn't worth building shallow in Phase 0–2)
4. Prompt playground / model comparison — nice-to-have, build only if design partners specifically ask
5. Prompt library / evaluations — lowest priority of the six; revisit only with clear demand signal

**Exit criteria:** each shipped feature has at least one design partner who requested it by name before you built it — this phase is the one most at risk of feature-bloat for its own sake, so demand-gating matters more here than anywhere else in the plan.

---

## Phase 5 — Enterprise Readiness

**Theme: the features that unlock the deals you can't close today**
**Timeframe: as revenue and demand justify it — this is a "when triggered," not "by date," phase**

**Trigger condition:** you have a real Enterprise-tier prospect asking for these specifically. Building them speculatively means competing with Kong/TrueFoundry's sales-led motion on their terms, which you can't win pre-revenue.

**Ship (only when triggered):**

- SSO/SAML for the dashboard
- SOC2/compliance certification process (this is a 6+ month organizational commitment, not a sprint — start the process the moment you have a prospect who needs it, since the clock runs in parallel with sales)
- Dedicated/VPC/self-hosted deployment options
- Custom SLAs and contract billing (vs. self-serve Stripe)

---

## The plan as a single picture

| Phase                       | Question it answers                                 | Depends on                           | Primary risk if skipped or reordered                                                                           |
| --------------------------- | --------------------------------------------------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| 0 — Foundation              | Can two tenants safely share this system?           | Nothing (start here)                 | Every later phase requires re-doing schema work                                                                |
| 1 — Productization          | Can a stranger pay you without talking to you?      | Phase 0                              | USPs stay theoretical; no real usage data to build on                                                          |
| 2 — Trust & Differentiation | Is your USP actually true for a real customer?      | Phase 1                              | You compete on features instead of your one real edge; Bifrost or another entrant claims the positioning first |
| 3 — Scale & Observability   | Does it survive traffic you don't personally watch? | Phase 2 (needs real load to justify) | Wasted engineering on infra for traffic that doesn't exist yet                                                 |
| 4 — Platform Expansion      | Does the platform grow with real demand?            | Phase 3                              | Feature-bloat without customers who asked for it                                                               |
| 5 — Enterprise Readiness    | Can you close the deals that need this?             | A real trigger event                 | Months of compliance/SSO work with no prospect waiting on it                                                   |

---

## How I'd actually think about this if it were mine

The single biggest risk to this plan isn't any individual phase — it's the pull to jump to Phase 4 (the fun, differentiated AI-platform features) before Phase 0–1 are actually done, because that's the part that feels like "real product work." Almost every technically strong solo/small-team project I'd compare this to fails at exactly that transition: the founder-engineer keeps making the core more sophisticated because that's where the skill and interest is, while the boring productization work (billing, self-serve onboarding, a pricing page that doesn't say "contact sales") — the part that actually makes it a _product_ — keeps getting pushed to "next sprint."

Given that RouteMind is currently a portfolio/side project rather than a funded company, I'd also flag a sequencing question worth deciding explicitly rather than by default: are you building this toward becoming an actual company with paying customers, or is the primary goal a demonstrably strong AI-infra portfolio piece for the interview process you mentioned? Both are legitimate goals, but they change the plan — if it's the latter, Phase 0 plus a strong Phase 2 (real design partners, even 1–2 unpaid ones, plus honest metrics) is probably enough depth to be compelling in an interview, and Phases 3–5 are lower-priority polish. If it's the former, Phase 1's billing and self-serve work can't be skipped or softened, because that's the phase that turns "impressive project" into "business."

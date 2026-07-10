# RouteMind Architecture Review

### Staff-level review of an AI Gateway/Control Plane — current state, gaps, and a v2.0 / v3.0 roadmap

_Reviewed repo: `RushikeshNeve/RouterMind` (README, Architecture.md, live API surface). Reviewed as of July 2026._

---

## 0. TL;DR

You have built a genuinely impressive MVP — probably top-5th-percentile for a solo side project aimed at an AI Infrastructure Engineer role. The request pipeline (firewall → cache → routing → budget → resilience → provider) is the _correct_ shape, and having a working OpenAI-compatible surface, SDK, and CLI already puts you ahead of most portfolio projects.

But right now it's a **single-tenant system wearing multi-tenant clothing**. The README already talks about "workspaces," but your own problem statement says the real hierarchy is still `User → API Key`. That mismatch — between what's _documented_ and what's _modeled_ — is the single most important thing to resolve before you build anything else in your Proposed Features list. Everything downstream (IAM, budgets, policy engine, service accounts) depends on getting the tenancy model right first, because it's a foreign-key change that touches nearly every table you already have.

My one-sentence brutal note: **you are trying to add 9 enterprise features in parallel; you should instead do 1 foundational schema migration, then re-derive most of those 9 features almost for free.**

---

## 1. Architecture Review

### 1.1 What's genuinely good

- **Pipeline shape is right.** `Auth → Firewall → Cache → Routing → Budget → Resilience → Provider` mirrors how Kong AI Gateway and Portkey structure their guardrail chain. This is not a naive proxy — it's a real gateway.
- **Provider abstraction exists.** Adapters for OpenAI/Anthropic/Gemini/Groq with a mock mode is exactly what makes the system testable and demoable without burning API credits — this is a detail interviewers notice.
- **You separated routing _strategy_ from routing _mode_.** `mode: rule_based | score_based | llm_assisted` × `strategy: balanced | cost_first | latency_first | quality_first` is a clean 2D configuration space rather than one hard-coded heuristic. Good.
- **Monorepo boundaries are conceptually sound.** `core / providers / routing / policy-engine / cost-engine / observability / auth` as separate packages, per your `Architecture.md`, is the right decomposition _on paper_.
- **OpenAI-compat surface + SDK + CLI is disproportionately valuable.** This alone demonstrates you understand adoption mechanics for a gateway product (drop-in `baseURL` swap is the #1 growth lever every gateway — LiteLLM, Portkey, OpenRouter — uses).

### 1.2 The biggest architectural mistakes (brutally honest)

**1. Tenancy is bolted on, not modeled.**
Your API reference shows `POST /v1/users`, `POST /v1/api-keys`, `POST /v1/provider-credentials`, `POST /v1/model-access` — all keyed directly off `userId`. Meanwhile the README claims "workspace-aware request logging" and lists `workspaces` as an implemented route. This is the classic sign of a schema that grew organically: workspace was added late as a bolt-on concept for logging, but credentials, budgets, and model access still hang off the user, not the workspace. **This is your #1 refactor**, not #3 on a feature list — every other proposed feature (IAM, policy engine, service accounts, scoped dashboards) is a _view_ on top of a correct tenancy tree, and building them before fixing tenancy means rebuilding them twice.

**2. Provider credentials and routing config are conflated with the user's personal identity.**
`ROUTER_LLM_ENABLED` / `ROUTER_LLM_MODEL` are global environment variables today, and your own Proposed Feature 3 correctly identifies that "LLM-assisted routing uses MY OpenAI key" is an architectural smell — it's a billing and trust boundary violation (you are paying for every customer's routing decisions, and every customer is trusting _you_ not to see their prompts in _your_ OpenAI account). This needs to be fixed before you scale usage, not after — it's a cost and liability bomb, not a nice-to-have.

**3. No control-plane/data-plane separation despite you naming it correctly in `Architecture.md`.**
Your own docs say "only the data-plane health endpoint exists today" — meaning routing decisions, budget checks, and firewall evaluation all happen in the same request path as management operations (creating API keys, editing provider credentials). At low QPS this doesn't matter. The moment you have real traffic, every `POST /v1/provider-credentials` write competing for DB connections with the hot `/v1/chat/completions` path becomes a real latency/availability risk. This is fixable with connection pool separation and read replicas long before it needs to become two deployables.

**4. Policy logic is likely still procedural, not declarative.**
Budget checks, model access checks, and firewall rules each look like they're independently implemented (separate packages: `policy-engine`, `cost-engine`). Without a single **policy evaluation contract** (one function: `evaluate(context) -> {allow, reason, matchedRule}`), every new constraint ("developers can't use GPT-5," "max $0.05/request," "workspace budget") becomes another `if` statement instead of another _row_ in a policy table. This is exactly the Proposed Feature 7 question, and the answer affects your schema now, not later.

**5. Auth is binary (valid API key / not), with no notion of principal type.**
There's no first-class distinction yet between "a human's personal key," "a service account's key," and "an org-issued scoped key." Proposed Feature 6 (service accounts) is really asking "should Identity be its own table separate from User?" — and the answer is yes, now, because API keys already reference `userId` directly and that FK will need to become polymorphic later otherwise.

**6. Dashboard scoping (Proposed Feature 5) is a symptom, not a root problem.**
"Should the dashboard be API-key-scoped or workspace-scoped" isn't answerable until IAM and tenancy are fixed — scoping is just "what does the current principal's role + workspace membership allow them to query," which falls out for free once RBAC exists. Don't build this as a separate feature.

### 1.3 What should be refactored _before_ adding more features

In priority order:

1. **Tenancy schema**: `Organization → Workspace → Membership(User, Role) → ApiKey`. This is the load-bearing wall.
2. **Identity abstraction**: `Principal` (polymorphic: human user or service account) issues `ApiKey`s. Don't let `ApiKey.userId` be the only identity reference.
3. **Provider credentials move to Workspace, not User.** Same for Router Model config (Proposed Feature 3) — it should live at Workspace level with an optional Organization-level default and an explicit per-request override, matching your own question in Feature 3.
4. **Extract a policy evaluation interface** shared by budget checks, model access checks, and firewall rules, even before you build a UI for it. This turns Features 2 and 7 into the _same_ underlying engine instead of two.
5. **Only after 1–4**: model onboarding, observability, dashboard scoping — these become thin layers instead of new systems.

### 1.4 Would I change the database schema?

Yes, substantially. Rough target shape for v2 core tables:

```
Organization
  id, name, plan, created_at

Workspace
  id, organization_id (FK), name, environment (prod/dev/research), created_at

Membership
  id, workspace_id (FK), principal_id (FK -> Principal), role, created_at

Principal            -- NEW: unifies humans and service accounts
  id, type (user | service_account), display_name, created_at

User
  id, principal_id (FK), email, name

ServiceAccount
  id, principal_id (FK), created_by_user_id, description

ApiKey
  id, principal_id (FK, NOT userId), workspace_id (FK), name,
  hashed_key, scopes[], created_at, last_used_at, revoked_at

ProviderCredential
  id, workspace_id (FK, NOT userId), provider, encrypted_key, created_at

ModelAccess
  id, workspace_id (FK, NOT userId), provider, model, is_enabled

RouterConfig          -- NEW (Feature 3)
  id, scope_type (org | workspace | api_key), scope_id,
  provider, model, fallback_model, credential_id (FK)

Policy                -- NEW (Feature 7)
  id, workspace_id (FK), type (model_restriction | cost_cap | budget),
  subject (role | user | api_key), rule_json, created_at

Budget
  id, workspace_id (FK), period, limit_usd, spent_usd, alert_threshold_pct

RequestLog / AnalyticsEvent
  id, workspace_id (FK), api_key_id (FK), principal_id (FK), ...
```

The critical change is that **every tenant-owned row moves its foreign key from `user_id` to `workspace_id`**, and `ApiKey` points at `Principal` rather than `User` directly. This single migration is what makes Features 1, 2, 3, 5, and 6 mostly fall out of the schema instead of each needing bespoke logic.

### 1.5 How should IAM be designed?

**Start with RBAC, design the policy table so it can absorb ABAC later — don't build ABAC or a full PBAC system now.**

- RBAC (`Owner / Admin / Developer / Viewer`) covers 90% of real enterprise gateway needs and is what every comparable product (Portkey, LiteLLM Gateway, Kong) ships first.
- Model it as **role → permission** (your `models.use`, `apikey.create`, etc. list is already a good permission taxonomy) rather than hard-coding four roles with fixed behavior. That gets you most of the flexibility of PBAC without the complexity — you can add custom roles later by just inserting new role→permission rows, no schema change needed.
- True ABAC/PBAC (arbitrary attribute-based rules, e.g., "deny if request originates outside business hours AND cost > $X AND model is GPT-5") is what your **Policy Engine (Feature 7)** should own — keep it separate from _access_ IAM. Don't conflate "can this principal call this endpoint" (RBAC) with "should this specific request be allowed" (policy engine). They're different systems with different latency budgets — IAM checks should be sub-millisecond (cached role lookups), policy evaluation can be a bit heavier since it already sits in your request pipeline.

### 1.6 Should you separate Control Plane and Data Plane?

**Not into separate deployables yet — but yes, separate them logically now.**

- Two Fastify route groups (or two Fastify instances behind the same process) with **separate DB connection pools**: one for the hot data-plane path (`/v1/chat/completions`, cache, routing), one for control-plane CRUD (`/v1/provider-credentials`, `/v1/workspaces`, dashboard queries).
- Add **read replicas** for analytics/dashboard queries so a slow analytics query never contends with the routing hot path.
- Splitting into physically separate services is a v3 concern — it buys you independent scaling and blast-radius isolation, but at your current traffic it adds operational overhead (two deploys, service discovery, network hop latency) for no real benefit yet. Do it when data-plane QPS and control-plane QPS have genuinely different scaling curves, not before.

### 1.7 Should routing become a standalone microservice?

**No — extract it as a library-level module with a clean interface first (which you've basically already done via `packages/routing`), not a network service.**

A routing decision needs the request's prompt, budget state, and provider health _inline_, with no acceptable added network hop — every microservice call is 1–5ms+ you don't want on your hot path. The right move is:

- Keep routing in-process, called as a function/module.
- Make sure it has **zero framework dependencies** (no Fastify imports inside `packages/routing`) so it _could_ be extracted later without a rewrite.
- Only extract it into its own service if you introduce something genuinely async/heavy inside it (e.g., calling an external routing LLM synchronously on every request is already borderline — that's a case where you might want a fast local fallback if the router-LLM call is slow, not a separate microservice).

### 1.8 Would you redesign the folder structure?

Your current structure (`apps/{api,dashboard}`, `packages/{core,providers,routing,policy-engine,cost-engine,auth,analytics,observability,sdk,cli,shared}`) is already close to right — resist the urge to add more packages. Two changes:

1. Add `packages/tenancy` (or fold into `core`) to own `Organization/Workspace/Membership/Principal` contracts — this is now a first-class domain, not an auth detail.
2. Make sure `packages/policy-engine` is genuinely provider-agnostic and framework-free — it's currently at risk of becoming "budget-check code" rather than a real declarative engine. If it's still mostly `if` statements today, that's the tell.

Don't split further than this pre-Series-A. More packages than domains is a sign of premature modularization, and for a portfolio project it also makes the codebase _harder_ to review in an interview, not easier.

### 1.9 Which enterprise features are missing?

Beyond your list of 9, the ones that come up in every real AI Gateway RFP/procurement conversation:

- **Audit log** (who changed what policy/credential/budget, immutable, exportable) — this is table stakes for SOC2 and usually the first thing enterprise security reviewers ask for.
- **Data residency / prompt retention controls** — configurable "do not log prompt content" per workspace, since prompt logs are often the most sensitive data in the system.
- **Rate limiting per API key / per workspace**, distinct from budget limits (this protects _you_, budgets protect _them_).
- **Webhook/event system** for budget-threshold-crossed, circuit-breaker-tripped, policy-violation events — lets customers integrate with their own alerting instead of only polling your dashboard.
- **SSO/SAML** for the dashboard, once you have real organizations — not urgent now, but worth naming since it's a common enterprise gate.
- **Idempotency keys** on `/v1/chat/completions` for safe client-side retries — small but a real production-readiness signal.

### 1.10 If this were an interview project for an AI Infra role at Anthropic, OpenAI, Microsoft, Datadog, or Stripe

What a staff reviewer would flag first, in order:

1. **"Walk me through what happens when two different workspaces share a provider credential encryption key rotation."** — i.e., can you explain your credential encryption/rotation story in enough depth to convince someone you've thought about the failure mode, not just the happy path?
2. **"Show me the policy engine's actual decision function."** — if it's still `if (cost > budget) reject()` scattered across three packages, that's the gap between "has the right package names" and "has the right architecture."
3. **"What's your test coverage on the routing engine's fallback/circuit-breaker paths?"** — resilience code is exactly the code that's hardest to test and most commonly under-tested; a strong candidate has fault-injection tests here, not just happy-path tests.
4. **"How do you know a policy change didn't silently break someone's budget enforcement?"** — this is really asking about your migration/rollout story for tenant-affecting config changes, which most side projects have never had to think about because they've never had two real tenants.

The gap between "MVP that works" and "what a staff engineer would sign off on" is almost entirely in points 1–4 above — it is _not_ about adding more surface-level features. This is why the roadmap below front-loads schema and policy-engine work over new dashboard pages.

---

## 2. Roadmap

Ordering principle: **fix the foundation (tenancy, identity, policy) before building the features that assume it exists.** Each phase is designed to be shippable and demoable on its own — not a big-bang rewrite.

### v2.0 — Foundation & Enterprise Core

#### v2.0.1 — Tenancy Schema Migration (Organization → Workspace → Membership)

- **Why it matters**: Every other feature in your list (IAM, service accounts, scoped dashboards, router config, budgets) depends on this FK structure existing. Doing it first means you build each downstream feature once.
- **Difficulty**: 5/5 (touches nearly every existing table; requires a data migration for existing users/keys into a default org+workspace)
- **Impact**: 5/5
- **Order**: 1st
- **DB changes**: Add `Organization`, `Workspace`, `Membership`, `Principal` tables. Migrate `ApiKey.user_id → ApiKey.principal_id` + add `ApiKey.workspace_id`. Migrate `ProviderCredential.user_id → workspace_id`. Migrate `ModelAccess.user_id → workspace_id`.
- **API changes**: New `POST /v1/organizations`, `POST /v1/workspaces`, `POST /v1/memberships`. Existing `/v1/api-keys`, `/v1/provider-credentials`, `/v1/model-access` gain a required `workspaceId` and deprecate `userId` (keep it working via a default-workspace shim for backward compat during transition).
- **Pitfalls**: Backward compatibility for existing SDK/CLI users who pass no `workspaceId` — auto-create a "Default" workspace per org on migration so existing integrations don't break silently. Also: don't let this migration block on getting IAM "perfect" — ship the plainest hierarchy first (flat roles, no custom permissions) and iterate.

#### v2.0.2 — RBAC (Owner/Admin/Developer/Viewer)

- **Why it matters**: Unlocks scoped dashboards, safe multi-user orgs, and is the prerequisite most enterprise buyers ask about in the first sales call.
- **Difficulty**: 3/5
- **Impact**: 5/5
- **Order**: 2nd (right after tenancy, before anything else)
- **DB changes**: `Role` (seeded: owner/admin/developer/viewer), `RolePermission` (role → permission string), `Membership.role_id`.
- **API changes**: Every existing mutating endpoint now checks `Membership.role` against a required permission. Add `GET /v1/permissions` (introspection for the dashboard/CLI to know what the current principal can do).
- **Pitfalls**: Don't hardcode role checks inline in route handlers — write one `requirePermission(perm)` middleware so you don't end up with four slightly-different authorization bugs across endpoints. Also decide now whether "Owner" can be removed from a workspace (usually: no, at least one Owner required) — an easy edge case to miss.

#### v2.0.3 — Service Accounts as First-Class Principals

- **Why it matters**: CI/CD, cron jobs, and bots need non-human identities with their own audit trail and revocation — bolting them onto a fake "user" is a security anti-pattern auditors will flag.
- **Difficulty**: 2/5 (mostly free if v2.0.1's `Principal` abstraction is done right)
- **Impact**: 3/5
- **Order**: 3rd
- **DB changes**: `ServiceAccount` table (as in section 1.4). No change to `ApiKey` since it already points at `Principal`.
- **API changes**: `POST /v1/service-accounts`, `POST /v1/service-accounts/:id/keys`.
- **Pitfalls**: Make sure audit logs (v2.0.5) attribute actions to the _service account_, not to the human who created it — otherwise you lose the accountability benefit entirely.

#### v2.0.4 — Bring-Your-Own Router Model (customer-owned routing credentials)

- **Why it matters**: Removes your liability of paying for and seeing every customer's routing prompts on your own OpenAI account — this is a real cost and trust problem at any scale beyond a demo.
- **Difficulty**: 3/5
- **Impact**: 4/5
- **Order**: 4th
- **DB changes**: `RouterConfig` table scoped to `org | workspace | api_key`, referencing a `ProviderCredential`. Resolution order: request override → API key → workspace → org → platform default (your current global env var, kept only as the ultimate fallback for orgs who haven't configured one).
- **API changes**: `PUT /v1/workspaces/:id/router-config`, optional `routing.model`/`routing.credentialId` override in the `/v1/chat/completions` request body.
- **Pitfalls**: Define **fallback behavior explicitly** if the customer's router-LLM call fails — falling back silently to rule-based routing is safer than failing the whole request, but you must surface that in `routemind.routing.reason` so it's not silently degraded quality. Also: router-LLM calls add latency to _every_ auto-routed request — cache routing decisions for identical/similar prompts where safe.

#### v2.0.5 — Audit Log

- **Why it matters**: Not on your original list, but it's the single most commonly requested feature in enterprise security reviews, and it's cheap once Principal/Membership exist.
- **Difficulty**: 2/5
- **Impact**: 4/5
- **Order**: 5th
- **DB changes**: Append-only `AuditEvent(id, workspace_id, principal_id, action, target_type, target_id, metadata_json, created_at)`.
- **API changes**: `GET /v1/workspaces/:id/audit-log` (Admin+ only).
- **Pitfalls**: Write audit events synchronously in the same transaction as the mutation they describe, or you'll eventually have drift between what happened and what got logged.

#### v2.0.6 — Declarative Policy Engine

- **Why it matters**: Turns "developers can't use GPT-5," "max $0.05/request," and your existing budget/model-access checks into rows in one table instead of scattered conditionals — this is what makes Feature 7 _and_ your existing budget guardrails maintainable long-term.
- **Difficulty**: 4/5
- **Impact**: 5/5
- **Order**: 6th
- **DB changes**: `Policy(id, workspace_id, subject_type, subject_id, rule_type, rule_json, priority, created_at)`. Migrate existing hardcoded budget/model-access checks to read from this table.
- **API changes**: `POST /v1/policies`, `GET /v1/policies`, `DELETE /v1/policies/:id`. `/v1/chat/completions` response gains `routemind.policy.evaluatedRules[]` for transparency/debuggability.
- **Pitfalls**: Policy evaluation order matters (deny-overrides vs. first-match) — pick one semantic and document it before customers start writing overlapping rules. Also, evaluating policies must stay fast (sub-ms) since it's in the hot request path — precompute/cache the effective policy set per API key rather than re-querying+re-evaluating every request.

#### v2.0.7 — Workspace/API-Key Scoped Dashboard & Analytics

- **Why it matters**: Falls out almost for free once RBAC + workspace scoping exist — but ship it explicitly since it's customer-visible and closes Feature 5.
- **Difficulty**: 2/5 (given v2.0.1–v2.0.2 are done)
- **Impact**: 3/5
- **Order**: 7th
- **DB changes**: None new — add indexes on `workspace_id`/`api_key_id` on your analytics/request-log tables if not already present.
- **API changes**: Existing analytics endpoints gain workspace/API-key filtering derived from the caller's role (Developer → own keys only; Admin+ → full workspace).
- **Pitfalls**: Watch query performance — analytics queries scoped per-API-key on a large `RequestLog` table need the right composite index (`workspace_id, api_key_id, created_at`) or dashboard load times will degrade as usage grows.

#### v2.0.8 — Model Discovery & Sync (Proposed Feature 4, Option A + periodic sync)

- **Why it matters**: Manual model registration doesn't scale past a handful of providers/models, and it's the most visible day-to-day friction for a new customer onboarding.
- **Difficulty**: 3/5
- **Impact**: 3/5
- **Order**: 8th
- **DB changes**: `ModelCatalog(provider, model, capabilities_json, pricing_json, last_synced_at)` as a platform-level (not per-workspace) cache of what each provider offers; `ModelAccess` continues to reference it per-workspace.
- **API changes**: `POST /v1/workspaces/:id/models/discover` (calls provider's list-models endpoint using the workspace's stored credential), `POST /v1/models/sync` (platform-level cron-triggered, admin-only).
- **Pitfalls**: Provider "list models" APIs are inconsistent in what metadata they return (pricing especially) — you'll likely need a hand-curated pricing table as the source of truth and treat provider discovery as "what's available," not "what it costs."

### v3.0 — Scale, Observability, and Platform Maturity

#### v3.0.1 — Control Plane / Data Plane Physical Separation

- **Why it matters**: Once real traffic exists, isolate blast radius and allow independent scaling — a slow dashboard query should never be able to degrade `/v1/chat/completions` latency.
- **Difficulty**: 4/5
- **Impact**: 4/5
- **Order**: 1st in v3 (do this before adding more traffic-sensitive features)
- **DB changes**: None structurally, but split read/write connection pools; introduce a read replica for analytics/control-plane reads.
- **API changes**: None externally visible; internally, split into two deployable services (or at minimum two process pools) behind the same gateway domain.
- **Pitfalls**: Cache invalidation across the split (e.g., a policy update in control plane needs to propagate to data-plane instances' in-memory policy cache) — this is where a lot of "split too early" pain comes from; make sure you have a pub/sub or short-TTL cache invalidation strategy before splitting, not after.

#### v3.0.2 — OpenTelemetry + Prometheus/Grafana, with Routing as Its Own Span

- **Why it matters**: You can't debug production routing/latency issues without this, and it's the fastest way to look "production-grade" in an interview demo.
- **Difficulty**: 3/5
- **Impact**: 4/5
- **Order**: 2nd
- **DB changes**: None (traces/metrics go to your observability backend, not Postgres).
- **API changes**: None externally; internally, wrap each pipeline stage (firewall, cache, routing, budget, resilience, provider call) in its own span, with **routing as a dedicated child span** that includes routing mode/strategy/decision as span attributes — this directly answers your own question in Feature 8.
- **Pitfalls**: Don't trace prompt/response content itself into your telemetry backend — that's a data-leak risk once you have real customer data; trace metadata only.

#### v3.0.3 — Langfuse Integration (LLM-specific observability)

- **Why it matters**: General tracing (OTel) tells you _system_ health; Langfuse-style tracing tells you _prompt/response quality_ over time — different audiences (SRE vs. AI engineer) want different tools.
- **Difficulty**: 2/5
- **Impact**: 3/5
- **Order**: 3rd
- **DB changes**: None (external integration) — optionally store a `trace_id` on `RequestLog` for cross-referencing.
- **API changes**: Optional `observability.langfuseEnabled` per workspace.
- **Pitfalls**: This is where prompt-retention/data-residency policy (see 1.9) actually matters — don't ship this without a per-workspace opt-out, since it means customer prompts leave your infra.

#### v3.0.4 — Rate Limiting (distinct from budgets)

- **Why it matters**: Protects your infrastructure from abuse/bugs independent of a customer's willingness to pay — budgets protect the customer's wallet, rate limits protect your uptime.
- **Difficulty**: 2/5
- **Impact**: 3/5
- **Order**: 4th
- **DB changes**: None if implemented via Redis token buckets keyed by `api_key_id`/`workspace_id`; optionally a `RateLimitConfig` table for per-tier overrides.
- **API changes**: `429` responses with `Retry-After`; `PUT /v1/workspaces/:id/rate-limits` (admin).
- **Pitfalls**: Coordinate with the circuit-breaker/retry logic you already have — a client retrying against a rate limit looks identical to a client retrying against a provider failure unless your error codes are clearly distinguished.

#### v3.0.5 — Prompt Playground, Versioning, Shadow/A-B Routing (Feature 9, prioritized subset)

- **Why it matters**: Of the six items you listed under Feature 9, **Shadow Routing** and **Prompt Versioning** are the highest-leverage — shadow routing lets customers validate a new router model/policy against real traffic without risk, and versioning is a prerequisite for any of the others (playground, comparison, evals all need a stable notion of "a prompt" to operate on).
- **Difficulty**: 4/5 (shadow routing specifically — running a request twice without doubling customer cost/latency perception requires care)
- **Impact**: 3/5
- **Order**: 5th — deprioritize Prompt Library and Evaluations until real customers ask for them; they're the least differentiated of the six and the most work relative to payoff for a v3.
- **DB changes**: `PromptVersion(id, workspace_id, name, version, template, created_at)`; `ShadowRoutingResult(request_id, primary_result, shadow_result, diverged, created_at)`.
- **API changes**: `routing.shadowModel` field on `/v1/chat/completions` (executes async, doesn't block/charge the primary response); `GET /v1/shadow-routing/results`.
- **Pitfalls**: Shadow requests still cost money against the _customer's_ provider credentials — get explicit opt-in and cost estimates before enabling, or you'll create a surprise-bill support ticket.

---

## 3. Summary Answers to Your 10 Questions

| #   | Question                                                     | Short answer                                                                                                                                                                          |
| --- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Is the architecture still scalable?                          | The pipeline shape is scalable; the **tenancy model underneath it is not** — fix that first.                                                                                          |
| 2   | Biggest architectural mistakes?                              | Tenancy bolted onto User instead of Workspace; platform-owned router-LLM credentials; no unified policy evaluation contract.                                                          |
| 3   | What to refactor before new features?                        | Tenancy schema → identity abstraction → move credentials/config to workspace level → extract policy engine.                                                                           |
| 4   | Would you change the DB schema?                              | Yes — `Organization → Workspace → Membership(Principal, Role)` as the backbone; nearly every existing table's FK moves from `user_id` to `workspace_id`.                              |
| 5   | How should IAM be designed?                                  | RBAC now, modeled as role→permission so it can flex without schema changes; keep policy engine (ABAC-ish rules) as a separate system.                                                 |
| 6   | Separate control plane and data plane?                       | Logically now (connection pools, read replicas); physically only in v3 once traffic justifies it.                                                                                     |
| 7   | Should routing be a microservice?                            | No — keep it in-process, framework-free, extractable later if it ever needs to be.                                                                                                    |
| 8   | Would you redesign the folder structure?                     | Mostly no — add a `tenancy` package, make sure `policy-engine` is genuinely declarative, otherwise it's already close to right.                                                       |
| 9   | Missing enterprise features?                                 | Audit log, prompt-retention controls, rate limiting, webhooks/events, idempotency keys, eventually SSO.                                                                               |
| 10  | What would a staff reviewer at Anthropic/OpenAI/Stripe flag? | Whether the policy engine is a real engine or scattered `if` statements, resilience test coverage, credential rotation story, and rollout safety for tenant-affecting config changes. |

---

_This review is based on the public README, `Architecture.md`, and documented API surface. A few specifics (exact Prisma schema, current test coverage, actual policy-engine implementation) weren't directly inspectable from the repo's rendered files — worth a follow-up pass reading `packages/policy-engine` and `apps/api/prisma/schema.prisma` directly if you want the roadmap refined against the literal current code rather than the documented behavior._

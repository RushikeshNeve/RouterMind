# Phase 1 — Productization

Goal: a stranger can discover RouteMind, sign up, hit a plan limit, upgrade, and pay — with zero manual steps from us.

Work through the checklist below top to bottom. Each unchecked item is one slice: explore first (delegate to the `explorer` subagent), confirm scope, implement, verify with real tests, commit, then update this file's checkbox and the roadmap's session log before stopping. Do not start the next item in the same invocation — that's a separate `/phase-next` run, on purpose, so each slice gets a real checkpoint.

If an item turns out to already be partially done, investigate and report the actual state before either skipping or redoing work — same standing rule as Phase 0.

## Checklist

- [x] **1. Plan & Subscription schema.** `Plan(id, name, price_cents, included_requests, features_json)`, `Subscription(org_id, plan_id, status, stripe_subscription_id, current_period_start, current_period_end)`. Seed four plans: Free, Pro, Team, Enterprise (Enterprise has no self-serve price — flag as "contact sales" in `features_json`). No Stripe wiring yet, schema + seed only.

- [ ] **2. Stripe integration — subscription lifecycle.** Wire real Stripe Billing: checkout session creation for Free→Pro/Team upgrade, webhook handler for `customer.subscription.updated/deleted`/`invoice.payment_failed` keeping `Subscription` in sync. Use Stripe test mode/test keys. Do not touch metered/overage billing yet — flat subscription only.

- [ ] **3. Usage metering pipeline.** `UsageSummary(org_id, period_start, period_end, request_count, token_count)`, aggregated from existing `RequestLog`/`AnalyticsEvent` — reuse that data, don't build a second counting system. Nightly aggregation job (or on-read computation if volume is low enough — decide based on current data volume, report which was chosen and why).

- [ ] **4. Plan-limit enforcement via the policy engine.** Add a `plan_limit` rule type to the existing `evaluatePolicy()` engine (same engine as `budget`/`model_restriction`/`cost_cap` — do not build a parallel enforcement path). A workspace whose org has exceeded its plan's `included_requests` for the period gets blocked with a clear `PLAN_LIMIT_EXCEEDED` reason, same pattern as the other rule types' distinct reason codes.

- [ ] **5. Self-serve billing UI.** Dashboard screen (org-level, Owner/Admin only): current plan, usage against included requests, upgrade/downgrade buttons (Stripe Checkout redirect), payment method, invoice history (Stripe-hosted). Follow the existing RBAC-gated-UI pattern.

- [ ] **6. Model discovery & sync.** `ModelCatalog(provider, model, capabilities_json, pricing_json, last_synced_at)` as a platform-level cache. `POST /v1/workspaces/:id/models/discover` calls the provider's list-models endpoint using the workspace's stored credential. Dashboard: a "discover models" button on the existing model-access screen instead of manual entry.

- [ ] **7. Workspace/API-key scoped analytics.** Audit existing analytics endpoints — confirm they already filter by the caller's role/workspace correctly (RBAC-gated UI work in Phase 0 may have already covered this for some screens). Report actual current state before building anything; only add what's genuinely missing.

- [ ] **8. Pricing page.** Public-facing page (marketing site or a `/pricing` dashboard route, whichever already exists) stating the four plans' real prices/limits — no "contact sales" for Free/Pro/Team. This directly supports the "predictable pricing" positioning from the market research; the numbers must match what Stripe/the `Plan` table actually enforces, not be a separate hardcoded claim.

## Exit criteria for Phase 1

A person who has never spoken to us can: sign up → hit the Free tier's request limit → see a clear upgrade prompt with real pricing → pay with a real (test-mode) credit card → immediately have the limit lifted — end to end, with no manual intervention from us at any step. Write this as an actual Playwright/integration test before declaring Phase 1 done, same standard as Phase 0's exit-criteria test.

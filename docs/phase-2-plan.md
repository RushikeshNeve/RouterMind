# Phase 2 — Trust & Differentiation

Goal: every clause in the "BYO Everything" / "predictable pricing" positioning statement is demonstrably true for at least one real, paying workspace — not just true in the codebase.

Work through the checklist below top to bottom. Each unchecked item is one slice: explore first (delegate to the `explorer` subagent), confirm scope, implement, verify with real tests, commit, then update this file's checkbox and the roadmap's session log before stopping. Do not start the next item in the same invocation — that's a separate `/phase-next` run, on purpose, so each slice gets a real checkpoint.

If an item turns out to already be partially or fully done, investigate and report the actual state before either skipping or redoing work — same standing rule as Phase 0 and Phase 1. Two items below were checked off immediately on creation of this file for exactly that reason: investigation before writing this checklist found they were already fully shipped during earlier phases.

## Checklist

- [x] **1. Harden BYO Router Model: explicit, surfaced fallback behavior.** Already done, verified before writing this checklist rather than assumed: `routemind.routing.reason` (and `routingMetadata.configSource`) are populated on every `/v1/chat/completions` response, with four distinct, exported fallback-reason constants (`LLM_ROUTING_DISABLED_REASON`, `LLM_ROUTING_STRATEGY_SKIP_REASON`, `LLM_ROUTING_CALL_FAILED_REASON`, `LLM_ROUTING_NO_CANDIDATE_MATCH_REASON` in `packages/routing/src/index.ts`) so degraded routing is never silently collapsed into one generic string — this was Phase 0 work (2026-07-19 session log entries) that already satisfies this Phase 2 Ship-list line item in full. Nothing shipped in this slice.

- [x] **2. Rate limiting distinct from budgets.** Already done, verified before writing this checklist: `apps/api/src/infrastructure/rate-limiter.ts` (`RedisRateLimiter`/`InMemoryRateLimiter`) is live-wired into `/v1/chat/completions` (`chat-completions.ts` lines ~251-274), runs _before_ cost-guardrail/plan-limit checks, sets `x-ratelimit-limit`/`-remaining`/`-reset` headers, and returns a real `429 rate_limit_exceeded` — genuinely protecting the platform independent of a customer's willingness to pay, distinct from `Policy`'s `budget`/`plan_limit` rule types. **Known limitation, not blocking**: the limit is a hardcoded 100 requests/hour per API key, not configurable per plan tier or per workspace — the roadmap's own wording only asked for "distinct from budgets," which this already satisfies; per-tier limits are a future refinement, not required to check this off. Nothing shipped in this slice.

- [ ] **3. Data retention / prompt-logging controls, configurable per workspace.** Real, confirmed gap: `LLMResponseCache` (the semantic response cache backing `/v1/cache/*`) persists the full `promptText` and `responseJson` for every cached request, in Postgres, indefinitely, with **no workspace-level control of any kind** — no `Workspace.promptLoggingEnabled` field, no retention-policy table, no per-request opt-out. `RequestLog` itself only stores metadata (tokens, cost, latency, status), not prompt/response content, so the cache table is where the actual sensitive data lives. Add a per-workspace setting (e.g. `Workspace.promptLoggingEnabled`, default `true` so existing behavior doesn't silently change) that, when disabled, skips persisting `promptText`/`responseJson` to the cache for that workspace's requests (exact-match caching can still work off `normalizedPromptHash` + a redacted/omitted body, or the workspace can simply be excluded from caching entirely — a design decision to make during the slice, not pre-decided here). Surface the setting somewhere an operator can actually set it (dashboard or API — no UI exists for workspace-level settings at all today, matching the recurring "no dashboard UI exists yet" pattern from Phase 1).

- [ ] **4. A genuinely honest pricing/trust page: explicit data-handling statements.** Once item 3 ships, the public pricing page (`apps/website/src/components/landing/pricing.tsx`, built in Phase 1 item 8) and/or a dedicated trust/security page should state plainly what gets logged, what doesn't, and that prompt-logging is a real, working per-workspace toggle — not marketing copy describing an aspiration. This is the direct competitive jab at Portkey/Kong's most-criticized pain point (per the market research), and it can't honestly be written until item 3's toggle actually exists to describe.

## Business/GTM work (not engineering — tracked here for visibility, not run via `/phase-next`)

Per docs/roadmap.md's own Phase 2 section, this work starts here, not before, and is explicitly _not_ a coding task a `/phase-next` slice can implement:

- One-page positioning doc (from the market research) turned into an actual landing page.
- 3–5 design partners, ideally teams burned by a Portkey invoice or a Kong contract — recruited through the exact language of the BYO-Everything / transparent-pricing USPs, not generic outreach.
- A case study or two from design partners, focused on the "predictable bill" and "we never see your keys" claims specifically — proof, not adjectives.
- Watch Bifrost's governance roadmap on a monthly cadence — the one competitor whose trajectory could occupy this same positioning first.

## Exit criteria for Phase 2

You can point to a real (even if small) customer paying real money, on a plan whose price they predicted correctly before the invoice arrived, using BYO router credentials — i.e., every clause in the positioning statement is demonstrably true for at least one real workspace, not just true in the codebase. This is a business outcome, not a code-completion checkbox — items 1-4 above are the engineering prerequisites, not the exit criteria itself.

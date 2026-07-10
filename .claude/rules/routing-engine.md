---
globs: ["packages/routing/**/*.ts", "packages/policy-engine/**/*.ts"]
---

# Routing engine / policy engine rules

- Zero Fastify or HTTP-layer imports in these packages — they must be callable as pure functions from tests and from the API layer alike.
- Every routing decision must populate `routing.reason` in its return value — silent fallback is not allowed (this is a documented product trust claim, not a style preference).
- Policy evaluation must stay allocation-light — this runs on every request in the hot path. Flag any change that adds a DB round-trip per request instead of using the cached effective-policy set.
- New routing strategies go through the existing `RoutingStrategy` interface — don't add a parallel if/else branch in the router.

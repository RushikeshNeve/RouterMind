# Architecture

RouteMind follows a modular gateway architecture with clear boundaries between transport, domain contracts, provider adapters, routing, policy evaluation, analytics, and observability.

## Architectural Principles

- Clean architecture: business-facing contracts live outside framework-specific code.
- Dependency inversion: gateway orchestration depends on interfaces, not concrete providers.
- Provider isolation: OpenAI, Anthropic, Gemini, Groq, Ollama, and future providers will be implemented as adapters.
- Policy-driven routing: routing decisions will be influenced by policy, cost, capability, latency, and availability inputs.
- Operational visibility: every request path should eventually emit logs, traces, metrics, and usage events.

## High-Level Components

```text
Client / SDK
    |
    v
Fastify API Gateway
    |
    +--> Auth Package
    +--> Policy Engine
    +--> Routing Engine
    |       |
    |       +--> Cost Engine
    |       +--> Provider Registry
    |
    +--> Provider Adapters
    |
    +--> Analytics
    +--> Observability
```

## Runtime Boundaries

- `apps/api` owns HTTP transport, lifecycle, request context, and dependency composition.
- `packages/core` owns stable domain contracts shared across modules.
- `packages/providers` owns provider adapter interfaces and future adapter registry contracts.
- `packages/routing` owns routing strategy interfaces.
- `packages/policy-engine` owns policy contracts.
- `packages/cost-engine` owns cost estimation contracts.
- `packages/analytics` owns usage-event contracts.
- `packages/observability` owns logging, tracing, and metrics contracts.
- `packages/auth` owns identity and authorization contracts.
- `packages/sdk` will expose client-facing abstractions.

## Data Plane vs Control Plane

Data plane responsibilities:

- Accept AI requests.
- Authenticate and authorize callers.
- Evaluate policies.
- Choose a provider and model.
- Proxy or transform requests.
- Capture response metadata.

Control plane responsibilities:

- Manage provider configuration.
- Manage routing policies.
- Manage model catalogs.
- Expose analytics and cost reporting.
- Manage organization-level settings.

Only the data-plane health endpoint exists today.

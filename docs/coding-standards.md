# Coding Standards

## TypeScript

- Use strict TypeScript.
- Prefer explicit interfaces at package boundaries.
- Avoid `any`.
- Export public contracts through each package `src/index.ts`.
- Keep framework-specific imports out of domain packages.

## Architecture

- Keep packages independently understandable.
- Depend on abstractions across module boundaries.
- Do not introduce business logic in the foundation layer.
- Prefer constructor or factory-based dependency injection once implementations are added.

## Testing

- Use Vitest.
- Unit-test domain behavior in packages.
- Integration-test API behavior in `apps/api`.
- Use mock provider adapters for routing tests.

## Logging

- Use Pino for structured logs.
- Include future correlation IDs in request-scoped logs.
- Do not log secrets, API keys, prompts, or provider credentials by default.

## Formatting

Run:

```bash
npm run format
```

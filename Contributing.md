# Contributing

RouteMind is structured like an infrastructure project. Contributions should preserve module boundaries and avoid coupling framework code to domain contracts.

## Development Workflow

```bash
npm install
npm run lint
npm run format:check
npm run build
npm test
```

## Commit Style

This repository uses Conventional Commits.

Examples:

- `feat: add provider registry interface`
- `fix: correct health response schema`
- `docs: document routing engine responsibilities`

## Pull Request Expectations

- Keep changes focused.
- Add or update tests when behavior changes.
- Update documentation when architecture or public contracts change.
- Do not add provider integrations without an accepted design.

## Design Expectations

- Prefer interfaces at package boundaries.
- Keep transport-specific code inside `apps/api`.
- Keep reusable domain contracts inside packages.
- Avoid business logic in infrastructure wiring.

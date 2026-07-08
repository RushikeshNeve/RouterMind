# @routemind/cli

Developer CLI for RouteMind.

## Installation

```bash
npm install -g @routemind/cli
```

From this monorepo:

```bash
npm run build -w @routemind/cli
node packages/cli/dist/index.js --help
```

## Login

Store your RouteMind API key locally:

```bash
routemind login
```

The CLI writes:

```text
~/.routemind/config.json
```

Config fields:

- `apiKey`
- `baseUrl`

The default base URL is `http://localhost:3000`.

## Chat

```bash
routemind chat "Help me debug this TypeScript error"
```

With routing options:

```bash
routemind chat "debug this code" \
  --model auto \
  --strategy quality_first \
  --routing-mode llm_assisted \
  --max-cost-tier medium \
  --max-estimated-cost-usd 0.02
```

Stream tokens as they arrive:

```bash
routemind chat "Explain this stack trace" --stream
```

Default output:

```text
Answer:
...

Routing:
- Requested: auto
- Selected: gpt-4o
- Provider: openai
- Cost: $0.0021
- Latency: 1320ms
- Strategy: balanced
```

## Health

```bash
routemind health
```

Shows provider/model status, average latency, success rate, and sample size.

## Analytics

```bash
routemind analytics
```

Shows total requests, success rate, spend, token usage, latency, fallback usage, and guardrail blocks.

## Costs

```bash
routemind costs
```

Shows total spend, average cost per request, request count, and guardrail blocks.

## Models

```bash
routemind models
```

Lists models reported by provider health.

## Circuit Breakers

```bash
routemind circuit-breakers
```

Lists circuit breaker state per provider/model.

## Config

```bash
routemind config
```

The API key is masked in human-readable output.

## JSON Mode

Use `--json` with any command to print raw JSON:

```bash
routemind --json analytics
routemind --json health
routemind --json chat "summarize this incident"
```

## Global Options

```bash
routemind --api-key rm_test_... --base-url http://localhost:3000 health
```

Supported global options:

- `--api-key`
- `--base-url`
- `--json`

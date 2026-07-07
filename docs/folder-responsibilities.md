# Folder Responsibilities

## apps/api

Owns the Fastify process, transport concerns, health checks, configuration loading, and future dependency composition.

## apps/dashboard

Reserved for the future operator dashboard. No product UI is implemented yet.

## packages/core

Defines stable platform contracts that represent AI requests, responses, gateway context, and gateway errors.

## packages/providers

Defines the provider adapter boundary. Concrete provider integrations will be added later.

## packages/routing

Defines routing decision and strategy contracts.

## packages/auth

Defines authentication and authorization boundaries.

## packages/analytics

Defines usage event and analytics sink contracts.

## packages/cost-engine

Defines pricing and cost estimation contracts.

## packages/observability

Defines logger, metrics, and tracing contracts.

## packages/policy-engine

Defines policy input and evaluation contracts.

## packages/shared

Contains shared TypeScript and Zod utilities that are not owned by a specific domain package.

## packages/sdk

Reserved for future public client SDK contracts.

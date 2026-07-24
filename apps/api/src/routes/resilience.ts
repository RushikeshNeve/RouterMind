import type { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { ApiConfig } from "../config.js";
import type { CircuitBreakerService } from "../infrastructure/circuit-breaker-service.js";
import type { ProviderAttemptLogStore } from "../infrastructure/provider-attempt-log-store.js";
import { ensureSameWorkspace, requirePermission } from "../infrastructure/rbac.js";

const providerParamsSchema = z.object({
  provider: z.string().min(1),
});

const providerModelParamsSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
});

const workspaceParamsSchema = z.object({
  workspaceId: z.string().min(1),
});

const attemptQuerySchema = z.object({
  userId: z.string().min(1).optional(),
  provider: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  status: z.enum(["success", "failed"]).optional(),
  limit: z.coerce.number().int().positive().max(500).optional(),
});

export function registerResilienceRoutes(
  app: FastifyInstance,
  dependencies: {
    readonly config: ApiConfig;
    readonly prisma: PrismaClient;
    readonly circuitBreakerService: CircuitBreakerService;
    readonly providerAttemptLogStore: ProviderAttemptLogStore;
  },
): void {
  app.get("/v1/resilience/circuit-breakers", async () => {
    const circuitBreakers = await dependencies.circuitBreakerService.list();
    return { circuitBreakers: circuitBreakers.map(serializeCircuitBreaker) };
  });

  app.get("/v1/resilience/circuit-breakers/:provider", async (request, reply) => {
    const params = providerParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({ error: { message: "Invalid provider." } });
    }

    const circuitBreakers = await dependencies.circuitBreakerService.list(params.data.provider);
    return {
      provider: params.data.provider,
      circuitBreakers: circuitBreakers.map(serializeCircuitBreaker),
    };
  });

  app.post("/v1/resilience/circuit-breakers/:provider/:model/reset", async (request, reply) => {
    const params = providerModelParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({ error: { message: "Invalid provider or model." } });
    }

    await dependencies.circuitBreakerService.reset(params.data.provider, params.data.model);
    const circuitBreaker = await dependencies.circuitBreakerService.getState(
      params.data.provider,
      params.data.model,
    );

    return { circuitBreaker: serializeCircuitBreaker(circuitBreaker) };
  });

  // Workspace-scoped: ProviderAttemptLog carries real per-tenant request
  // data, same class of endpoint as /v1/workspaces/:workspaceId/analytics/*
  // (unlike circuit-breakers/health above, which are platform-wide
  // operational state with no tenant dimension to violate).
  app.get(
    "/v1/workspaces/:workspaceId/resilience/provider-attempts",
    { preHandler: requirePermission(dependencies.prisma, "analytics.read", dependencies.config) },
    async (request, reply) => {
      const params = workspaceParamsSchema.safeParse(request.params);
      const query = attemptQuerySchema.safeParse(request.query);
      if (!params.success || !query.success) {
        return reply.status(400).send({ error: { message: "Invalid provider attempt filters." } });
      }
      if (!ensureSameWorkspace(request, params.data.workspaceId, reply)) {
        return reply;
      }

      const attempts = await dependencies.providerAttemptLogStore.list({
        ...query.data,
        workspaceId: params.data.workspaceId,
      });
      return { attempts: attempts.map(serializeAttemptLog) };
    },
  );
}

function serializeCircuitBreaker(state: Awaited<ReturnType<CircuitBreakerService["getState"]>>) {
  return {
    id: state.id,
    provider: state.provider,
    model: state.model,
    state: state.state,
    failureCount: state.failureCount,
    openedAt: state.openedAt?.toISOString(),
    halfOpenAt: state.halfOpenAt?.toISOString(),
    lastFailureAt: state.lastFailureAt?.toISOString(),
    lastSuccessAt: state.lastSuccessAt?.toISOString(),
    createdAt: state.createdAt.toISOString(),
    updatedAt: state.updatedAt.toISOString(),
  };
}

function serializeAttemptLog(
  attempt: Awaited<ReturnType<ProviderAttemptLogStore["list"]>>[number],
) {
  return {
    id: attempt.id,
    requestLogId: attempt.requestLogId,
    userId: attempt.userId,
    provider: attempt.provider,
    model: attempt.model,
    attemptNumber: attempt.attemptNumber,
    status: attempt.status,
    latencyMs: attempt.latencyMs,
    errorType: attempt.errorType,
    errorMessage: attempt.errorMessage,
    createdAt: attempt.createdAt.toISOString(),
  };
}

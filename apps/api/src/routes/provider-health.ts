import type { ProviderId } from "@routemind/providers";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type {
  ProviderHealthMetric,
  ProviderHealthService,
} from "../infrastructure/provider-health-service.js";

const providerParamsSchema = z.object({
  provider: z.string().min(1),
});

const providerModelParamsSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
});

export function registerProviderHealthRoutes(
  app: FastifyInstance,
  providerHealthService: ProviderHealthService,
): void {
  app.get("/v1/health/providers", async () => {
    const metrics = await providerHealthService.list();
    return groupMetrics(metrics);
  });

  app.get("/v1/health/providers/:provider", async (request, reply) => {
    const params = providerParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({ error: { message: "Invalid provider." } });
    }

    const metrics = await providerHealthService.list(params.data.provider);
    return serializeProviderGroup(params.data.provider, metrics);
  });

  app.get("/v1/health/providers/:provider/:model", async (request, reply) => {
    const params = providerModelParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({ error: { message: "Invalid provider or model." } });
    }

    const metric = await providerHealthService.get(params.data.provider, params.data.model);
    if (!metric) {
      return reply.status(404).send({ error: { message: "Provider health metric not found." } });
    }

    return serializeProviderGroup(metric.provider, [metric]);
  });
}

function groupMetrics(metrics: readonly ProviderHealthMetric[]) {
  const providers = [...new Set(metrics.map((metric) => metric.provider))].sort();

  return {
    providers: providers.map((provider) =>
      serializeProviderGroup(
        provider,
        metrics.filter((metric) => metric.provider === provider),
      ),
    ),
  };
}

function serializeProviderGroup(provider: ProviderId, metrics: readonly ProviderHealthMetric[]) {
  return {
    provider,
    models: metrics
      .map((metric) => ({
        model: metric.model,
        status: metric.status,
        avgLatencyMs: metric.avgLatencyMs,
        p95LatencyMs: metric.p95LatencyMs,
        successRate: metric.successRate,
        errorRate: metric.errorRate,
        timeoutRate: metric.timeoutRate,
        rateLimitRate: metric.rateLimitRate,
        sampleSize: metric.sampleSize,
        lastErrorCode: metric.lastErrorCode,
        lastErrorMessage: metric.lastErrorMessage,
        lastCheckedAt: metric.lastCheckedAt.toISOString(),
        updatedAt: metric.updatedAt.toISOString(),
      }))
      .sort((a, b) => a.model.localeCompare(b.model)),
  };
}

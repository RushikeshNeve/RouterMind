import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AnalyticsFilters, AnalyticsService } from "../infrastructure/analytics-service.js";

const analyticsQuerySchema = z.object({
  userId: z.string().min(1).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
});

export function registerAnalyticsRoutes(
  app: FastifyInstance,
  analyticsService: AnalyticsService,
): void {
  app.get("/v1/analytics/summary", async (request, reply) => {
    const filters = parseFilters(request.query);
    if (!filters.success) {
      return reply.status(400).send({ error: { message: "Invalid analytics filters." } });
    }

    return analyticsService.summary(filters.data);
  });

  app.get("/v1/analytics/models", async (request, reply) => {
    const filters = parseFilters(request.query);
    if (!filters.success) {
      return reply.status(400).send({ error: { message: "Invalid analytics filters." } });
    }

    return { models: await analyticsService.models(filters.data) };
  });

  app.get("/v1/analytics/providers", async (request, reply) => {
    const filters = parseFilters(request.query);
    if (!filters.success) {
      return reply.status(400).send({ error: { message: "Invalid analytics filters." } });
    }

    return { providers: await analyticsService.providers(filters.data) };
  });

  app.get("/v1/analytics/errors", async (request, reply) => {
    const filters = parseFilters(request.query);
    if (!filters.success) {
      return reply.status(400).send({ error: { message: "Invalid analytics filters." } });
    }

    return { errors: await analyticsService.errors(filters.data) };
  });

  app.get("/v1/analytics/costs", async (request, reply) => {
    const filters = parseFilters(request.query);
    if (!filters.success) {
      return reply.status(400).send({ error: { message: "Invalid analytics filters." } });
    }

    return { costs: await analyticsService.costs(filters.data) };
  });

  app.get("/v1/analytics/latency", async (request, reply) => {
    const filters = parseFilters(request.query);
    if (!filters.success) {
      return reply.status(400).send({ error: { message: "Invalid analytics filters." } });
    }

    return { latency: await analyticsService.latency(filters.data) };
  });

  app.get("/v1/analytics/requests", async (request, reply) => {
    const filters = parseFilters(request.query);
    if (!filters.success) {
      return reply.status(400).send({ error: { message: "Invalid analytics filters." } });
    }

    return {
      requests: await analyticsService.requests(filters.data, filters.limit ?? 50),
    };
  });
}

function parseFilters(
  query: unknown,
):
  | { readonly success: true; readonly data: AnalyticsFilters; readonly limit?: number }
  | { readonly success: false } {
  const parsed = analyticsQuerySchema.safeParse(query);
  if (!parsed.success) {
    return { success: false };
  }

  return {
    success: true,
    data: {
      userId: parsed.data.userId,
      from: parsed.data.from ? new Date(parsed.data.from) : undefined,
      to: parsed.data.to ? new Date(parsed.data.to) : undefined,
    },
    limit: parsed.data.limit,
  };
}

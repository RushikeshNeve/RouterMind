import type { PrismaClient } from "@prisma/client";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { ApiConfig } from "../config.js";
import { ensureSameWorkspace, requirePermission } from "../infrastructure/rbac.js";
import type { AnalyticsFilters, AnalyticsService } from "../infrastructure/analytics-service.js";

const workspaceParamsSchema = z.object({
  workspaceId: z.string().min(1),
});

const analyticsQuerySchema = z.object({
  userId: z.string().min(1).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
});

export function registerAnalyticsRoutes(
  app: FastifyInstance,
  dependencies: {
    readonly config: ApiConfig;
    readonly prisma: PrismaClient;
    readonly analyticsService: AnalyticsService;
  },
): void {
  const { config, prisma, analyticsService } = dependencies;
  const preHandler = requirePermission(prisma, "analytics.read", config);

  app.get(
    "/v1/workspaces/:workspaceId/analytics/summary",
    { preHandler },
    async (request, reply) => {
      const filters = parseFilters(request, reply);
      if (!filters) return reply;

      return analyticsService.summary(filters.data);
    },
  );

  app.get(
    "/v1/workspaces/:workspaceId/analytics/models",
    { preHandler },
    async (request, reply) => {
      const filters = parseFilters(request, reply);
      if (!filters) return reply;

      return { models: await analyticsService.models(filters.data) };
    },
  );

  app.get(
    "/v1/workspaces/:workspaceId/analytics/providers",
    { preHandler },
    async (request, reply) => {
      const filters = parseFilters(request, reply);
      if (!filters) return reply;

      return { providers: await analyticsService.providers(filters.data) };
    },
  );

  app.get(
    "/v1/workspaces/:workspaceId/analytics/errors",
    { preHandler },
    async (request, reply) => {
      const filters = parseFilters(request, reply);
      if (!filters) return reply;

      return { errors: await analyticsService.errors(filters.data) };
    },
  );

  app.get("/v1/workspaces/:workspaceId/analytics/costs", { preHandler }, async (request, reply) => {
    const filters = parseFilters(request, reply);
    if (!filters) return reply;

    return { costs: await analyticsService.costs(filters.data) };
  });

  app.get(
    "/v1/workspaces/:workspaceId/analytics/latency",
    { preHandler },
    async (request, reply) => {
      const filters = parseFilters(request, reply);
      if (!filters) return reply;

      return { latency: await analyticsService.latency(filters.data) };
    },
  );

  app.get(
    "/v1/workspaces/:workspaceId/analytics/requests",
    { preHandler },
    async (request, reply) => {
      const filters = parseFilters(request, reply);
      if (!filters) return reply;

      return {
        requests: await analyticsService.requests(filters.data, filters.limit ?? 50),
      };
    },
  );
}

// Validates the :workspaceId path param and confirms the caller's RBAC
// context actually belongs to it (ensureSameWorkspace) before building
// AnalyticsFilters -- workspaceId always comes from that validated param,
// never from an untrusted query string, so the optional userId filter below
// can never escape the workspace boundary either. Returns undefined (having
// already sent a response) when validation/authorization fails.
function parseFilters(
  request: FastifyRequest,
  reply: FastifyReply,
): { readonly data: AnalyticsFilters; readonly limit?: number } | undefined {
  const params = workspaceParamsSchema.safeParse(request.params);
  const query = analyticsQuerySchema.safeParse(request.query);
  if (!params.success || !query.success) {
    void reply.status(400).send({ error: { message: "Invalid analytics filters." } });
    return undefined;
  }

  if (!ensureSameWorkspace(request, params.data.workspaceId, reply)) {
    return undefined;
  }

  return {
    data: {
      userId: query.data.userId,
      workspaceId: params.data.workspaceId,
      from: query.data.from ? new Date(query.data.from) : undefined,
      to: query.data.to ? new Date(query.data.to) : undefined,
    },
    limit: query.data.limit,
  };
}

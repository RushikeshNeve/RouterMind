import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { CacheService } from "../infrastructure/cache-service.js";

const cacheQuerySchema = z.object({
  userId: z.string().min(1).optional(),
});

export function registerCacheRoutes(app: FastifyInstance, cacheService: CacheService): void {
  app.get("/v1/cache/stats", async (request, reply) => {
    const parsed = cacheQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: { message: "Invalid cache filters." } });
    }

    return cacheService.stats(parsed.data.userId);
  });

  app.get("/v1/cache/entries", async (request, reply) => {
    const parsed = cacheQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: { message: "Invalid cache filters." } });
    }

    const entries = await cacheService.entries(parsed.data.userId);
    return {
      entries: entries.map((entry) => ({
        id: entry.id,
        userId: entry.userId,
        cacheKey: entry.cacheKey,
        normalizedPromptHash: entry.normalizedPromptHash,
        promptText: entry.promptText,
        model: entry.model,
        provider: entry.provider,
        inputTokens: entry.inputTokens,
        outputTokens: entry.outputTokens,
        costSavedUsd: entry.costSavedUsd,
        hitCount: entry.hitCount,
        expiresAt: entry.expiresAt.toISOString(),
        createdAt: entry.createdAt.toISOString(),
        updatedAt: entry.updatedAt.toISOString(),
      })),
    };
  });

  app.delete("/v1/cache", async (request, reply) => {
    const parsed = cacheQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: { message: "Invalid cache filters." } });
    }

    return {
      deleted: await cacheService.invalidateUserCache(parsed.data.userId),
    };
  });
}

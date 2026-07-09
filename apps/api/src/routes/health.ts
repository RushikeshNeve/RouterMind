import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { ReadinessService } from "../infrastructure/readiness-service.js";

const healthResponseSchema = z.object({
  service: z.literal("routemind-api"),
  status: z.literal("ok"),
  timestamp: z.string().datetime(),
  version: z.string(),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;

export function registerHealthRoutes(
  app: FastifyInstance,
  readinessService: ReadinessService,
): void {
  app.get("/health", (): HealthResponse => {
    return healthResponseSchema.parse({
      service: "routemind-api",
      status: "ok",
      timestamp: new Date().toISOString(),
      version: "0.1.0",
    });
  });

  app.get("/ready", async (_request, reply) => {
    const readiness = await readinessService.check();
    return reply.status(readiness.status === "ready" ? 200 : 503).send(readiness);
  });
}

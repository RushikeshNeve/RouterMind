import type { FastifyInstance } from "fastify";
import { z } from "zod";

const healthResponseSchema = z.object({
  service: z.literal("routemind-api"),
  status: z.literal("ok"),
  timestamp: z.string().datetime(),
  version: z.string(),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;

export function registerHealthRoutes(app: FastifyInstance): void {
  app.get("/health", (): HealthResponse => {
    return healthResponseSchema.parse({
      service: "routemind-api",
      status: "ok",
      timestamp: new Date().toISOString(),
      version: "0.1.0",
    });
  });
}

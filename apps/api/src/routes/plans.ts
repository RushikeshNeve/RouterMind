import type { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";

/**
 * Public, unauthenticated -- plan names/prices/limits aren't tenant-scoped
 * secret data (they're the same for every prospective customer), and the
 * billing UI needs them before a caller has necessarily picked a workspace
 * yet. Matches the "no contact-sales ambiguity" pricing transparency this
 * project's docs already commit to (see Phase 1 item 8).
 */
export function registerPlanRoutes(
  app: FastifyInstance,
  dependencies: { readonly prisma: PrismaClient },
): void {
  app.get("/v1/plans", async (_request, reply) => {
    const plans = await dependencies.prisma.plan.findMany({ orderBy: { priceCents: "asc" } });
    return reply.status(200).send({
      plans: plans.map((plan) => ({
        id: plan.id,
        name: plan.name,
        priceCents: plan.priceCents,
        includedRequests: plan.includedRequests,
        featuresJson: plan.featuresJson,
        selfServe: plan.paddlePriceId !== null,
      })),
    });
  });
}

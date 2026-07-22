import type { Prisma, PrismaClient } from "@prisma/client";

/**
 * Provisional pricing, not yet validated with a real customer -- see
 * docs/phase-1-plan.md item 8 (the public pricing page must read these
 * numbers directly from this table, not restate them separately) and
 * docs/roadmap.md's "Recommended plan structure" for the reasoning behind
 * each tier's gated features. Revisit before Phase 1's Stripe wiring
 * (item 2) goes live.
 */
export const PLAN_SEEDS: ReadonlyArray<{
  readonly name: string;
  readonly priceCents: number;
  readonly includedRequests: number | null;
  readonly featuresJson: Prisma.InputJsonObject;
}> = [
  {
    name: "Free",
    priceCents: 0,
    includedRequests: 10_000,
    featuresJson: {
      routingModes: ["rule_based", "score_based"],
    },
  },
  {
    name: "Pro",
    priceCents: 5_900,
    includedRequests: 100_000,
    featuresJson: {
      routingModes: ["rule_based", "score_based", "llm_assisted"],
      byoRouterModel: true,
      promptFirewall: true,
      multiWorkspace: true,
    },
  },
  {
    name: "Team",
    priceCents: 19_900,
    includedRequests: 1_000_000,
    featuresJson: {
      routingModes: ["rule_based", "score_based", "llm_assisted"],
      byoRouterModel: true,
      promptFirewall: true,
      multiWorkspace: true,
      serviceAccounts: true,
      policyEngine: true,
      auditLog: true,
      scopedDashboards: true,
    },
  },
  {
    name: "Enterprise",
    priceCents: 0,
    includedRequests: null,
    featuresJson: {
      routingModes: ["rule_based", "score_based", "llm_assisted"],
      byoRouterModel: true,
      promptFirewall: true,
      multiWorkspace: true,
      serviceAccounts: true,
      policyEngine: true,
      auditLog: true,
      scopedDashboards: true,
      sso: true,
      dedicatedInfra: true,
      compliance: true,
      customSla: true,
      contactSales: true,
    },
  },
];

/**
 * Unlike seed-rbac.ts's upsert (create-only, `update: {}`), this always
 * syncs existing rows to the current PLAN_SEEDS values on re-run --
 * pricing/limits are far more likely to be revised before go-live than the
 * RBAC permission taxonomy is, and a silent no-op update would make it easy
 * to think a price change had taken effect when it hadn't.
 */
export async function seedPlans(prisma: PrismaClient): Promise<void> {
  for (const plan of PLAN_SEEDS) {
    await prisma.plan.upsert({
      where: { name: plan.name },
      create: plan,
      update: {
        priceCents: plan.priceCents,
        includedRequests: plan.includedRequests,
        featuresJson: plan.featuresJson,
      },
    });
    console.log(
      `Seeded plan "${plan.name}" (${plan.priceCents === 0 && plan.name === "Enterprise" ? "contact sales" : `$${(plan.priceCents / 100).toFixed(2)}/mo`}, ${plan.includedRequests?.toLocaleString("en-US") ?? "custom"} requests/mo).`,
    );
  }
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/seed-plans.ts")) {
  const { PrismaClient } = await import("@prisma/client");
  const { loadConfig } = await import("../config.js");
  loadConfig();
  const prisma = new PrismaClient();
  try {
    await seedPlans(prisma);
  } finally {
    await prisma.$disconnect();
  }
}

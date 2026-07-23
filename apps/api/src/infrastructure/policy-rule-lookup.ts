import type { PrismaClient } from "@prisma/client";
import type { PolicyRuleLookup, PolicyRuleRow, PolicySubjectType } from "@routemind/policy-engine";

import { computeUsageSummary, defaultUsagePeriod } from "./usage-summary-service.js";

export class PrismaPolicyRuleLookup implements PolicyRuleLookup {
  constructor(private readonly prisma: PrismaClient) {}

  async findRulesForWorkspace(workspaceId: string): Promise<readonly PolicyRuleRow[]> {
    const rows = await this.prisma.policy.findMany({ where: { workspaceId } });

    const rules: PolicyRuleRow[] = rows.map((row) => ({
      id: row.id,
      workspaceId: row.workspaceId,
      subjectType: row.subjectType as PolicySubjectType,
      subjectId: row.subjectId,
      ruleType: row.ruleType as PolicyRuleRow["ruleType"],
      ruleJson: row.ruleJson,
      priority: row.priority,
      createdAt: row.createdAt,
    }));

    const planLimitRule = await this.buildPlanLimitRule(workspaceId);
    if (planLimitRule) {
      rules.push(planLimitRule);
    }

    return rules;
  }

  // plan_limit is never a real Policy row -- it's synthesized here on every
  // call from the org's Plan/Subscription/usage, not admin-configured. This
  // keeps evaluatePolicy() itself unaware of where a rule came from (same
  // engine, no parallel enforcement path) while avoiding the need to
  // provision/maintain a real Policy row per workspace whenever a plan or
  // its usage changes.
  private async buildPlanLimitRule(workspaceId: string): Promise<PolicyRuleRow | undefined> {
    const workspace = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { organizationId: true },
    });
    if (!workspace?.organizationId) {
      return undefined;
    }
    const organizationId = workspace.organizationId;

    const subscription = await this.prisma.subscription.findUnique({
      where: { organizationId },
      include: { plan: true },
    });

    // An org with no Subscription row is implicitly on Free (Free never
    // goes through Paddle checkout, so it never gets a Subscription row) --
    // falls back to the seeded "Free" plan by name so Free-tier limits are
    // still enforced, matching Phase 1's exit criteria ("hit the Free
    // tier's request limit").
    const plan =
      subscription?.plan ?? (await this.prisma.plan.findUnique({ where: { name: "Free" } }));
    if (!plan || plan.includedRequests === null) {
      return undefined;
    }

    const { periodStart, periodEnd } = defaultUsagePeriod(
      subscription
        ? {
            currentPeriodStart: subscription.currentPeriodStart,
            currentPeriodEnd: subscription.currentPeriodEnd,
          }
        : null,
    );
    const usage = await computeUsageSummary(this.prisma, {
      organizationId,
      periodStart,
      periodEnd,
    });

    return {
      id: `plan_limit:${organizationId}`,
      workspaceId,
      subjectType: "workspace",
      subjectId: "",
      ruleType: "plan_limit",
      ruleJson: { maxRequests: plan.includedRequests, currentRequestCount: usage.requestCount },
      priority: 0,
      createdAt: new Date(0),
    };
  }
}

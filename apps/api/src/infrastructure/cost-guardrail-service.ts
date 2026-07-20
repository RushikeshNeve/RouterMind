import type { PrismaClient } from "@prisma/client";
import { evaluatePolicy } from "@routemind/policy-engine";

import { PrismaPolicyRuleLookup } from "./policy-rule-lookup.js";

export interface CostGuardrailCheck {
  allowed: boolean;
  errorCode?: "BUDGET_EXCEEDED" | "QUOTA_EXCEEDED" | "REQUEST_COST_LIMIT_EXCEEDED";
  message?: string;
  budgetRemainingUsd?: number;
  budgetUsagePercent?: number;
  quotaRemainingRequests?: number;
  quotaRemainingTokens?: number;
}

// Mirrors apps/api/src/routes/auth.ts's own private capitalize() -- already
// duplicated once (invites.ts) rather than exported from auth.ts, so a
// third small local copy here matches existing practice.
function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export class CostGuardrailService {
  constructor(private readonly prisma: PrismaClient) {}

  async checkBeforeRequest(input: {
    userId: string;
    workspaceId?: string;
    apiKeyId?: string;
    workspaceRole?: "owner" | "admin" | "developer" | "viewer";
    estimatedCostUsd: number;
    estimatedTokens: number;
    maxEstimatedCostUsd?: number;
  }): Promise<CostGuardrailCheck> {
    if (
      input.maxEstimatedCostUsd !== undefined &&
      input.estimatedCostUsd > input.maxEstimatedCostUsd
    ) {
      return {
        allowed: false,
        errorCode: "REQUEST_COST_LIMIT_EXCEEDED",
        message: "Estimated request cost exceeds request-level limit.",
      };
    }

    const budget = await this.prisma.userBudget.findFirst({
      where: {
        ...(input.workspaceId ? { workspaceId: input.workspaceId } : { userId: input.userId }),
        isActive: true,
        resetAt: { gt: new Date() },
      },
      orderBy: { createdAt: "desc" },
    });

    if (budget && input.workspaceId) {
      // Workspace-scoped: the threshold now lives declaratively in Policy
      // rows, evaluated via the policy engine -- UserBudget only tracks
      // currentSpendUsd/resetAt state going forward for this path.
      // UserBudget.maxSpendUsd is no longer read here; it's vestigial for
      // workspace-scoped budgets specifically.
      let roleId: string | undefined;
      if (input.workspaceRole) {
        const role = await this.prisma.role.findUnique({
          where: { name: capitalize(input.workspaceRole) },
        });
        roleId = role?.id;
      }

      const policyResult = await evaluatePolicy(
        {
          workspaceId: input.workspaceId,
          roleId,
          userId: input.userId,
          apiKeyId: input.apiKeyId,
          estimatedCostUsd: input.estimatedCostUsd,
          currentSpendUsd: budget.currentSpendUsd,
        },
        new PrismaPolicyRuleLookup(this.prisma),
      );

      if (!policyResult.allow) {
        const maxSpendUsd = (policyResult.matchedRule?.ruleJson as { maxSpendUsd?: number })
          ?.maxSpendUsd;
        return {
          allowed: false,
          errorCode: "BUDGET_EXCEEDED",
          message: policyResult.reason,
          budgetRemainingUsd:
            maxSpendUsd !== undefined
              ? Math.max(0, maxSpendUsd - budget.currentSpendUsd)
              : undefined,
          budgetUsagePercent:
            maxSpendUsd !== undefined ? (budget.currentSpendUsd / maxSpendUsd) * 100 : undefined,
        };
      }
    } else if (budget) {
      // Legacy, pre-tenancy path: a UserBudget row with no workspaceId has
      // no Policy-table equivalent (Policy.workspaceId is a required FK),
      // since this only exists for users onboarded before workspace-scoped
      // credentials/budgets existed (onboarding.ts's still-open, unmigrated
      // surface). Preserved exactly as before rather than silently dropped.
      const projectedSpend = budget.currentSpendUsd + input.estimatedCostUsd;

      if (projectedSpend > budget.maxSpendUsd) {
        return {
          allowed: false,
          errorCode: "BUDGET_EXCEEDED",
          message: "User budget exceeded.",
          budgetRemainingUsd: Math.max(0, budget.maxSpendUsd - budget.currentSpendUsd),
          budgetUsagePercent: (budget.currentSpendUsd / budget.maxSpendUsd) * 100,
        };
      }
    }

    const quota = await this.prisma.usageQuota.findFirst({
      where: {
        ...(input.workspaceId ? { workspaceId: input.workspaceId } : { userId: input.userId }),
        isActive: true,
        resetAt: { gt: new Date() },
      },
      orderBy: { createdAt: "desc" },
    });

    if (quota) {
      if (
        quota.currentRequests + 1 > quota.maxRequests ||
        quota.currentTokens + input.estimatedTokens > quota.maxTokens
      ) {
        return {
          allowed: false,
          errorCode: "QUOTA_EXCEEDED",
          message: "User quota exceeded.",
          quotaRemainingRequests: Math.max(0, quota.maxRequests - quota.currentRequests),
          quotaRemainingTokens: Math.max(0, quota.maxTokens - quota.currentTokens),
        };
      }
    }

    // budget.maxSpendUsd is only authoritative for the legacy, workspace-less
    // path -- for workspace-scoped budgets the real threshold now lives in
    // Policy rows, and reporting against the (now-vestigial) UserBudget
    // column here would drift out of sync with whatever a Policy rule
    // actually says. Rather than re-querying Policy just for this cosmetic
    // reporting field, workspace-scoped allows simply don't report a
    // remaining/percent figure.
    const isLegacyBudgetPath = budget !== null && !input.workspaceId;

    return {
      allowed: true,
      budgetRemainingUsd: isLegacyBudgetPath
        ? Math.max(0, budget.maxSpendUsd - budget.currentSpendUsd)
        : undefined,
      budgetUsagePercent: isLegacyBudgetPath
        ? (budget.currentSpendUsd / budget.maxSpendUsd) * 100
        : undefined,
      quotaRemainingRequests: quota
        ? Math.max(0, quota.maxRequests - quota.currentRequests)
        : undefined,
      quotaRemainingTokens: quota ? Math.max(0, quota.maxTokens - quota.currentTokens) : undefined,
    };
  }

  async recordUsage(input: {
    userId: string;
    workspaceId?: string;
    actualCostUsd: number;
    totalTokens: number;
  }): Promise<void> {
    await this.prisma.userBudget.updateMany({
      where: {
        ...(input.workspaceId ? { workspaceId: input.workspaceId } : { userId: input.userId }),
        isActive: true,
        resetAt: { gt: new Date() },
      },
      data: {
        currentSpendUsd: {
          increment: input.actualCostUsd,
        },
      },
    });

    await this.prisma.usageQuota.updateMany({
      where: {
        ...(input.workspaceId ? { workspaceId: input.workspaceId } : { userId: input.userId }),
        isActive: true,
        resetAt: { gt: new Date() },
      },
      data: {
        currentRequests: {
          increment: 1,
        },
        currentTokens: {
          increment: input.totalTokens,
        },
      },
    });
  }
}

import type { PrismaClient } from "@prisma/client";

export interface CostGuardrailCheck {
  allowed: boolean;
  errorCode?: "BUDGET_EXCEEDED" | "QUOTA_EXCEEDED" | "REQUEST_COST_LIMIT_EXCEEDED";
  message?: string;
  budgetRemainingUsd?: number;
  budgetUsagePercent?: number;
  quotaRemainingRequests?: number;
  quotaRemainingTokens?: number;
}

export class CostGuardrailService {
  constructor(private readonly prisma: PrismaClient) {}

  async checkBeforeRequest(input: {
    userId: string;
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
        userId: input.userId,
        isActive: true,
        resetAt: { gt: new Date() },
      },
      orderBy: { createdAt: "desc" },
    });

    if (budget) {
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
        userId: input.userId,
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

    return {
      allowed: true,
      budgetRemainingUsd: budget
        ? Math.max(0, budget.maxSpendUsd - budget.currentSpendUsd)
        : undefined,
      budgetUsagePercent: budget ? (budget.currentSpendUsd / budget.maxSpendUsd) * 100 : undefined,
      quotaRemainingRequests: quota
        ? Math.max(0, quota.maxRequests - quota.currentRequests)
        : undefined,
      quotaRemainingTokens: quota ? Math.max(0, quota.maxTokens - quota.currentTokens) : undefined,
    };
  }

  async recordUsage(input: {
    userId: string;
    actualCostUsd: number;
    totalTokens: number;
  }): Promise<void> {
    await this.prisma.userBudget.updateMany({
      where: {
        userId: input.userId,
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
        userId: input.userId,
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

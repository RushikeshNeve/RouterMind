import type { AiGatewayRequest, GatewayRequestContext } from "@routemind/core";

export interface PolicyDecision {
  readonly allowed: boolean;
  readonly reason?: string;
  readonly constraints?: Record<string, unknown>;
}

export interface PolicyEvaluator {
  evaluate(request: AiGatewayRequest, context: GatewayRequestContext): Promise<PolicyDecision>;
}

// "workspace" applies to every request in the workspace unconditionally --
// unlike role/user/api_key, it names no further subjectId to match against
// (see subjectMatches below). Added for plan_limit, the only rule type that
// isn't admin-configured per subject; it's derived automatically from the
// org's Plan, not something a workspace admin scopes to a specific role.
export type PolicySubjectType = "role" | "user" | "api_key" | "workspace";
export type PolicyRuleType = "model_restriction" | "cost_cap" | "budget" | "plan_limit";

export interface ModelRestrictionRuleJson {
  readonly blockedModels: readonly string[];
}

export interface CostCapRuleJson {
  readonly maxCostUsd: number;
}

export interface BudgetRuleJson {
  readonly maxSpendUsd: number;
}

export interface PlanLimitRuleJson {
  readonly maxRequests: number;
  // Unlike budget's currentSpendUsd (passed via EvaluatePolicyContext,
  // caller-supplied), currentRequestCount is embedded directly in the rule
  // itself -- the same Prisma-backed lookup that already has to query the
  // org's Plan to know maxRequests can compute usage in the same pass,
  // so there's no need to thread a second field through the context.
  readonly currentRequestCount: number;
}

export interface PolicyRuleRow {
  readonly id: string;
  readonly workspaceId: string;
  readonly subjectType: PolicySubjectType;
  readonly subjectId: string;
  readonly ruleType: PolicyRuleType;
  readonly ruleJson: unknown;
  readonly priority: number;
  readonly createdAt: Date;
}

export interface EvaluatePolicyContext {
  readonly workspaceId: string;
  readonly roleId?: string;
  readonly userId?: string;
  readonly apiKeyId?: string;
  // Only relevant to model_restriction rules.
  readonly requestedModel?: string;
  // Only relevant to cost_cap/budget rules. currentSpendUsd is the
  // already-recorded spend for whatever period a budget rule tracks;
  // omitted (or 0) if the caller has no such state to report.
  readonly estimatedCostUsd?: number;
  readonly currentSpendUsd?: number;
}

export interface PolicyRuleLookup {
  findRulesForWorkspace(workspaceId: string): Promise<readonly PolicyRuleRow[]>;
}

export interface PolicyEvaluationResult {
  readonly allow: boolean;
  readonly reason: string;
  readonly matchedRule?: PolicyRuleRow;
}

function subjectMatches(rule: PolicyRuleRow, context: EvaluatePolicyContext): boolean {
  switch (rule.subjectType) {
    case "role":
      return context.roleId !== undefined && rule.subjectId === context.roleId;
    case "user":
      return context.userId !== undefined && rule.subjectId === context.userId;
    case "api_key":
      return context.apiKeyId !== undefined && rule.subjectId === context.apiKeyId;
    case "workspace":
      return true;
  }
}

// Returns undefined when the rule's condition doesn't apply to this specific
// request (e.g. a model_restriction rule for a different model) -- distinct
// from "applies and allows," since rules in this engine only ever produce an
// explicit deny; a request nothing denies falls through to the default
// allow at the end of evaluatePolicy().
function evaluateRule(
  rule: PolicyRuleRow,
  context: EvaluatePolicyContext,
): PolicyEvaluationResult | undefined {
  switch (rule.ruleType) {
    case "model_restriction": {
      const ruleData = rule.ruleJson as Partial<ModelRestrictionRuleJson>;
      if (
        !context.requestedModel ||
        !ruleData.blockedModels ||
        !ruleData.blockedModels.includes(context.requestedModel)
      ) {
        return undefined;
      }
      return {
        allow: false,
        reason: `Model "${context.requestedModel}" is blocked by policy for this subject.`,
        matchedRule: rule,
      };
    }
    case "cost_cap": {
      const ruleData = rule.ruleJson as Partial<CostCapRuleJson>;
      if (ruleData.maxCostUsd === undefined || context.estimatedCostUsd === undefined) {
        return undefined;
      }
      if (context.estimatedCostUsd <= ruleData.maxCostUsd) {
        return undefined;
      }
      return {
        allow: false,
        reason: `Estimated request cost $${context.estimatedCostUsd.toFixed(4)} exceeds the $${ruleData.maxCostUsd.toFixed(4)} per-request cap set by policy.`,
        matchedRule: rule,
      };
    }
    case "budget": {
      const ruleData = rule.ruleJson as Partial<BudgetRuleJson>;
      if (ruleData.maxSpendUsd === undefined) {
        return undefined;
      }
      const projectedSpend = (context.currentSpendUsd ?? 0) + (context.estimatedCostUsd ?? 0);
      if (projectedSpend <= ruleData.maxSpendUsd) {
        return undefined;
      }
      return {
        allow: false,
        reason: `Projected spend $${projectedSpend.toFixed(4)} exceeds the $${ruleData.maxSpendUsd.toFixed(4)} budget set by policy.`,
        matchedRule: rule,
      };
    }
    case "plan_limit": {
      const ruleData = rule.ruleJson as Partial<PlanLimitRuleJson>;
      if (ruleData.maxRequests === undefined || ruleData.currentRequestCount === undefined) {
        return undefined;
      }
      if (ruleData.currentRequestCount < ruleData.maxRequests) {
        return undefined;
      }
      return {
        allow: false,
        reason: `This organization has used ${ruleData.currentRequestCount} of its plan's ${ruleData.maxRequests} included requests for this billing period.`,
        matchedRule: rule,
      };
    }
  }
}

/**
 * Evaluates every Policy row applicable to `context` (matched by subject,
 * scoped to the workspace) and returns the first explicit deny, in priority
 * order (highest priority first; ties broken by earliest-created). Rules
 * that don't apply to this specific request (wrong model, cost within cap,
 * etc.) are skipped rather than treated as a match -- a request nothing
 * denies is allowed by default.
 *
 * Takes a PolicyRuleLookup rather than a database client directly, so this
 * stays a pure, framework-free function callable from tests with an
 * in-memory fake -- matching packages/routing's resolveRouterConfig().
 */
export async function evaluatePolicy(
  context: EvaluatePolicyContext,
  lookup: PolicyRuleLookup,
): Promise<PolicyEvaluationResult> {
  const rules = await lookup.findRulesForWorkspace(context.workspaceId);
  const applicableRules = rules.filter((rule) => subjectMatches(rule, context));
  const sortedRules = [...applicableRules].sort((a, b) => {
    if (b.priority !== a.priority) {
      return b.priority - a.priority;
    }
    return a.createdAt.getTime() - b.createdAt.getTime();
  });

  for (const rule of sortedRules) {
    const result = evaluateRule(rule, context);
    if (result) {
      return result;
    }
  }

  return { allow: true, reason: "No matching policy rule; allowed by default." };
}

import { describe, expect, it } from "vitest";

import {
  evaluatePolicy,
  type EvaluatePolicyContext,
  type PolicyRuleLookup,
  type PolicyRuleRow,
} from "./index.js";

function fakeLookup(rules: readonly PolicyRuleRow[]): PolicyRuleLookup {
  return {
    findRulesForWorkspace: (workspaceId) =>
      Promise.resolve(rules.filter((rule) => rule.workspaceId === workspaceId)),
  };
}

function makeRule(
  overrides: Partial<PolicyRuleRow> & Pick<PolicyRuleRow, "ruleType" | "ruleJson">,
): PolicyRuleRow {
  return {
    id: "rule-1",
    workspaceId: "ws-1",
    subjectType: "role",
    subjectId: "developer",
    priority: 0,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

const baseContext: EvaluatePolicyContext = {
  workspaceId: "ws-1",
  roleId: "developer",
};

describe("evaluatePolicy", () => {
  it("blocks a request matching a model_restriction rule", async () => {
    const rule = makeRule({
      id: "block-gpt5",
      ruleType: "model_restriction",
      ruleJson: { blockedModels: ["gpt-5"] },
    });
    const lookup = fakeLookup([rule]);

    const result = await evaluatePolicy({ ...baseContext, requestedModel: "gpt-5" }, lookup);

    expect(result.allow).toBe(false);
    expect(result.matchedRule?.id).toBe("block-gpt5");
    expect(result.reason).toContain("gpt-5");
  });

  it("allows a model_restriction rule to pass through for a different model", async () => {
    const rule = makeRule({
      ruleType: "model_restriction",
      ruleJson: { blockedModels: ["gpt-5"] },
    });
    const lookup = fakeLookup([rule]);

    const result = await evaluatePolicy({ ...baseContext, requestedModel: "gpt-4o" }, lookup);

    expect(result.allow).toBe(true);
    expect(result.matchedRule).toBeUndefined();
  });

  it("blocks a request exceeding a cost_cap rule", async () => {
    const rule = makeRule({
      id: "cap-5-cents",
      ruleType: "cost_cap",
      ruleJson: { maxCostUsd: 0.05 },
    });
    const lookup = fakeLookup([rule]);

    const result = await evaluatePolicy({ ...baseContext, estimatedCostUsd: 0.12 }, lookup);

    expect(result.allow).toBe(false);
    expect(result.matchedRule?.id).toBe("cap-5-cents");
    expect(result.reason).toContain("0.05");
  });

  it("allows a request within a cost_cap rule's threshold", async () => {
    const rule = makeRule({
      ruleType: "cost_cap",
      ruleJson: { maxCostUsd: 0.05 },
    });
    const lookup = fakeLookup([rule]);

    const result = await evaluatePolicy({ ...baseContext, estimatedCostUsd: 0.02 }, lookup);

    expect(result.allow).toBe(true);
  });

  it("blocks a request that would exceed a budget rule's projected spend, reproducing CostGuardrailService's exact threshold math", async () => {
    // Mirrors apps/api/src/infrastructure/cost-guardrail-service.ts's
    // existing hardcoded check: `projectedSpend > budget.maxSpendUsd`,
    // where projectedSpend = currentSpendUsd + estimatedCostUsd.
    const rule = makeRule({
      id: "monthly-budget",
      ruleType: "budget",
      ruleJson: { maxSpendUsd: 100 },
    });
    const lookup = fakeLookup([rule]);

    const result = await evaluatePolicy(
      { ...baseContext, currentSpendUsd: 95, estimatedCostUsd: 10 },
      lookup,
    );

    expect(result.allow).toBe(false);
    expect(result.matchedRule?.id).toBe("monthly-budget");
    expect(result.reason).toContain("105");
  });

  it("allows a request whose projected spend stays within the budget rule", async () => {
    const rule = makeRule({
      ruleType: "budget",
      ruleJson: { maxSpendUsd: 100 },
    });
    const lookup = fakeLookup([rule]);

    const result = await evaluatePolicy(
      { ...baseContext, currentSpendUsd: 50, estimatedCostUsd: 10 },
      lookup,
    );

    expect(result.allow).toBe(true);
  });

  it("allows by default when no rule matches the subject or workspace", async () => {
    const rule = makeRule({
      workspaceId: "some-other-workspace",
      ruleType: "model_restriction",
      ruleJson: { blockedModels: ["gpt-5"] },
    });
    const lookup = fakeLookup([rule]);

    const result = await evaluatePolicy({ ...baseContext, requestedModel: "gpt-5" }, lookup);

    expect(result.allow).toBe(true);
    expect(result.matchedRule).toBeUndefined();
    expect(result.reason).toMatch(/no matching policy rule/i);
  });

  it("evaluates rules in priority order, returning the higher-priority rule's decision when multiple could match", async () => {
    const lowPriorityRule = makeRule({
      id: "low-priority-cap",
      priority: 1,
      ruleType: "cost_cap",
      ruleJson: { maxCostUsd: 1.0 },
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });
    const highPriorityRule = makeRule({
      id: "high-priority-cap",
      priority: 10,
      ruleType: "cost_cap",
      ruleJson: { maxCostUsd: 0.01 },
      createdAt: new Date("2026-01-02T00:00:00Z"),
    });
    // Both rules would deny a $0.5 request (0.5 > 0.01 and 0.5 > 1.0 is
    // false -- pick an estimate that both thresholds would reject to prove
    // it's genuinely the higher-priority rule's decision being returned,
    // not just "whichever rule happened to be evaluated first in array order".
    const lookup = fakeLookup([lowPriorityRule, highPriorityRule]);

    const result = await evaluatePolicy({ ...baseContext, estimatedCostUsd: 5.0 }, lookup);

    expect(result.allow).toBe(false);
    expect(result.matchedRule?.id).toBe("high-priority-cap");
  });

  it("blocks a request once currentRequestCount reaches a plan_limit rule's maxRequests", async () => {
    const rule = makeRule({
      id: "org-plan-limit",
      subjectType: "workspace",
      subjectId: "",
      ruleType: "plan_limit",
      ruleJson: { maxRequests: 10_000, currentRequestCount: 10_000 },
    });
    const lookup = fakeLookup([rule]);

    const result = await evaluatePolicy(baseContext, lookup);

    expect(result.allow).toBe(false);
    expect(result.matchedRule?.id).toBe("org-plan-limit");
    expect(result.reason).toContain("10000");
  });

  it("allows a request when currentRequestCount is still below a plan_limit rule's maxRequests", async () => {
    const rule = makeRule({
      subjectType: "workspace",
      subjectId: "",
      ruleType: "plan_limit",
      ruleJson: { maxRequests: 10_000, currentRequestCount: 9_999 },
    });
    const lookup = fakeLookup([rule]);

    const result = await evaluatePolicy(baseContext, lookup);

    expect(result.allow).toBe(true);
  });

  it("applies a workspace-subject rule regardless of the caller's role/user/api key", async () => {
    const rule = makeRule({
      subjectType: "workspace",
      subjectId: "",
      ruleType: "plan_limit",
      ruleJson: { maxRequests: 5, currentRequestCount: 5 },
    });
    const lookup = fakeLookup([rule]);

    // No roleId/userId/apiKeyId at all -- a workspace-subject rule still
    // applies, unlike role/user/api_key rules which require a matching id.
    const result = await evaluatePolicy({ workspaceId: "ws-1" }, lookup);

    expect(result.allow).toBe(false);
    expect(result.matchedRule?.ruleType).toBe("plan_limit");
  });

  it("falls through to a lower-priority rule when the higher-priority rule doesn't apply to this request", async () => {
    const highPriorityRestriction = makeRule({
      id: "high-priority-restriction",
      priority: 10,
      ruleType: "model_restriction",
      ruleJson: { blockedModels: ["gpt-5"] },
    });
    const lowPriorityCap = makeRule({
      id: "low-priority-cap",
      priority: 1,
      ruleType: "cost_cap",
      ruleJson: { maxCostUsd: 0.01 },
    });
    const lookup = fakeLookup([highPriorityRestriction, lowPriorityCap]);

    // Requests gpt-4o (the high-priority model_restriction rule doesn't
    // apply), but exceeds the low-priority cost_cap rule.
    const result = await evaluatePolicy(
      { ...baseContext, requestedModel: "gpt-4o", estimatedCostUsd: 5.0 },
      lookup,
    );

    expect(result.allow).toBe(false);
    expect(result.matchedRule?.id).toBe("low-priority-cap");
  });
});

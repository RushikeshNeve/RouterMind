import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import {
  cleanupFixture,
  createPrismaWorkspaceTestApp,
  seedWorkspaceWithRole,
  testConfig,
  type WorkspaceRoleFixture,
} from "./workspaces-rbac-fixtures.js";

function parse<T>(response: { payload: string }): T {
  return JSON.parse(response.payload) as T;
}

describe("CostGuardrailService's live wiring to evaluatePolicy()", () => {
  const prisma = new PrismaClient({ datasourceUrl: testConfig.DATABASE_URL });
  const apps: Array<{ readonly app: FastifyInstance }> = [];
  const fixtures: WorkspaceRoleFixture[] = [];
  const policyIds: string[] = [];
  const subscriptionOrgIds: string[] = [];
  const planIds: string[] = [];
  const requestLogIds: string[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map(({ app }) => app.close()));
    await prisma.requestLog.deleteMany({ where: { id: { in: requestLogIds.splice(0) } } });
    await prisma.policy.deleteMany({ where: { id: { in: policyIds.splice(0) } } });
    await prisma.subscription.deleteMany({
      where: { organizationId: { in: subscriptionOrgIds.splice(0) } },
    });
    await prisma.plan.deleteMany({ where: { id: { in: planIds.splice(0) } } });
    const workspaceIds = fixtures.map((fixture) => fixture.workspaceId);
    await prisma.userBudget.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await Promise.all(fixtures.splice(0).map((fixture) => cleanupFixture(prisma, fixture)));
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function setupWorkspace(role: "Owner" | "Admin" | "Developer" | "Viewer") {
    const { app } = await createPrismaWorkspaceTestApp(prisma);
    apps.push({ app });
    const fixture = await seedWorkspaceWithRole(prisma, role);
    fixtures.push(fixture);
    return { app, fixture };
  }

  async function sendChatCompletion(app: FastifyInstance, apiKey: string) {
    return app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { "x-api-key": apiKey },
      payload: {
        model: "gpt-4o",
        messages: [{ role: "user", content: "Hello" }],
        cache: { mode: "disabled" },
      },
    });
  }

  async function createPlan(includedRequests: number | null): Promise<string> {
    const plan = await prisma.plan.create({
      data: {
        name: `Plan Limit Test Plan ${randomUUID()}`,
        priceCents: 5_900,
        includedRequests,
        featuresJson: {},
      },
    });
    planIds.push(plan.id);
    return plan.id;
  }

  async function subscribeOrgToPlan(organizationId: string, planId: string): Promise<void> {
    await prisma.subscription.create({ data: { organizationId, planId, status: "active" } });
    subscriptionOrgIds.push(organizationId);
  }

  async function seedSuccessfulRequestLogs(workspaceId: string, count: number): Promise<void> {
    for (let i = 0; i < count; i += 1) {
      const row = await prisma.requestLog.create({
        data: {
          workspaceId,
          apiKey: "test-key-hash",
          requestedModel: "gpt-4o",
          latencyMs: 100,
          status: "success",
        },
      });
      requestLogIds.push(row.id);
    }
  }

  it("proves the live request path is decided by evaluatePolicy(), not the legacy UserBudget.maxSpendUsd threshold", async () => {
    const { app, fixture } = await setupWorkspace("Owner");
    const role = await prisma.role.findUniqueOrThrow({ where: { name: "Owner" } });

    // The OLD hardcoded check compared against UserBudget.maxSpendUsd, which
    // is deliberately enormous here -- if the live path were still reading
    // it directly, this request would sail through. A near-zero Policy
    // "budget" rule is the ONLY thing that can block it now.
    await prisma.userBudget.create({
      data: {
        userId: fixture.userId,
        workspaceId: fixture.workspaceId,
        period: "monthly",
        maxSpendUsd: 999_999,
        currentSpendUsd: 0,
        resetAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      },
    });
    const policy = await prisma.policy.create({
      data: {
        workspaceId: fixture.workspaceId,
        subjectType: "role",
        subjectId: role.id,
        ruleType: "budget",
        ruleJson: { maxSpendUsd: 0 },
        priority: 0,
      },
    });
    policyIds.push(policy.id);

    const response = await sendChatCompletion(app, fixture.apiKey);

    expect(response.statusCode).toBe(403);
    const body = parse<{ error: { code: string } }>(response);
    expect(body.error.code).toBe("BUDGET_EXCEEDED");

    // Confirms the block came from evaluatePolicy's decision, not the
    // legacy threshold: currentSpendUsd is untouched (recordUsage never ran,
    // since the guardrail rejected the request before any provider call).
    const budget = await prisma.userBudget.findFirstOrThrow({
      where: { workspaceId: fixture.workspaceId },
    });
    expect(budget.currentSpendUsd).toBe(0);
  });

  it("reproduces the pre-swap behavior: a workspace whose projected spend exceeds its budget rule is blocked, one comfortably under it is allowed", async () => {
    const role = await prisma.role.findUniqueOrThrow({ where: { name: "Owner" } });

    const { app: blockedApp, fixture: blockedFixture } = await setupWorkspace("Owner");
    await prisma.userBudget.create({
      data: {
        userId: blockedFixture.userId,
        workspaceId: blockedFixture.workspaceId,
        period: "monthly",
        maxSpendUsd: 100,
        currentSpendUsd: 100,
        resetAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      },
    });
    const blockedPolicy = await prisma.policy.create({
      data: {
        workspaceId: blockedFixture.workspaceId,
        subjectType: "role",
        subjectId: role.id,
        ruleType: "budget",
        ruleJson: { maxSpendUsd: 100 },
        priority: 0,
      },
    });
    policyIds.push(blockedPolicy.id);

    const { app: allowedApp, fixture: allowedFixture } = await setupWorkspace("Owner");
    await prisma.userBudget.create({
      data: {
        userId: allowedFixture.userId,
        workspaceId: allowedFixture.workspaceId,
        period: "monthly",
        maxSpendUsd: 100,
        currentSpendUsd: 0,
        resetAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      },
    });
    const allowedPolicy = await prisma.policy.create({
      data: {
        workspaceId: allowedFixture.workspaceId,
        subjectType: "role",
        subjectId: role.id,
        ruleType: "budget",
        ruleJson: { maxSpendUsd: 100 },
        priority: 0,
      },
    });
    policyIds.push(allowedPolicy.id);

    const blockedResponse = await sendChatCompletion(blockedApp, blockedFixture.apiKey);
    const allowedResponse = await sendChatCompletion(allowedApp, allowedFixture.apiKey);

    expect(blockedResponse.statusCode).toBe(403);
    expect(parse<{ error: { code: string } }>(blockedResponse).error.code).toBe("BUDGET_EXCEEDED");

    expect(allowedResponse.statusCode).toBe(200);
    const allowedBudget = await prisma.userBudget.findFirstOrThrow({
      where: { workspaceId: allowedFixture.workspaceId },
    });
    expect(allowedBudget.currentSpendUsd).toBeGreaterThan(0);
  });

  it("blocks a request for a model_restriction-blocked model, with no UserBudget row at all", async () => {
    const { app, fixture } = await setupWorkspace("Owner");
    const role = await prisma.role.findUniqueOrThrow({ where: { name: "Owner" } });

    // Deliberately no UserBudget row for this workspace -- proves
    // evaluatePolicy() now runs regardless of whether a budget row exists.
    const policy = await prisma.policy.create({
      data: {
        workspaceId: fixture.workspaceId,
        subjectType: "role",
        subjectId: role.id,
        ruleType: "model_restriction",
        ruleJson: { blockedModels: ["gpt-4o"] },
        priority: 0,
      },
    });
    policyIds.push(policy.id);

    const response = await sendChatCompletion(app, fixture.apiKey);

    expect(response.statusCode).toBe(403);
    const body = parse<{ error: { code: string } }>(response);
    expect(body.error.code).toBe("MODEL_RESTRICTED");
  });

  it("allows a request for a model not named by a model_restriction rule", async () => {
    const { app, fixture } = await setupWorkspace("Owner");
    const role = await prisma.role.findUniqueOrThrow({ where: { name: "Owner" } });

    const policy = await prisma.policy.create({
      data: {
        workspaceId: fixture.workspaceId,
        subjectType: "role",
        subjectId: role.id,
        ruleType: "model_restriction",
        ruleJson: { blockedModels: ["claude-3-opus"] },
        priority: 0,
      },
    });
    policyIds.push(policy.id);

    const response = await sendChatCompletion(app, fixture.apiKey);

    expect(response.statusCode).toBe(200);
  });

  it("blocks a request whose estimated cost exceeds a cost_cap rule, with no UserBudget row at all", async () => {
    const { app, fixture } = await setupWorkspace("Owner");
    const role = await prisma.role.findUniqueOrThrow({ where: { name: "Owner" } });

    const policy = await prisma.policy.create({
      data: {
        workspaceId: fixture.workspaceId,
        subjectType: "role",
        subjectId: role.id,
        ruleType: "cost_cap",
        ruleJson: { maxCostUsd: 0.0000001 },
        priority: 0,
      },
    });
    policyIds.push(policy.id);

    const response = await sendChatCompletion(app, fixture.apiKey);

    expect(response.statusCode).toBe(403);
    const body = parse<{ error: { code: string } }>(response);
    expect(body.error.code).toBe("COST_CAP_EXCEEDED");
  });

  it("allows a request whose estimated cost is within a cost_cap rule", async () => {
    const { app, fixture } = await setupWorkspace("Owner");
    const role = await prisma.role.findUniqueOrThrow({ where: { name: "Owner" } });

    const policy = await prisma.policy.create({
      data: {
        workspaceId: fixture.workspaceId,
        subjectType: "role",
        subjectId: role.id,
        ruleType: "cost_cap",
        ruleJson: { maxCostUsd: 1000 },
        priority: 0,
      },
    });
    policyIds.push(policy.id);

    const response = await sendChatCompletion(app, fixture.apiKey);

    expect(response.statusCode).toBe(200);
  });

  it("blocks a request once the org has used all of its plan's included requests", async () => {
    const { app, fixture } = await setupWorkspace("Owner");
    const planId = await createPlan(1);
    await subscribeOrgToPlan(fixture.organizationId, planId);
    await seedSuccessfulRequestLogs(fixture.workspaceId, 1);

    const response = await sendChatCompletion(app, fixture.apiKey);

    expect(response.statusCode).toBe(403);
    const body = parse<{ error: { code: string } }>(response);
    expect(body.error.code).toBe("PLAN_LIMIT_EXCEEDED");
  });

  it("allows a request when the org is still under its plan's included requests", async () => {
    const { app, fixture } = await setupWorkspace("Owner");
    const planId = await createPlan(10);
    await subscribeOrgToPlan(fixture.organizationId, planId);
    await seedSuccessfulRequestLogs(fixture.workspaceId, 3);

    const response = await sendChatCompletion(app, fixture.apiKey);

    expect(response.statusCode).toBe(200);
  });

  it("never blocks when the plan's includedRequests is null (unlimited)", async () => {
    const { app, fixture } = await setupWorkspace("Owner");
    const planId = await createPlan(null);
    await subscribeOrgToPlan(fixture.organizationId, planId);
    await seedSuccessfulRequestLogs(fixture.workspaceId, 500);

    const response = await sendChatCompletion(app, fixture.apiKey);

    expect(response.statusCode).toBe(200);
  });

  it("falls back to the seeded Free plan's limit when the org has no Subscription row", async () => {
    await prisma.plan.upsert({
      where: { name: "Free" },
      create: {
        name: "Free",
        priceCents: 0,
        includedRequests: 2,
        featuresJson: {},
      },
      update: { includedRequests: 2 },
    });
    const { app, fixture } = await setupWorkspace("Owner");
    // Deliberately no Subscription row for this org at all.
    await seedSuccessfulRequestLogs(fixture.workspaceId, 2);

    const response = await sendChatCompletion(app, fixture.apiKey);

    expect(response.statusCode).toBe(403);
    const body = parse<{ error: { code: string } }>(response);
    expect(body.error.code).toBe("PLAN_LIMIT_EXCEEDED");

    // Restore Free's real seeded limit so this test doesn't leak state into
    // whatever npm run seed:plans last set it to for other manual use.
    await prisma.plan.update({ where: { name: "Free" }, data: { includedRequests: 10_000 } });
  });
});

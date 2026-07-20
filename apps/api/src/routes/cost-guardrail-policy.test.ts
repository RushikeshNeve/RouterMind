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

  afterEach(async () => {
    await Promise.all(apps.splice(0).map(({ app }) => app.close()));
    await prisma.policy.deleteMany({ where: { id: { in: policyIds.splice(0) } } });
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
});

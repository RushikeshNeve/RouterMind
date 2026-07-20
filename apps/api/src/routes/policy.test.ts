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

describe("policy routes", () => {
  const apps: Array<{ readonly app: FastifyInstance }> = [];
  const fixturePrisma = new PrismaClient({ datasourceUrl: testConfig.DATABASE_URL });
  const fixtures: WorkspaceRoleFixture[] = [];
  const policyIds: string[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map(({ app }) => app.close()));
    await fixturePrisma.policy.deleteMany({ where: { id: { in: policyIds.splice(0) } } });
    await Promise.all(fixtures.splice(0).map((fixture) => cleanupFixture(fixturePrisma, fixture)));
  });

  afterAll(async () => {
    await fixturePrisma.$disconnect();
  });

  async function setupForRole(role: "Owner" | "Admin" | "Developer" | "Viewer") {
    const { app } = await createPrismaWorkspaceTestApp(fixturePrisma);
    apps.push({ app });
    const fixture = await seedWorkspaceWithRole(fixturePrisma, role);
    fixtures.push(fixture);
    return { app, fixture };
  }

  async function ownerRoleId() {
    const role = await fixturePrisma.role.findUniqueOrThrow({ where: { name: "Owner" } });
    return role.id;
  }

  describe("GET /v1/workspaces/:workspaceId/roles", () => {
    it("lists the seeded roles for use in the subject picker", async () => {
      const { app, fixture } = await setupForRole("Owner");

      const response = await app.inject({
        method: "GET",
        url: `/v1/workspaces/${fixture.workspaceId}/roles`,
        headers: { "x-api-key": fixture.apiKey },
      });

      expect(response.statusCode).toBe(200);
      const body = parse<{ roles: readonly { id: string; name: string }[] }>(response);
      expect(body.roles.map((r) => r.name).sort()).toEqual([
        "Admin",
        "Developer",
        "Owner",
        "Viewer",
      ]);
    });
  });

  describe("POST /v1/workspaces/:workspaceId/policies", () => {
    it.each(["Owner", "Admin"] as const)(
      "creates a budget policy when caller has role=%s",
      async (role) => {
        const { app, fixture } = await setupForRole(role);
        const roleId = await ownerRoleId();

        const response = await app.inject({
          method: "POST",
          url: `/v1/workspaces/${fixture.workspaceId}/policies`,
          headers: { "x-api-key": fixture.apiKey },
          payload: {
            subjectType: "role",
            subjectId: roleId,
            ruleType: "budget",
            ruleJson: { maxSpendUsd: 100 },
            priority: 5,
          },
        });

        expect(response.statusCode).toBe(201);
        const body = parse<{ id: string; priority: number }>(response);
        policyIds.push(body.id);
        expect(body.priority).toBe(5);
      },
    );

    it.each(["Developer", "Viewer"] as const)(
      "rejects creation when caller has role=%s",
      async (role) => {
        const { app, fixture } = await setupForRole(role);
        const roleId = await ownerRoleId();

        const response = await app.inject({
          method: "POST",
          url: `/v1/workspaces/${fixture.workspaceId}/policies`,
          headers: { "x-api-key": fixture.apiKey },
          payload: {
            subjectType: "role",
            subjectId: roleId,
            ruleType: "budget",
            ruleJson: { maxSpendUsd: 100 },
          },
        });

        expect(response.statusCode).toBe(403);
      },
    );

    it("rejects a cross-workspace create attempt", async () => {
      const { fixture: otherFixture } = await setupForRole("Owner");
      const { app, fixture } = await setupForRole("Owner");
      const roleId = await ownerRoleId();

      const response = await app.inject({
        method: "POST",
        url: `/v1/workspaces/${otherFixture.workspaceId}/policies`,
        headers: { "x-api-key": fixture.apiKey },
        payload: {
          subjectType: "role",
          subjectId: roleId,
          ruleType: "budget",
          ruleJson: { maxSpendUsd: 100 },
        },
      });

      expect(response.statusCode).toBe(403);
    });

    it("rejects ruleJson that doesn't match model_restriction's shape", async () => {
      const { app, fixture } = await setupForRole("Owner");
      const roleId = await ownerRoleId();

      const response = await app.inject({
        method: "POST",
        url: `/v1/workspaces/${fixture.workspaceId}/policies`,
        headers: { "x-api-key": fixture.apiKey },
        payload: {
          subjectType: "role",
          subjectId: roleId,
          ruleType: "model_restriction",
          ruleJson: { maxSpendUsd: 100 },
        },
      });

      expect(response.statusCode).toBe(400);
      expect(parse<{ error: { message: string } }>(response).error.message).toContain("ruleJson");
    });

    it("rejects ruleJson with the wrong field type for cost_cap", async () => {
      const { app, fixture } = await setupForRole("Owner");
      const roleId = await ownerRoleId();

      const response = await app.inject({
        method: "POST",
        url: `/v1/workspaces/${fixture.workspaceId}/policies`,
        headers: { "x-api-key": fixture.apiKey },
        payload: {
          subjectType: "role",
          subjectId: roleId,
          ruleType: "cost_cap",
          ruleJson: { maxCostUsd: "not-a-number" },
        },
      });

      expect(response.statusCode).toBe(400);
    });

    it("rejects a subjectId that does not reference an existing role", async () => {
      const { app, fixture } = await setupForRole("Owner");

      const response = await app.inject({
        method: "POST",
        url: `/v1/workspaces/${fixture.workspaceId}/policies`,
        headers: { "x-api-key": fixture.apiKey },
        payload: {
          subjectType: "role",
          subjectId: "nonexistent-role-id",
          ruleType: "budget",
          ruleJson: { maxSpendUsd: 100 },
        },
      });

      expect(response.statusCode).toBe(400);
      expect(parse<{ error: { message: string } }>(response).error.message).toContain(
        "existing role",
      );
    });

    it("rejects a user subjectId who is not a member of this workspace", async () => {
      const { fixture: otherFixture } = await setupForRole("Owner");
      const { app, fixture } = await setupForRole("Owner");

      const response = await app.inject({
        method: "POST",
        url: `/v1/workspaces/${fixture.workspaceId}/policies`,
        headers: { "x-api-key": fixture.apiKey },
        payload: {
          subjectType: "user",
          subjectId: otherFixture.userId,
          ruleType: "budget",
          ruleJson: { maxSpendUsd: 100 },
        },
      });

      expect(response.statusCode).toBe(400);
      expect(parse<{ error: { message: string } }>(response).error.message).toContain("member");
    });

    it("accepts a user subjectId who is a member of this workspace", async () => {
      const { app, fixture } = await setupForRole("Owner");

      const response = await app.inject({
        method: "POST",
        url: `/v1/workspaces/${fixture.workspaceId}/policies`,
        headers: { "x-api-key": fixture.apiKey },
        payload: {
          subjectType: "user",
          subjectId: fixture.userId,
          ruleType: "model_restriction",
          ruleJson: { blockedModels: ["gpt-4o"] },
        },
      });

      expect(response.statusCode).toBe(201);
      const body = parse<{ id: string }>(response);
      policyIds.push(body.id);
    });

    it("rejects an api_key subjectId that does not belong to this workspace", async () => {
      const { fixture: otherFixture } = await setupForRole("Owner");
      const { app, fixture } = await setupForRole("Owner");

      const response = await app.inject({
        method: "POST",
        url: `/v1/workspaces/${fixture.workspaceId}/policies`,
        headers: { "x-api-key": fixture.apiKey },
        payload: {
          subjectType: "api_key",
          subjectId: otherFixture.apiKeyId,
          ruleType: "budget",
          ruleJson: { maxSpendUsd: 50 },
        },
      });

      expect(response.statusCode).toBe(400);
      expect(parse<{ error: { message: string } }>(response).error.message).toContain("API key");
    });

    it("accepts an api_key subjectId that belongs to this workspace", async () => {
      const { app, fixture } = await setupForRole("Owner");

      const response = await app.inject({
        method: "POST",
        url: `/v1/workspaces/${fixture.workspaceId}/policies`,
        headers: { "x-api-key": fixture.apiKey },
        payload: {
          subjectType: "api_key",
          subjectId: fixture.apiKeyId,
          ruleType: "cost_cap",
          ruleJson: { maxCostUsd: 1.5 },
        },
      });

      expect(response.statusCode).toBe(201);
      const body = parse<{ id: string }>(response);
      policyIds.push(body.id);
    });
  });

  describe("GET /v1/workspaces/:workspaceId/policies", () => {
    it("lists policies ordered by priority desc, then createdAt asc", async () => {
      const { app, fixture } = await setupForRole("Owner");
      const roleId = await ownerRoleId();

      for (const priority of [0, 10, 5]) {
        const created = await fixturePrisma.policy.create({
          data: {
            workspaceId: fixture.workspaceId,
            subjectType: "role",
            subjectId: roleId,
            ruleType: "budget",
            ruleJson: { maxSpendUsd: 100 },
            priority,
          },
        });
        policyIds.push(created.id);
      }

      const response = await app.inject({
        method: "GET",
        url: `/v1/workspaces/${fixture.workspaceId}/policies`,
        headers: { "x-api-key": fixture.apiKey },
      });

      expect(response.statusCode).toBe(200);
      const body = parse<{ policies: readonly { priority: number }[] }>(response);
      expect(body.policies.map((p) => p.priority)).toEqual([10, 5, 0]);
    });

    it("does not list another workspace's policies", async () => {
      const { fixture: otherFixture } = await setupForRole("Owner");
      const roleId = await ownerRoleId();
      const created = await fixturePrisma.policy.create({
        data: {
          workspaceId: otherFixture.workspaceId,
          subjectType: "role",
          subjectId: roleId,
          ruleType: "budget",
          ruleJson: { maxSpendUsd: 100 },
        },
      });
      policyIds.push(created.id);

      const { app, fixture } = await setupForRole("Owner");
      const response = await app.inject({
        method: "GET",
        url: `/v1/workspaces/${fixture.workspaceId}/policies`,
        headers: { "x-api-key": fixture.apiKey },
      });

      expect(response.statusCode).toBe(200);
      expect(parse<{ policies: readonly unknown[] }>(response).policies).toHaveLength(0);
    });
  });

  describe("PATCH /v1/workspaces/:workspaceId/policies/:policyId", () => {
    it("updates ruleJson and priority", async () => {
      const { app, fixture } = await setupForRole("Owner");
      const roleId = await ownerRoleId();
      const created = await fixturePrisma.policy.create({
        data: {
          workspaceId: fixture.workspaceId,
          subjectType: "role",
          subjectId: roleId,
          ruleType: "budget",
          ruleJson: { maxSpendUsd: 100 },
          priority: 0,
        },
      });
      policyIds.push(created.id);

      const response = await app.inject({
        method: "PATCH",
        url: `/v1/workspaces/${fixture.workspaceId}/policies/${created.id}`,
        headers: { "x-api-key": fixture.apiKey },
        payload: { ruleJson: { maxSpendUsd: 250 }, priority: 9 },
      });

      expect(response.statusCode).toBe(200);
      const body = parse<{ ruleJson: { maxSpendUsd: number }; priority: number }>(response);
      expect(body.ruleJson.maxSpendUsd).toBe(250);
      expect(body.priority).toBe(9);
    });

    it("rejects a ruleJson update that doesn't match the row's existing ruleType", async () => {
      const { app, fixture } = await setupForRole("Owner");
      const roleId = await ownerRoleId();
      const created = await fixturePrisma.policy.create({
        data: {
          workspaceId: fixture.workspaceId,
          subjectType: "role",
          subjectId: roleId,
          ruleType: "budget",
          ruleJson: { maxSpendUsd: 100 },
        },
      });
      policyIds.push(created.id);

      const response = await app.inject({
        method: "PATCH",
        url: `/v1/workspaces/${fixture.workspaceId}/policies/${created.id}`,
        headers: { "x-api-key": fixture.apiKey },
        payload: { ruleJson: { blockedModels: ["gpt-4o"] } },
      });

      expect(response.statusCode).toBe(400);
    });

    it("404s for a policy id that doesn't belong to this workspace", async () => {
      const { fixture: otherFixture } = await setupForRole("Owner");
      const roleId = await ownerRoleId();
      const created = await fixturePrisma.policy.create({
        data: {
          workspaceId: otherFixture.workspaceId,
          subjectType: "role",
          subjectId: roleId,
          ruleType: "budget",
          ruleJson: { maxSpendUsd: 100 },
        },
      });
      policyIds.push(created.id);

      const { app, fixture } = await setupForRole("Owner");
      const response = await app.inject({
        method: "PATCH",
        url: `/v1/workspaces/${fixture.workspaceId}/policies/${created.id}`,
        headers: { "x-api-key": fixture.apiKey },
        payload: { priority: 3 },
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe("DELETE /v1/workspaces/:workspaceId/policies/:policyId", () => {
    it("deletes a policy and writes an audit event in the same transaction", async () => {
      const { app, fixture } = await setupForRole("Owner");
      const roleId = await ownerRoleId();
      const created = await fixturePrisma.policy.create({
        data: {
          workspaceId: fixture.workspaceId,
          subjectType: "role",
          subjectId: roleId,
          ruleType: "budget",
          ruleJson: { maxSpendUsd: 100 },
        },
      });

      const response = await app.inject({
        method: "DELETE",
        url: `/v1/workspaces/${fixture.workspaceId}/policies/${created.id}`,
        headers: { "x-api-key": fixture.apiKey },
      });

      expect(response.statusCode).toBe(200);
      const stillExists = await fixturePrisma.policy.findUnique({ where: { id: created.id } });
      expect(stillExists).toBeNull();

      const auditEvents = await fixturePrisma.auditEvent.findMany({
        where: { workspaceId: fixture.workspaceId, action: "policy.delete", targetId: created.id },
      });
      expect(auditEvents).toHaveLength(1);
    });
  });
});

import { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import {
  cleanupFixture,
  createPrismaWorkspaceTestApp,
  createWorkspaceTestApp,
  seedWorkspaceWithRole,
  testConfig,
  type WorkspaceRoleFixture,
} from "./workspaces-rbac-fixtures.js";

function parse<T>(response: { payload: string }): T {
  return JSON.parse(response.payload) as T;
}

describe("service account routes", () => {
  const apps: Array<{ readonly app: FastifyInstance }> = [];
  const fixturePrisma = new PrismaClient({ datasourceUrl: testConfig.DATABASE_URL });
  const fixtures: WorkspaceRoleFixture[] = [];
  const extraPrincipalIds: string[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map(({ app }) => app.close()));

    // Extra ApiKeys/Memberships created by these tests (service-account keys,
    // service-account memberships) reference the fixture's workspaceId, so
    // they must go before cleanupFixture deletes the Workspace row
    // (ApiKey.workspaceId is onDelete: Restrict).
    const workspaceIds = fixtures.map((fixture) => fixture.workspaceId);
    await fixturePrisma.apiKey.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await fixturePrisma.membership.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await fixturePrisma.serviceAccount.deleteMany({
      where: { principalId: { in: extraPrincipalIds.splice(0) } },
    });
    await fixturePrisma.principal.deleteMany({ where: { id: { in: extraPrincipalIds } } });

    await Promise.all(fixtures.splice(0).map((fixture) => cleanupFixture(fixturePrisma, fixture)));
  });

  afterAll(async () => {
    await fixturePrisma.$disconnect();
  });

  async function setupForRole(role: "Owner" | "Admin" | "Developer" | "Viewer") {
    const context = await createWorkspaceTestApp();
    apps.push(context);
    const fixture = await seedWorkspaceWithRole(fixturePrisma, role);
    fixtures.push(fixture);
    return { context, fixture };
  }

  it("creates a service account when caller has workspace.manage", async () => {
    const { context, fixture } = await setupForRole("Owner");

    const response = await context.app.inject({
      method: "POST",
      url: "/v1/service-accounts",
      headers: { "x-api-key": fixture.apiKey },
      payload: { workspaceId: fixture.workspaceId, displayName: "CI Bot", role: "Admin" },
    });

    expect(response.statusCode).toBe(201);
    const body = parse<{
      serviceAccount: { id: string; principalId: string; displayName: string; role: string };
    }>(response);
    expect(body.serviceAccount.displayName).toBe("CI Bot");
    expect(body.serviceAccount.role).toBe("Admin");
    extraPrincipalIds.push(body.serviceAccount.principalId);

    const membership = await fixturePrisma.membership.findUnique({
      where: {
        workspaceId_principalId: {
          workspaceId: fixture.workspaceId,
          principalId: body.serviceAccount.principalId,
        },
      },
    });
    expect(membership?.role).toBe("Admin");
  });

  it.each(["Admin", "Developer", "Viewer"] as const)(
    "rejects service account creation from role=%s",
    async (role) => {
      const { context, fixture } = await setupForRole(role);

      const response = await context.app.inject({
        method: "POST",
        url: "/v1/service-accounts",
        headers: { "x-api-key": fixture.apiKey },
        payload: { workspaceId: fixture.workspaceId, displayName: "Should Fail", role: "Viewer" },
      });

      expect(response.statusCode).toBe(403);
    },
  );

  it("rejects cross-workspace service account creation", async () => {
    const { context, fixture: ownerInA } = await setupForRole("Owner");
    const { fixture: workspaceB } = await setupForRole("Owner");

    const response = await context.app.inject({
      method: "POST",
      url: "/v1/service-accounts",
      headers: { "x-api-key": ownerInA.apiKey },
      payload: {
        workspaceId: workspaceB.workspaceId,
        displayName: "Cross Workspace",
        role: "Admin",
      },
    });

    expect(response.statusCode).toBe(403);
  });

  it("issues a key for a service account when caller has apikey.create", async () => {
    const { context, fixture: owner } = await setupForRole("Owner");

    const createResponse = await context.app.inject({
      method: "POST",
      url: "/v1/service-accounts",
      headers: { "x-api-key": owner.apiKey },
      payload: { workspaceId: owner.workspaceId, displayName: "Deploy Bot", role: "Developer" },
    });
    const serviceAccount = parse<{ serviceAccount: { id: string; principalId: string } }>(
      createResponse,
    ).serviceAccount;
    extraPrincipalIds.push(serviceAccount.principalId);

    const keyResponse = await context.app.inject({
      method: "POST",
      url: `/v1/service-accounts/${serviceAccount.id}/keys`,
      headers: { "x-api-key": owner.apiKey },
      payload: { workspaceId: owner.workspaceId, name: "deploy key" },
    });

    expect(keyResponse.statusCode).toBe(201);
    const { apiKey, workspaceId } = parse<{ apiKey: string; workspaceId: string }>(keyResponse);
    expect(apiKey).toBeTruthy();
    expect(workspaceId).toBe(owner.workspaceId);
  });

  it("rejects key issuance from roles without apikey.create", async () => {
    const { context: ownerContext, fixture: owner } = await setupForRole("Owner");
    const createResponse = await ownerContext.app.inject({
      method: "POST",
      url: "/v1/service-accounts",
      headers: { "x-api-key": owner.apiKey },
      payload: { workspaceId: owner.workspaceId, displayName: "No Access Bot", role: "Viewer" },
    });
    const serviceAccount = parse<{ serviceAccount: { id: string; principalId: string } }>(
      createResponse,
    ).serviceAccount;
    extraPrincipalIds.push(serviceAccount.principalId);

    const { context, fixture: viewer } = await setupForRole("Viewer");

    const response = await context.app.inject({
      method: "POST",
      url: `/v1/service-accounts/${serviceAccount.id}/keys`,
      headers: { "x-api-key": viewer.apiKey },
      payload: { workspaceId: viewer.workspaceId, name: "should fail" },
    });

    expect(response.statusCode).toBe(403);
  });

  it("rejects issuing a key for a service account that doesn't belong to the target workspace", async () => {
    const { context: ownerAContext, fixture: ownerA } = await setupForRole("Owner");
    const createResponse = await ownerAContext.app.inject({
      method: "POST",
      url: "/v1/service-accounts",
      headers: { "x-api-key": ownerA.apiKey },
      payload: { workspaceId: ownerA.workspaceId, displayName: "Workspace A Bot", role: "Admin" },
    });
    const serviceAccount = parse<{ serviceAccount: { id: string; principalId: string } }>(
      createResponse,
    ).serviceAccount;
    extraPrincipalIds.push(serviceAccount.principalId);

    const { context: ownerBContext, fixture: ownerB } = await setupForRole("Owner");

    const response = await ownerBContext.app.inject({
      method: "POST",
      url: `/v1/service-accounts/${serviceAccount.id}/keys`,
      headers: { "x-api-key": ownerB.apiKey },
      payload: { workspaceId: ownerB.workspaceId, name: "cross-workspace key" },
    });

    expect(response.statusCode).toBe(404);
  });

  it("a service-account-issued key respects the same RBAC checks as a user's key", async () => {
    // Real Postgres-backed WorkspaceService: this test issues a key through
    // POST /v1/service-accounts/:id/keys and then uses that key against
    // another requirePermission-gated route in the same test, so the key
    // must actually exist in Postgres, not just the in-memory test double.
    const { app } = await createPrismaWorkspaceTestApp(fixturePrisma);
    apps.push({ app });
    const context = { app };
    const owner = await seedWorkspaceWithRole(fixturePrisma, "Owner");
    fixtures.push(owner);

    const ownerBotResponse = await context.app.inject({
      method: "POST",
      url: "/v1/service-accounts",
      headers: { "x-api-key": owner.apiKey },
      payload: { workspaceId: owner.workspaceId, displayName: "Owner Bot", role: "Owner" },
    });
    const ownerBot = parse<{ serviceAccount: { id: string; principalId: string } }>(
      ownerBotResponse,
    ).serviceAccount;
    extraPrincipalIds.push(ownerBot.principalId);

    const viewerBotResponse = await context.app.inject({
      method: "POST",
      url: "/v1/service-accounts",
      headers: { "x-api-key": owner.apiKey },
      payload: { workspaceId: owner.workspaceId, displayName: "Viewer Bot", role: "Viewer" },
    });
    const viewerBot = parse<{ serviceAccount: { id: string; principalId: string } }>(
      viewerBotResponse,
    ).serviceAccount;
    extraPrincipalIds.push(viewerBot.principalId);

    const ownerBotKeyResponse = await context.app.inject({
      method: "POST",
      url: `/v1/service-accounts/${ownerBot.id}/keys`,
      headers: { "x-api-key": owner.apiKey },
      payload: { workspaceId: owner.workspaceId, name: "owner bot key" },
    });
    const { apiKey: ownerBotKey } = parse<{ apiKey: string }>(ownerBotKeyResponse);

    const viewerBotKeyResponse = await context.app.inject({
      method: "POST",
      url: `/v1/service-accounts/${viewerBot.id}/keys`,
      headers: { "x-api-key": owner.apiKey },
      payload: { workspaceId: owner.workspaceId, name: "viewer bot key" },
    });
    const { apiKey: viewerBotKey } = parse<{ apiKey: string }>(viewerBotKeyResponse);

    // Same workspace.manage-gated route a human Owner/Viewer key was already
    // tested against in workspaces-rbac.test.ts — a service-account-issued
    // key must be indistinguishable to requirePermission from a user's key.
    const ownerBotPatch = await context.app.inject({
      method: "PATCH",
      url: `/v1/workspaces/${owner.workspaceId}`,
      headers: { "x-api-key": ownerBotKey },
      payload: { name: "Renamed by Owner Bot" },
    });
    expect(ownerBotPatch.statusCode).toBe(200);

    const viewerBotPatch = await context.app.inject({
      method: "PATCH",
      url: `/v1/workspaces/${owner.workspaceId}`,
      headers: { "x-api-key": viewerBotKey },
      payload: { name: "Renamed by Viewer Bot" },
    });
    expect(viewerBotPatch.statusCode).toBe(403);
  });
});

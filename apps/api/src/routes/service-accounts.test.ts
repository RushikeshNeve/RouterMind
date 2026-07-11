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
    await fixturePrisma.auditEvent.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
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
      url: `/v1/workspaces/${fixture.workspaceId}/service-accounts`,
      headers: { "x-api-key": fixture.apiKey },
      payload: { displayName: "CI Bot", role: "Admin" },
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
        url: `/v1/workspaces/${fixture.workspaceId}/service-accounts`,
        headers: { "x-api-key": fixture.apiKey },
        payload: { displayName: "Should Fail", role: "Viewer" },
      });

      expect(response.statusCode).toBe(403);
    },
  );

  it("rejects cross-workspace service account creation", async () => {
    const { context, fixture: ownerInA } = await setupForRole("Owner");
    const { fixture: workspaceB } = await setupForRole("Owner");

    const response = await context.app.inject({
      method: "POST",
      url: `/v1/workspaces/${workspaceB.workspaceId}/service-accounts`,
      headers: { "x-api-key": ownerInA.apiKey },
      payload: { displayName: "Cross Workspace", role: "Admin" },
    });

    expect(response.statusCode).toBe(403);
  });

  it("issues a key for a service account when caller has apikey.create", async () => {
    const { context, fixture: owner } = await setupForRole("Owner");

    const createResponse = await context.app.inject({
      method: "POST",
      url: `/v1/workspaces/${owner.workspaceId}/service-accounts`,
      headers: { "x-api-key": owner.apiKey },
      payload: { displayName: "Deploy Bot", role: "Developer" },
    });
    const serviceAccount = parse<{ serviceAccount: { id: string; principalId: string } }>(
      createResponse,
    ).serviceAccount;
    extraPrincipalIds.push(serviceAccount.principalId);

    const keyResponse = await context.app.inject({
      method: "POST",
      url: `/v1/workspaces/${owner.workspaceId}/service-accounts/${serviceAccount.id}/keys`,
      headers: { "x-api-key": owner.apiKey },
      payload: { name: "deploy key" },
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
      url: `/v1/workspaces/${owner.workspaceId}/service-accounts`,
      headers: { "x-api-key": owner.apiKey },
      payload: { displayName: "No Access Bot", role: "Viewer" },
    });
    const serviceAccount = parse<{ serviceAccount: { id: string; principalId: string } }>(
      createResponse,
    ).serviceAccount;
    extraPrincipalIds.push(serviceAccount.principalId);

    const { context, fixture: viewer } = await setupForRole("Viewer");

    const response = await context.app.inject({
      method: "POST",
      url: `/v1/workspaces/${viewer.workspaceId}/service-accounts/${serviceAccount.id}/keys`,
      headers: { "x-api-key": viewer.apiKey },
      payload: { name: "should fail" },
    });

    expect(response.statusCode).toBe(403);
  });

  it("rejects issuing a key for a service account that doesn't belong to the target workspace", async () => {
    const { context: ownerAContext, fixture: ownerA } = await setupForRole("Owner");
    const createResponse = await ownerAContext.app.inject({
      method: "POST",
      url: `/v1/workspaces/${ownerA.workspaceId}/service-accounts`,
      headers: { "x-api-key": ownerA.apiKey },
      payload: { displayName: "Workspace A Bot", role: "Admin" },
    });
    const serviceAccount = parse<{ serviceAccount: { id: string; principalId: string } }>(
      createResponse,
    ).serviceAccount;
    extraPrincipalIds.push(serviceAccount.principalId);

    const { context: ownerBContext, fixture: ownerB } = await setupForRole("Owner");

    const response = await ownerBContext.app.inject({
      method: "POST",
      url: `/v1/workspaces/${ownerB.workspaceId}/service-accounts/${serviceAccount.id}/keys`,
      headers: { "x-api-key": ownerB.apiKey },
      payload: { name: "cross-workspace key" },
    });

    expect(response.statusCode).toBe(404);
  });

  it("a service-account-issued key respects the same RBAC checks as a user's key", async () => {
    // Real Postgres-backed WorkspaceService: this test issues a key through
    // POST .../service-accounts/:id/keys and then uses that key against
    // another requirePermission-gated route in the same test, so the key
    // must actually exist in Postgres, not just the in-memory test double.
    const { app } = await createPrismaWorkspaceTestApp(fixturePrisma);
    apps.push({ app });
    const context = { app };
    const owner = await seedWorkspaceWithRole(fixturePrisma, "Owner");
    fixtures.push(owner);

    const ownerBotResponse = await context.app.inject({
      method: "POST",
      url: `/v1/workspaces/${owner.workspaceId}/service-accounts`,
      headers: { "x-api-key": owner.apiKey },
      payload: { displayName: "Owner Bot", role: "Owner" },
    });
    const ownerBot = parse<{ serviceAccount: { id: string; principalId: string } }>(
      ownerBotResponse,
    ).serviceAccount;
    extraPrincipalIds.push(ownerBot.principalId);

    const viewerBotResponse = await context.app.inject({
      method: "POST",
      url: `/v1/workspaces/${owner.workspaceId}/service-accounts`,
      headers: { "x-api-key": owner.apiKey },
      payload: { displayName: "Viewer Bot", role: "Viewer" },
    });
    const viewerBot = parse<{ serviceAccount: { id: string; principalId: string } }>(
      viewerBotResponse,
    ).serviceAccount;
    extraPrincipalIds.push(viewerBot.principalId);

    const ownerBotKeyResponse = await context.app.inject({
      method: "POST",
      url: `/v1/workspaces/${owner.workspaceId}/service-accounts/${ownerBot.id}/keys`,
      headers: { "x-api-key": owner.apiKey },
      payload: { name: "owner bot key" },
    });
    const { apiKey: ownerBotKey } = parse<{ apiKey: string }>(ownerBotKeyResponse);

    const viewerBotKeyResponse = await context.app.inject({
      method: "POST",
      url: `/v1/workspaces/${owner.workspaceId}/service-accounts/${viewerBot.id}/keys`,
      headers: { "x-api-key": owner.apiKey },
      payload: { name: "viewer bot key" },
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

  it("lists service accounts for a workspace with their keys, when caller has apikey.read", async () => {
    // Prisma-backed: the list route reads ApiKey rows directly from
    // Postgres, so the key must actually be issued there, not into the
    // in-memory test double setupForRole()/createWorkspaceTestApp() uses.
    const { app } = await createPrismaWorkspaceTestApp(fixturePrisma);
    apps.push({ app });
    const context = { app };
    const owner = await seedWorkspaceWithRole(fixturePrisma, "Owner");
    fixtures.push(owner);

    const createResponse = await context.app.inject({
      method: "POST",
      url: `/v1/workspaces/${owner.workspaceId}/service-accounts`,
      headers: { "x-api-key": owner.apiKey },
      payload: { displayName: "List Bot", description: "for listing", role: "Developer" },
    });
    const serviceAccount = parse<{ serviceAccount: { id: string; principalId: string } }>(
      createResponse,
    ).serviceAccount;
    extraPrincipalIds.push(serviceAccount.principalId);

    await context.app.inject({
      method: "POST",
      url: `/v1/workspaces/${owner.workspaceId}/service-accounts/${serviceAccount.id}/keys`,
      headers: { "x-api-key": owner.apiKey },
      payload: { name: "list bot key" },
    });

    const response = await context.app.inject({
      method: "GET",
      url: `/v1/workspaces/${owner.workspaceId}/service-accounts`,
      headers: { "x-api-key": owner.apiKey },
    });

    expect(response.statusCode).toBe(200);
    const body = parse<{
      serviceAccounts: Array<{
        id: string;
        displayName: string;
        description: string | null;
        role: string;
        keys: Array<{ id: string; name: string; isActive: boolean }>;
      }>;
    }>(response);
    const listed = body.serviceAccounts.find((account) => account.id === serviceAccount.id);
    expect(listed).toBeDefined();
    expect(listed?.displayName).toBe("List Bot");
    expect(listed?.description).toBe("for listing");
    expect(listed?.role).toBe("Developer");
    expect(listed?.keys).toHaveLength(1);
    expect(listed?.keys[0]?.name).toBe("list bot key");
    expect(listed?.keys[0]?.isActive).toBe(true);
  });

  it.each(["Developer", "Viewer"] as const)(
    "rejects listing service accounts from role=%s",
    async (role) => {
      const { context, fixture } = await setupForRole(role);

      const response = await context.app.inject({
        method: "GET",
        url: `/v1/workspaces/${fixture.workspaceId}/service-accounts`,
        headers: { "x-api-key": fixture.apiKey },
      });

      expect(response.statusCode).toBe(403);
    },
  );

  it("revokes a service-account key when caller has apikey.delete, and a second revoke 409s", async () => {
    // Prisma-backed for the same reason as the listing test above -- the
    // revoke route reads/writes the ApiKey row directly via Postgres.
    const { app } = await createPrismaWorkspaceTestApp(fixturePrisma);
    apps.push({ app });
    const context = { app };
    const owner = await seedWorkspaceWithRole(fixturePrisma, "Owner");
    fixtures.push(owner);

    const createResponse = await context.app.inject({
      method: "POST",
      url: `/v1/workspaces/${owner.workspaceId}/service-accounts`,
      headers: { "x-api-key": owner.apiKey },
      payload: { displayName: "Revoke Bot", role: "Developer" },
    });
    const serviceAccount = parse<{ serviceAccount: { id: string; principalId: string } }>(
      createResponse,
    ).serviceAccount;
    extraPrincipalIds.push(serviceAccount.principalId);

    const keyResponse = await context.app.inject({
      method: "POST",
      url: `/v1/workspaces/${owner.workspaceId}/service-accounts/${serviceAccount.id}/keys`,
      headers: { "x-api-key": owner.apiKey },
      payload: { name: "revoke me" },
    });
    const { id: keyId } = parse<{ id: string }>(keyResponse);

    const revokeResponse = await context.app.inject({
      method: "DELETE",
      url: `/v1/workspaces/${owner.workspaceId}/service-accounts/${serviceAccount.id}/keys/${keyId}`,
      headers: { "x-api-key": owner.apiKey },
    });
    expect(revokeResponse.statusCode).toBe(200);

    const key = await fixturePrisma.apiKey.findUnique({ where: { id: keyId } });
    expect(key?.isActive).toBe(false);

    const secondRevoke = await context.app.inject({
      method: "DELETE",
      url: `/v1/workspaces/${owner.workspaceId}/service-accounts/${serviceAccount.id}/keys/${keyId}`,
      headers: { "x-api-key": owner.apiKey },
    });
    expect(secondRevoke.statusCode).toBe(409);
  });

  it("rejects key revocation from roles without apikey.delete", async () => {
    // Prisma-backed for the owner side, same reason as above -- the key
    // needs to exist in real Postgres so the final assertion (isActive
    // unchanged) is checking a row that's actually there.
    const { app: ownerApp } = await createPrismaWorkspaceTestApp(fixturePrisma);
    apps.push({ app: ownerApp });
    const ownerContext = { app: ownerApp };
    const owner = await seedWorkspaceWithRole(fixturePrisma, "Owner");
    fixtures.push(owner);
    const createResponse = await ownerContext.app.inject({
      method: "POST",
      url: `/v1/workspaces/${owner.workspaceId}/service-accounts`,
      headers: { "x-api-key": owner.apiKey },
      payload: { displayName: "Protected Bot", role: "Developer" },
    });
    const serviceAccount = parse<{ serviceAccount: { id: string; principalId: string } }>(
      createResponse,
    ).serviceAccount;
    extraPrincipalIds.push(serviceAccount.principalId);

    const keyResponse = await ownerContext.app.inject({
      method: "POST",
      url: `/v1/workspaces/${owner.workspaceId}/service-accounts/${serviceAccount.id}/keys`,
      headers: { "x-api-key": owner.apiKey },
      payload: { name: "protected key" },
    });
    const { id: keyId } = parse<{ id: string }>(keyResponse);

    const { context: developerContext, fixture: developer } = await setupForRole("Developer");
    const response = await developerContext.app.inject({
      method: "DELETE",
      url: `/v1/workspaces/${developer.workspaceId}/service-accounts/${serviceAccount.id}/keys/${keyId}`,
      headers: { "x-api-key": developer.apiKey },
    });

    expect(response.statusCode).toBe(403);

    const key = await fixturePrisma.apiKey.findUnique({ where: { id: keyId } });
    expect(key?.isActive).toBe(true);
  });

  it("service-account creation, key issuance, and key revocation all show up correctly in the audit log", async () => {
    // Prisma-backed, same reason as the list/revoke tests above -- the
    // revoke route reads/writes the ApiKey row directly via Postgres.
    const { app } = await createPrismaWorkspaceTestApp(fixturePrisma);
    apps.push({ app });
    const context = { app };
    const owner = await seedWorkspaceWithRole(fixturePrisma, "Owner");
    fixtures.push(owner);

    const createResponse = await context.app.inject({
      method: "POST",
      url: `/v1/workspaces/${owner.workspaceId}/service-accounts`,
      headers: { "x-api-key": owner.apiKey },
      payload: { displayName: "Audited Bot", role: "Developer" },
    });
    const serviceAccount = parse<{ serviceAccount: { id: string; principalId: string } }>(
      createResponse,
    ).serviceAccount;
    extraPrincipalIds.push(serviceAccount.principalId);

    const keyResponse = await context.app.inject({
      method: "POST",
      url: `/v1/workspaces/${owner.workspaceId}/service-accounts/${serviceAccount.id}/keys`,
      headers: { "x-api-key": owner.apiKey },
      payload: { name: "audited key" },
    });
    const { id: keyId } = parse<{ id: string }>(keyResponse);

    await context.app.inject({
      method: "DELETE",
      url: `/v1/workspaces/${owner.workspaceId}/service-accounts/${serviceAccount.id}/keys/${keyId}`,
      headers: { "x-api-key": owner.apiKey },
    });

    // The last slice's audit-log endpoint (pagination/filtering) is what
    // actually surfaces this in the dashboard's Audit Log screen -- reading
    // through it here, not the raw AuditEvent table, exercises the same
    // path the dashboard does.
    const auditResponse = await context.app.inject({
      method: "GET",
      url: `/v1/workspaces/${owner.workspaceId}/audit-log`,
      headers: { "x-api-key": owner.apiKey },
    });
    expect(auditResponse.statusCode).toBe(200);
    const body = parse<{
      events: Array<{
        action: string;
        principalId: string;
        targetType: string;
        targetId: string;
        principal: { displayName: string; type: string } | null;
      }>;
    }>(auditResponse);

    const createEvent = body.events.find(
      (event) => event.action === "service_account.create" && event.targetId === serviceAccount.id,
    );
    const issueEvent = body.events.find(
      (event) => event.action === "apikey.create" && event.targetId === keyId,
    );
    const revokeEvent = body.events.find(
      (event) => event.action === "apikey.delete" && event.targetId === keyId,
    );

    expect(createEvent).toBeDefined();
    expect(issueEvent).toBeDefined();
    expect(revokeEvent).toBeDefined();
    // All three are actions the Owner performed on the service account, not
    // the service account acting on its own behalf -- attribution should
    // point at the human who did it.
    expect(createEvent?.principalId).toBe(owner.principalId);
    expect(issueEvent?.principalId).toBe(owner.principalId);
    expect(revokeEvent?.principalId).toBe(owner.principalId);
    expect(createEvent?.targetType).toBe("ServiceAccount");
    expect(issueEvent?.targetType).toBe("ApiKey");
    expect(revokeEvent?.targetType).toBe("ApiKey");

    // Filtering by action=apikey.delete (last slice's filter support) picks
    // out exactly the revoke event.
    const filteredResponse = await context.app.inject({
      method: "GET",
      url: `/v1/workspaces/${owner.workspaceId}/audit-log?action=apikey.delete`,
      headers: { "x-api-key": owner.apiKey },
    });
    const filteredBody = parse<{ events: Array<{ targetId: string }> }>(filteredResponse);
    expect(filteredBody.events).toHaveLength(1);
    expect(filteredBody.events[0]?.targetId).toBe(keyId);
  });
});

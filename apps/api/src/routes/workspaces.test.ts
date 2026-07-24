import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  cleanupFixture,
  createWorkspaceTestApp,
  seedWorkspaceWithRole,
  testConfig,
  type WorkspaceRoleFixture,
} from "./workspaces-rbac-fixtures.js";

function parse<T>(response: { payload: string }): T {
  return JSON.parse(response.payload) as T;
}

describe("workspace routes", () => {
  const apps: Awaited<ReturnType<typeof createWorkspaceTestApp>>[] = [];
  const fixturePrisma = new PrismaClient({ datasourceUrl: testConfig.DATABASE_URL });
  const fixtures: WorkspaceRoleFixture[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map(({ app }) => app.close()));
    await Promise.all(fixtures.splice(0).map((fixture) => cleanupFixture(fixturePrisma, fixture)));
  });

  afterAll(async () => {
    await fixturePrisma.$disconnect();
  });

  it("creates a workspace within an organization for an authorized caller and makes them Owner", async () => {
    const context = await createWorkspaceTestApp();
    apps.push(context);

    const fixture = await seedWorkspaceWithRole(fixturePrisma, "Owner");
    fixtures.push(fixture);

    const created = await context.app.inject({
      method: "POST",
      url: "/v1/workspaces",
      headers: { "x-api-key": fixture.apiKey },
      payload: { name: "Acme AI", organizationId: fixture.organizationId },
    });
    const workspace = parse<{ workspace: { id: string; slug: string } }>(created).workspace;

    expect(created.statusCode).toBe(201);
    expect(workspace.slug).toBe("acme-ai");

    const dbWorkspace = await fixturePrisma.workspace.findUnique({ where: { id: workspace.id } });
    expect(dbWorkspace?.organizationId).toBe(fixture.organizationId);

    const membership = await fixturePrisma.membership.findUnique({
      where: {
        workspaceId_principalId: { workspaceId: workspace.id, principalId: fixture.principalId },
      },
    });
    expect(membership?.role).toBe("owner");

    const legacyMember = await fixturePrisma.workspaceMember.findFirst({
      where: { workspaceId: workspace.id, userId: fixture.userId },
    });
    expect(legacyMember?.role).toBe("owner");

    await fixturePrisma.auditEvent.deleteMany({ where: { workspaceId: workspace.id } });
    await fixturePrisma.membership.deleteMany({ where: { workspaceId: workspace.id } });
    await fixturePrisma.workspaceMember.deleteMany({ where: { workspaceId: workspace.id } });
    await fixturePrisma.workspace.deleteMany({ where: { id: workspace.id } });
  });

  it("rejects an unauthenticated request to create a workspace", async () => {
    const context = await createWorkspaceTestApp();
    apps.push(context);

    const fixture = await seedWorkspaceWithRole(fixturePrisma, "Owner");
    fixtures.push(fixture);

    const response = await context.app.inject({
      method: "POST",
      url: "/v1/workspaces",
      payload: { name: "No Auth Workspace", organizationId: fixture.organizationId },
    });

    expect(response.statusCode).toBe(401);

    const workspaces = await fixturePrisma.workspace.findMany({
      where: { organizationId: fixture.organizationId, name: "No Auth Workspace" },
    });
    expect(workspaces).toHaveLength(0);
  });

  it("enforces role permissions for API key management", async () => {
    const context = await createWorkspaceTestApp();
    apps.push(context);
    const workspace = await context.workspaceService.createWorkspace({
      name: "Security Team",
      ownerUserId: "owner-user",
    });
    await context.workspaceService.addMember({
      workspaceId: workspace.id,
      userId: "viewer-user",
      role: "viewer",
    });

    const fixture = await seedWorkspaceWithRole(fixturePrisma, "Viewer", workspace.id);
    fixtures.push(fixture);

    const response = await context.app.inject({
      method: "POST",
      url: `/v1/workspaces/${workspace.id}/api-keys`,
      headers: { "x-api-key": fixture.apiKey },
      payload: { userId: "viewer-user", name: "viewer key" },
    });

    expect(response.statusCode).toBe(403);
  });

  it("authenticates workspace API keys and attaches workspace context", async () => {
    const context = await createWorkspaceTestApp();
    apps.push(context);
    const workspace = await context.workspaceService.createWorkspace({
      name: "Platform",
      ownerUserId: "owner-user",
    });

    const fixture = await seedWorkspaceWithRole(fixturePrisma, "Owner", workspace.id);
    fixtures.push(fixture);

    const keyResponse = await context.app.inject({
      method: "POST",
      url: `/v1/workspaces/${workspace.id}/api-keys`,
      headers: { "x-api-key": fixture.apiKey },
      payload: { userId: fixture.userId, name: "gateway" },
    });
    const { apiKey } = parse<{ apiKey: string }>(keyResponse);

    const response = await context.app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { "x-api-key": apiKey },
      payload: {
        model: "gpt-4o",
        messages: [{ role: "user", content: "Hello workspace" }],
        cache: { mode: "disabled" },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(context.availabilityWorkspaceIds).toEqual([workspace.id]);
    expect(context.requestLogStore.entries[0]?.workspaceId).toBe(workspace.id);
  });

  it("blocks workspace requests with workspace-level budget checks", async () => {
    const context = await createWorkspaceTestApp({
      costGuardrailService: {
        checkBeforeRequest: (input) =>
          Promise.resolve(
            input.workspaceId
              ? {
                  allowed: false,
                  errorCode: "BUDGET_EXCEEDED",
                  message: "Workspace budget exceeded.",
                }
              : { allowed: true },
          ),
        recordUsage: () => Promise.resolve(),
      },
    });
    apps.push(context);
    const workspace = await context.workspaceService.createWorkspace({
      name: "Finance",
      ownerUserId: "owner-user",
    });
    const { apiKey } = await context.workspaceService.createApiKey({
      workspaceId: workspace.id,
      userId: "owner-user",
      principalId: "owner-user-principal",
      name: "budget key",
      nodeEnv: "test",
    });

    const response = await context.app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { "x-api-key": apiKey },
      payload: {
        model: "gpt-4o",
        messages: [{ role: "user", content: "Hello" }],
      },
    });

    expect(response.statusCode).toBe(403);
    expect(parse<{ error: { message: string } }>(response).error.message).toContain(
      "Workspace budget",
    );
  });

  // The unscoped GET /v1/analytics/summary?workspaceId= route this test used
  // to exercise no longer exists -- analytics is now served from
  // /v1/workspaces/:workspaceId/analytics/* (RBAC-gated, workspaceId derived
  // from the validated path param, not a query string). Coverage for
  // workspace-scoped analytics filtering, including cross-workspace
  // isolation, now lives in analytics.test.ts.
});

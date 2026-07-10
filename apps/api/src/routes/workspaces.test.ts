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

  it("creates a workspace and adds a member", async () => {
    const context = await createWorkspaceTestApp();
    apps.push(context);

    const created = await context.app.inject({
      method: "POST",
      url: "/v1/workspaces",
      payload: { name: "Acme AI", ownerUserId: "owner-user" },
    });
    const workspace = parse<{ workspace: { id: string; slug: string } }>(created).workspace;

    const fixture = await seedWorkspaceWithRole(fixturePrisma, "Owner", workspace.id);
    fixtures.push(fixture);

    const member = await context.app.inject({
      method: "POST",
      url: `/v1/workspaces/${workspace.id}/members`,
      headers: { "x-api-key": fixture.apiKey },
      payload: { userId: "dev-user-2", role: "developer" },
    });

    expect(created.statusCode).toBe(201);
    expect(workspace.slug).toBe("acme-ai");
    expect(member.statusCode).toBe(201);
    expect(parse<{ member: { role: string } }>(member).member.role).toBe("developer");
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
      payload: { userId: "owner-user", name: "gateway" },
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

  it("filters analytics by workspaceId", async () => {
    const context = await createWorkspaceTestApp();
    apps.push(context);
    await context.requestLogStore.create({
      workspaceId: "workspace-a",
      apiKey: "a",
      requestedModel: "auto",
      selectedModel: "gpt-4o",
      provider: "openai",
      latencyMs: 10,
      status: "success",
    });
    await context.requestLogStore.create({
      workspaceId: "workspace-b",
      apiKey: "b",
      requestedModel: "auto",
      selectedModel: "gpt-4o",
      provider: "openai",
      latencyMs: 10,
      status: "success",
    });

    const response = await context.app.inject({
      method: "GET",
      url: "/v1/analytics/summary?workspaceId=workspace-a",
    });

    expect(response.statusCode).toBe(200);
    expect(parse<{ requests: { total: number } }>(response).requests.total).toBe(1);
  });
});

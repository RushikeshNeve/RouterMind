import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, describe, expect, it } from "vitest";

function parse<T>(response: { payload: string }): T {
  return JSON.parse(response.payload) as T;
}

import {
  cleanupFixture,
  createWorkspaceTestApp,
  seedWorkspaceWithRole,
  testConfig,
  type WorkspaceRoleFixture,
} from "./workspaces-rbac-fixtures.js";

const ROLES = ["Owner", "Admin", "Developer", "Viewer"] as const;

const ALLOWED_ROLES: Record<
  "workspace.manage" | "apikey.create" | "apikey.read",
  readonly string[]
> = {
  "workspace.manage": ["Owner"],
  "apikey.create": ["Admin", "Owner"],
  "apikey.read": ["Admin", "Owner"],
};

describe("workspace RBAC allow/deny matrix", () => {
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

  async function setupForRole(role: (typeof ROLES)[number]) {
    const context = await createWorkspaceTestApp();
    apps.push(context);

    const fixture = await seedWorkspaceWithRole(fixturePrisma, role);
    fixtures.push(fixture);

    const now = new Date();
    context.workspaceService.workspaces.push({
      id: fixture.workspaceId,
      name: "RBAC Matrix Workspace",
      slug: fixture.workspaceId,
      createdAt: now,
      updatedAt: now,
    });
    const targetMember = await context.workspaceService.addMember({
      workspaceId: fixture.workspaceId,
      userId: "target-user",
      role: "developer",
    });

    return { context, fixture, targetMember };
  }

  describe.each(ROLES)("role=%s", (role) => {
    const expectWorkspaceManage = ALLOWED_ROLES["workspace.manage"].includes(role) ? 200 : 403;
    const expectMemberWrite = ALLOWED_ROLES["workspace.manage"].includes(role) ? 201 : 403;
    const expectApiKeyCreate = ALLOWED_ROLES["apikey.create"].includes(role) ? 201 : 403;
    const expectApiKeyRead = ALLOWED_ROLES["apikey.read"].includes(role) ? 200 : 403;

    it(`PATCH /v1/workspaces/:id -> ${expectWorkspaceManage}`, async () => {
      const { context, fixture } = await setupForRole(role);
      const response = await context.app.inject({
        method: "PATCH",
        url: `/v1/workspaces/${fixture.workspaceId}`,
        headers: { "x-api-key": fixture.apiKey },
        payload: { name: "Renamed Workspace" },
      });
      expect(response.statusCode).toBe(expectWorkspaceManage);
    });

    it(`POST /v1/workspaces/:id/members -> ${expectMemberWrite}`, async () => {
      const { context, fixture } = await setupForRole(role);
      const response = await context.app.inject({
        method: "POST",
        url: `/v1/workspaces/${fixture.workspaceId}/members`,
        headers: { "x-api-key": fixture.apiKey },
        payload: { userId: "new-member", role: "developer" },
      });
      expect(response.statusCode).toBe(expectMemberWrite);
    });

    it(`PATCH /v1/workspaces/:id/members/:memberId -> ${expectWorkspaceManage}`, async () => {
      const { context, fixture, targetMember } = await setupForRole(role);
      const response = await context.app.inject({
        method: "PATCH",
        url: `/v1/workspaces/${fixture.workspaceId}/members/${targetMember.id}`,
        headers: { "x-api-key": fixture.apiKey },
        payload: { role: "admin" },
      });
      expect(response.statusCode).toBe(expectWorkspaceManage);
    });

    it(`DELETE /v1/workspaces/:id/members/:memberId -> ${expectWorkspaceManage}`, async () => {
      const { context, fixture, targetMember } = await setupForRole(role);
      const response = await context.app.inject({
        method: "DELETE",
        url: `/v1/workspaces/${fixture.workspaceId}/members/${targetMember.id}`,
        headers: { "x-api-key": fixture.apiKey },
      });
      expect(response.statusCode).toBe(expectWorkspaceManage);
    });

    it(`POST /v1/workspaces/:id/api-keys -> ${expectApiKeyCreate}`, async () => {
      const { context, fixture } = await setupForRole(role);
      const response = await context.app.inject({
        method: "POST",
        url: `/v1/workspaces/${fixture.workspaceId}/api-keys`,
        headers: { "x-api-key": fixture.apiKey },
        payload: { userId: fixture.userId, name: "matrix key" },
      });
      expect(response.statusCode).toBe(expectApiKeyCreate);
    });

    it(`GET /v1/workspaces/:id/api-keys -> ${expectApiKeyRead}`, async () => {
      const { context, fixture } = await setupForRole(role);
      const response = await context.app.inject({
        method: "GET",
        url: `/v1/workspaces/${fixture.workspaceId}/api-keys`,
        headers: { "x-api-key": fixture.apiKey },
      });
      expect(response.statusCode).toBe(expectApiKeyRead);
    });
  });

  it("returns 401 with no API key at all", async () => {
    const { context, fixture } = await setupForRole("Owner");
    const response = await context.app.inject({
      method: "PATCH",
      url: `/v1/workspaces/${fixture.workspaceId}`,
      payload: { name: "No Key" },
    });
    expect(response.statusCode).toBe(401);
  });

  it("returns 403 when the API key belongs to a different workspace", async () => {
    const { context, fixture: ownerInWorkspaceA } = await setupForRole("Owner");
    const workspaceB = await context.workspaceService.createWorkspace({
      name: "Workspace B",
      ownerUserId: "owner-b",
    });

    const response = await context.app.inject({
      method: "PATCH",
      url: `/v1/workspaces/${workspaceB.id}`,
      headers: { "x-api-key": ownerInWorkspaceA.apiKey },
      payload: { name: "Cross-workspace rename attempt" },
    });

    expect(response.statusCode).toBe(403);
  });

  it("blocks demoting the last Owner", async () => {
    const { context, fixture } = await setupForRole("Owner");
    const now = new Date();
    const ownerMember = await context.workspaceService.addMember({
      workspaceId: fixture.workspaceId,
      userId: "sole-owner-user",
      role: "owner",
    });
    void now;

    const response = await context.app.inject({
      method: "PATCH",
      url: `/v1/workspaces/${fixture.workspaceId}/members/${ownerMember.id}`,
      headers: { "x-api-key": fixture.apiKey },
      payload: { role: "admin" },
    });

    expect(response.statusCode).toBe(409);
  });

  it("blocks removing the last Owner", async () => {
    const { context, fixture } = await setupForRole("Owner");
    const ownerMember = await context.workspaceService.addMember({
      workspaceId: fixture.workspaceId,
      userId: "sole-owner-user-2",
      role: "owner",
    });

    const response = await context.app.inject({
      method: "DELETE",
      url: `/v1/workspaces/${fixture.workspaceId}/members/${ownerMember.id}`,
      headers: { "x-api-key": fixture.apiKey },
    });

    expect(response.statusCode).toBe(409);
  });

  it("allows demoting an Owner when another Owner remains", async () => {
    const { context, fixture } = await setupForRole("Owner");
    const firstOwner = await context.workspaceService.addMember({
      workspaceId: fixture.workspaceId,
      userId: "owner-one",
      role: "owner",
    });
    await context.workspaceService.addMember({
      workspaceId: fixture.workspaceId,
      userId: "owner-two",
      role: "owner",
    });

    const response = await context.app.inject({
      method: "PATCH",
      url: `/v1/workspaces/${fixture.workspaceId}/members/${firstOwner.id}`,
      headers: { "x-api-key": fixture.apiKey },
      payload: { role: "admin" },
    });

    expect(response.statusCode).toBe(200);
  });

  it("lists a workspace's own api keys without leaking keyHash", async () => {
    const { context, fixture } = await setupForRole("Owner");

    const response = await context.app.inject({
      method: "GET",
      url: `/v1/workspaces/${fixture.workspaceId}/api-keys`,
      headers: { "x-api-key": fixture.apiKey },
    });

    expect(response.statusCode).toBe(200);
    const body = parse<{
      apiKeys: Array<Record<string, unknown>>;
    }>(response);
    expect(body.apiKeys).toHaveLength(1);
    expect(body.apiKeys[0]?.id).toBe(fixture.apiKeyId);
    expect(body.apiKeys[0]).not.toHaveProperty("keyHash");
    expect(body.apiKeys[0]).not.toHaveProperty("apiKey");
  });

  it("rejects cross-workspace api key listing", async () => {
    const { context, fixture: ownerInWorkspaceA } = await setupForRole("Owner");
    const { fixture: ownerInWorkspaceB } = await setupForRole("Owner");

    const response = await context.app.inject({
      method: "GET",
      url: `/v1/workspaces/${ownerInWorkspaceB.workspaceId}/api-keys`,
      headers: { "x-api-key": ownerInWorkspaceA.apiKey },
    });

    expect(response.statusCode).toBe(403);
  });
});

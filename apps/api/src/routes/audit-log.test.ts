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

describe("audit log", () => {
  const apps: Array<{ readonly app: FastifyInstance }> = [];
  const fixturePrisma = new PrismaClient({ datasourceUrl: testConfig.DATABASE_URL });
  const fixtures: WorkspaceRoleFixture[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map(({ app }) => app.close()));
    const workspaceIds = fixtures.map((fixture) => fixture.workspaceId);
    await fixturePrisma.auditEvent.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await fixturePrisma.apiKey.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await fixturePrisma.membership.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
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

  it("writes an audit event when a mutation succeeds", async () => {
    const { app, fixture } = await setupForRole("Owner");

    const response = await app.inject({
      method: "PATCH",
      url: `/v1/workspaces/${fixture.workspaceId}`,
      headers: { "x-api-key": fixture.apiKey },
      payload: { name: "Renamed Workspace" },
    });
    expect(response.statusCode).toBe(200);

    const events = await fixturePrisma.auditEvent.findMany({
      where: { workspaceId: fixture.workspaceId, action: "workspace.update" },
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.principalId).toBe(fixture.principalId);
    expect(events[0]?.targetType).toBe("Workspace");
    expect(events[0]?.targetId).toBe(fixture.workspaceId);
  });

  it("does not write an audit event if the underlying mutation fails (same-transaction guarantee)", async () => {
    const { app, fixture } = await setupForRole("Owner");

    const before = await fixturePrisma.auditEvent.count({
      where: { workspaceId: fixture.workspaceId },
    });

    // No User row exists with this id, so the underlying INSERT INTO
    // "WorkspaceMember" violates its userId foreign key constraint partway
    // through the transaction. addMember() has no pre-check for this (unlike
    // the api-keys route), so this genuinely fails at the database layer,
    // not via a controlled early-return -- proving the audit write actually
    // rolls back with the mutation rather than merely not being reached.
    const response = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${fixture.workspaceId}/members`,
      headers: { "x-api-key": fixture.apiKey },
      payload: { userId: "user-that-does-not-exist", role: "developer" },
    });

    expect(response.statusCode).toBeGreaterThanOrEqual(500);

    const after = await fixturePrisma.auditEvent.count({
      where: { workspaceId: fixture.workspaceId },
    });
    expect(after).toBe(before);

    const member = await fixturePrisma.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "WorkspaceMember"
      WHERE "workspaceId" = ${fixture.workspaceId} AND "userId" = 'user-that-does-not-exist'
    `;
    expect(member).toHaveLength(0);
  });

  it("returns audit events for a workspace when caller has audit.read", async () => {
    const { app, fixture } = await setupForRole("Owner");

    await app.inject({
      method: "PATCH",
      url: `/v1/workspaces/${fixture.workspaceId}`,
      headers: { "x-api-key": fixture.apiKey },
      payload: { name: "Audited Rename" },
    });

    const response = await app.inject({
      method: "GET",
      url: `/v1/workspaces/${fixture.workspaceId}/audit-log`,
      headers: { "x-api-key": fixture.apiKey },
    });

    expect(response.statusCode).toBe(200);
    const body = parse<{ events: Array<{ action: string }> }>(response);
    expect(body.events.some((event) => event.action === "workspace.update")).toBe(true);
  });

  it.each(["Developer", "Viewer"] as const)(
    "rejects audit log reads from role=%s",
    async (role) => {
      const { app, fixture } = await setupForRole(role);

      const response = await app.inject({
        method: "GET",
        url: `/v1/workspaces/${fixture.workspaceId}/audit-log`,
        headers: { "x-api-key": fixture.apiKey },
      });

      expect(response.statusCode).toBe(403);
    },
  );

  it("rejects cross-workspace audit log reads", async () => {
    const { app, fixture: ownerA } = await setupForRole("Owner");
    const { fixture: ownerB } = await setupForRole("Owner");

    const response = await app.inject({
      method: "GET",
      url: `/v1/workspaces/${ownerB.workspaceId}/audit-log`,
      headers: { "x-api-key": ownerA.apiKey },
    });

    expect(response.statusCode).toBe(403);
  });
});

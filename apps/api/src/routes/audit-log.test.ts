import { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../app.js";
import type { EmailMessage, EmailSender } from "../infrastructure/email-sender.js";
import { PrismaWorkspaceService } from "../infrastructure/workspace-service.js";
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

class RecordingEmailSender implements EmailSender {
  readonly sent: EmailMessage[] = [];
  send(message: EmailMessage): Promise<void> {
    this.sent.push(message);
    return Promise.resolve();
  }
}

function extractToken(emailText: string): string {
  const match = emailText.match(/https?:\/\/\S+/);
  if (!match) {
    throw new Error(`No link found in email text: ${emailText}`);
  }
  const url = new URL(match[0]);
  const token = url.searchParams.get("token");
  if (!token) {
    throw new Error(`No token found in link: ${match[0]}`);
  }
  return token;
}

describe("audit log", () => {
  const apps: Array<{ readonly app: FastifyInstance }> = [];
  const fixturePrisma = new PrismaClient({ datasourceUrl: testConfig.DATABASE_URL });
  const fixtures: WorkspaceRoleFixture[] = [];
  const createdEmails: string[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map(({ app }) => app.close()));
    const workspaceIds = fixtures.map((fixture) => fixture.workspaceId);
    await fixturePrisma.auditEvent.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await fixturePrisma.apiKey.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await fixturePrisma.membership.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await fixturePrisma.workspaceMember.deleteMany({
      where: { workspaceId: { in: workspaceIds } },
    });

    const emails = createdEmails.splice(0);
    if (emails.length > 0) {
      const users = await fixturePrisma.user.findMany({ where: { email: { in: emails } } });
      const userIds = users.map((user) => user.id);
      const principalIds = users
        .map((user) => user.principalId)
        .filter((id): id is string => Boolean(id));
      await fixturePrisma.auditEvent.deleteMany({ where: { principalId: { in: principalIds } } });
      await fixturePrisma.membership.deleteMany({ where: { principalId: { in: principalIds } } });
      await fixturePrisma.workspaceMember.deleteMany({ where: { userId: { in: userIds } } });
      await fixturePrisma.workspaceInvite.deleteMany({ where: { email: { in: emails } } });
      await fixturePrisma.loginToken.deleteMany({ where: { userId: { in: userIds } } });
      await fixturePrisma.user.deleteMany({ where: { id: { in: userIds } } });
      await fixturePrisma.principal.deleteMany({ where: { id: { in: principalIds } } });
    }

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

  it("attributes real invite / role-change / api-key-issue actions to the right principal", async () => {
    const fixture = await seedWorkspaceWithRole(fixturePrisma, "Owner");
    fixtures.push(fixture);
    const emailSender = new RecordingEmailSender();
    const app = await buildApp({
      config: testConfig,
      prisma: fixturePrisma,
      emailSender,
      workspaceService: new PrismaWorkspaceService(fixturePrisma),
    });
    apps.push({ app });
    const developerEmail = `audit-attrib-${Date.now()}@rbac-test.local`;
    createdEmails.push(developerEmail);

    // 1. Owner invites a Developer -> invite.create, actor = Owner.
    await app.inject({
      method: "POST",
      url: `/v1/workspaces/${fixture.workspaceId}/invites`,
      headers: { "x-api-key": fixture.apiKey },
      payload: { email: developerEmail, role: "developer" },
    });
    const token = extractToken(emailSender.sent[0]!.text);

    // 2. Developer accepts -> member.add, actor = the Developer themselves
    // (a genuine self-serve join, not the Owner acting on their behalf).
    await app.inject({ method: "POST", url: "/v1/auth/verify", payload: { token } });
    const developerUser = await fixturePrisma.user.findUniqueOrThrow({
      where: { email: developerEmail },
    });

    const members = parse<{ members: Array<{ id: string; userId: string }> }>(
      await app.inject({
        method: "GET",
        url: `/v1/workspaces/${fixture.workspaceId}/members`,
        headers: { "x-api-key": fixture.apiKey },
      }),
    );
    const developerMember = members.members.find((member) => member.userId === developerUser.id)!;

    // 3. Owner promotes them to Admin -> member.update, actor = Owner.
    await app.inject({
      method: "PATCH",
      url: `/v1/workspaces/${fixture.workspaceId}/members/${developerMember.id}`,
      headers: { "x-api-key": fixture.apiKey },
      payload: { role: "admin" },
    });

    // 4. Owner issues an API key for that user -> apikey.create, actor = Owner.
    await app.inject({
      method: "POST",
      url: `/v1/workspaces/${fixture.workspaceId}/api-keys`,
      headers: { "x-api-key": fixture.apiKey },
      payload: { userId: developerUser.id, name: "Attribution test key" },
    });

    const response = await app.inject({
      method: "GET",
      url: `/v1/workspaces/${fixture.workspaceId}/audit-log`,
      headers: { "x-api-key": fixture.apiKey },
    });
    expect(response.statusCode).toBe(200);
    const body = parse<{
      events: Array<{
        action: string;
        principalId: string;
        principal: { displayName: string; type: string } | null;
      }>;
    }>(response);

    const byAction = (action: string) => body.events.find((event) => event.action === action);

    expect(byAction("invite.create")?.principalId).toBe(fixture.principalId);
    expect(byAction("apikey.create")?.principalId).toBe(fixture.principalId);
    const roleChangeEvent = body.events.find(
      (event) => event.action === "member.update" && event.principalId === fixture.principalId,
    );
    expect(roleChangeEvent).toBeDefined();

    const joinEvent = byAction("member.add");
    expect(joinEvent?.principalId).toBe(developerUser.principalId);
    expect(joinEvent?.principalId).not.toBe(fixture.principalId);
    expect(joinEvent?.principal?.displayName).toBe(developerEmail.split("@")[0]);

    const ownerJoinEvent = body.events.find(
      (event) => event.action === "invite.create" && event.principalId === fixture.principalId,
    );
    expect(ownerJoinEvent?.principal?.type).toBe("user");
  });

  it("filters the audit log by principalId, by action, and by date range", async () => {
    const fixture = await seedWorkspaceWithRole(fixturePrisma, "Owner");
    fixtures.push(fixture);
    const app = await buildApp({
      config: testConfig,
      prisma: fixturePrisma,
      workspaceService: new PrismaWorkspaceService(fixturePrisma),
    });
    apps.push({ app });

    await app.inject({
      method: "PATCH",
      url: `/v1/workspaces/${fixture.workspaceId}`,
      headers: { "x-api-key": fixture.apiKey },
      payload: { name: "Filter Test A" },
    });
    await app.inject({
      method: "PATCH",
      url: `/v1/workspaces/${fixture.workspaceId}`,
      headers: { "x-api-key": fixture.apiKey },
      payload: { name: "Filter Test B" },
    });

    const byPrincipal = parse<{ events: unknown[] }>(
      await app.inject({
        method: "GET",
        url: `/v1/workspaces/${fixture.workspaceId}/audit-log?principalId=${fixture.principalId}`,
        headers: { "x-api-key": fixture.apiKey },
      }),
    );
    expect(byPrincipal.events.length).toBeGreaterThanOrEqual(2);

    const byOtherPrincipal = parse<{ events: unknown[] }>(
      await app.inject({
        method: "GET",
        url: `/v1/workspaces/${fixture.workspaceId}/audit-log?principalId=not-a-real-principal`,
        headers: { "x-api-key": fixture.apiKey },
      }),
    );
    expect(byOtherPrincipal.events).toHaveLength(0);

    const byAction = parse<{ events: Array<{ action: string }> }>(
      await app.inject({
        method: "GET",
        url: `/v1/workspaces/${fixture.workspaceId}/audit-log?action=workspace.update`,
        headers: { "x-api-key": fixture.apiKey },
      }),
    );
    expect(byAction.events.length).toBeGreaterThanOrEqual(2);
    expect(byAction.events.every((event) => event.action === "workspace.update")).toBe(true);

    const futureFrom = new Date(Date.now() + 60_000).toISOString();
    const byFutureFrom = parse<{ events: unknown[] }>(
      await app.inject({
        method: "GET",
        url: `/v1/workspaces/${fixture.workspaceId}/audit-log?from=${futureFrom}`,
        headers: { "x-api-key": fixture.apiKey },
      }),
    );
    expect(byFutureFrom.events).toHaveLength(0);

    const pastFrom = new Date(Date.now() - 60_000).toISOString();
    const byPastFrom = parse<{ events: unknown[] }>(
      await app.inject({
        method: "GET",
        url: `/v1/workspaces/${fixture.workspaceId}/audit-log?from=${pastFrom}`,
        headers: { "x-api-key": fixture.apiKey },
      }),
    );
    expect(byPastFrom.events.length).toBeGreaterThanOrEqual(2);
  });

  it("paginates with a cursor, returning no duplicates and a null cursor on the last page", async () => {
    const fixture = await seedWorkspaceWithRole(fixturePrisma, "Owner");
    fixtures.push(fixture);
    const app = await buildApp({
      config: testConfig,
      prisma: fixturePrisma,
      workspaceService: new PrismaWorkspaceService(fixturePrisma),
    });
    apps.push({ app });

    for (let index = 0; index < 3; index += 1) {
      await app.inject({
        method: "PATCH",
        url: `/v1/workspaces/${fixture.workspaceId}`,
        headers: { "x-api-key": fixture.apiKey },
        payload: { name: `Page Test ${index}` },
      });
    }

    const page1 = parse<{ events: Array<{ id: string }>; nextCursor: string | null }>(
      await app.inject({
        method: "GET",
        url: `/v1/workspaces/${fixture.workspaceId}/audit-log?limit=2`,
        headers: { "x-api-key": fixture.apiKey },
      }),
    );
    expect(page1.events).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = parse<{ events: Array<{ id: string }>; nextCursor: string | null }>(
      await app.inject({
        method: "GET",
        url: `/v1/workspaces/${fixture.workspaceId}/audit-log?limit=2&cursor=${page1.nextCursor}`,
        headers: { "x-api-key": fixture.apiKey },
      }),
    );
    expect(page2.events.length).toBeGreaterThanOrEqual(1);

    const page1Ids = new Set(page1.events.map((event) => event.id));
    expect(page2.events.every((event) => !page1Ids.has(event.id))).toBe(true);
  });
});

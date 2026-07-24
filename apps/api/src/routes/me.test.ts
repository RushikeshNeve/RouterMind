import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../app.js";
import type { EmailMessage, EmailSender } from "../infrastructure/email-sender.js";
import { cleanupFixture, seedWorkspaceWithRole, testConfig } from "./workspaces-rbac-fixtures.js";

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

function extractSessionCookie(response: { headers: { "set-cookie"?: string | string[] } }): string {
  const setCookie = response.headers["set-cookie"];
  const cookieHeader = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  if (!cookieHeader) {
    throw new Error("No set-cookie header on response.");
  }
  return cookieHeader.split(";")[0]!;
}

describe("GET /v1/workspaces/:id/me", () => {
  const prisma = new PrismaClient({ datasourceUrl: testConfig.DATABASE_URL });
  const createdEmails: string[] = [];

  afterEach(async () => {
    const emails = createdEmails.splice(0);
    if (emails.length === 0) return;
    const users = await prisma.user.findMany({ where: { email: { in: emails } } });
    const userIds = users.map((user) => user.id);
    const principalIds = users
      .map((user) => user.principalId)
      .filter((id): id is string => Boolean(id));
    await prisma.auditEvent.deleteMany({ where: { principalId: { in: principalIds } } });
    await prisma.membership.deleteMany({ where: { principalId: { in: principalIds } } });
    await prisma.workspaceMember.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.workspaceInvite.deleteMany({ where: { email: { in: emails } } });
    await prisma.loginToken.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.principal.deleteMany({ where: { id: { in: principalIds } } });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("returns the full Owner permission set for an API-key caller", async () => {
    const fixture = await seedWorkspaceWithRole(prisma, "Owner");
    const app = await buildApp({ config: testConfig, prisma });

    const response = await app.inject({
      method: "GET",
      url: `/v1/workspaces/${fixture.workspaceId}/me`,
      headers: { "x-api-key": fixture.apiKey },
    });

    expect(response.statusCode).toBe(200);
    const body = parse<{
      role: { name: string } | null;
      permissions: string[];
      organizationId: string | null;
    }>(response);
    expect(body.role?.name).toBe("Owner");
    expect(body.permissions).toEqual(
      expect.arrayContaining(["workspace.manage", "budget.manage", "audit.read"]),
    );
    expect(body.organizationId).toBe(fixture.organizationId);

    await app.close();
    await cleanupFixture(prisma, fixture);
  });

  it("returns a narrower permission set for a real Developer membership created via the invite-accept flow, distinct from the inviting Owner", async () => {
    const fixture = await seedWorkspaceWithRole(prisma, "Owner");
    const emailSender = new RecordingEmailSender();
    const app = await buildApp({ config: testConfig, prisma, emailSender });
    const developerEmail = `me-developer-${Date.now()}@rbac-test.local`;
    createdEmails.push(developerEmail);

    // Real invite -> real acceptance, exactly like a genuine dashboard user
    // would go through -- not a fixture shortcut.
    await app.inject({
      method: "POST",
      url: `/v1/workspaces/${fixture.workspaceId}/invites`,
      headers: { "x-api-key": fixture.apiKey },
      payload: { email: developerEmail, role: "developer" },
    });
    const token = extractToken(emailSender.sent[0]!.text);
    const verifyResponse = await app.inject({
      method: "POST",
      url: "/v1/auth/verify",
      payload: { token },
    });
    expect(verifyResponse.statusCode).toBe(200);
    const developerSessionCookie = extractSessionCookie(verifyResponse);

    // Two real memberships, same workspace, different roles.
    const ownerMe = await app.inject({
      method: "GET",
      url: `/v1/workspaces/${fixture.workspaceId}/me`,
      headers: { "x-api-key": fixture.apiKey },
    });
    const developerMe = await app.inject({
      method: "GET",
      url: `/v1/workspaces/${fixture.workspaceId}/me`,
      headers: { cookie: developerSessionCookie },
    });

    expect(ownerMe.statusCode).toBe(200);
    expect(developerMe.statusCode).toBe(200);

    const ownerBody = parse<{ role: { name: string } | null; permissions: string[] }>(ownerMe);
    const developerBody = parse<{ role: { name: string } | null; permissions: string[] }>(
      developerMe,
    );

    expect(ownerBody.role?.name).toBe("Owner");
    expect(ownerBody.permissions).toContain("workspace.manage");

    expect(developerBody.role?.name).toBe("Developer");
    expect(developerBody.permissions).toEqual(
      expect.arrayContaining(["analytics.read", "models.use"]),
    );
    // The specific gap this whole slice is about: a Developer must not see
    // workspace.manage in their own effective permission set.
    expect(developerBody.permissions).not.toContain("workspace.manage");
    expect(developerBody.permissions).not.toContain("budget.manage");
    expect(developerBody.permissions.length).toBeLessThan(ownerBody.permissions.length);

    await app.close();
    await cleanupFixture(prisma, fixture);
  });

  it("rejects a request with no API key and no session cookie", async () => {
    const fixture = await seedWorkspaceWithRole(prisma, "Owner");
    const app = await buildApp({ config: testConfig, prisma });

    const response = await app.inject({
      method: "GET",
      url: `/v1/workspaces/${fixture.workspaceId}/me`,
    });

    expect(response.statusCode).toBe(401);

    await app.close();
    await cleanupFixture(prisma, fixture);
  });

  it("rejects a valid session cookie for a workspace the caller isn't a member of", async () => {
    const fixtureA = await seedWorkspaceWithRole(prisma, "Owner");
    const fixtureB = await seedWorkspaceWithRole(prisma, "Owner");
    const app = await buildApp({ config: testConfig, prisma });

    // A valid API key for workspace A used against workspace B's /me.
    const response = await app.inject({
      method: "GET",
      url: `/v1/workspaces/${fixtureB.workspaceId}/me`,
      headers: { "x-api-key": fixtureA.apiKey },
    });

    expect(response.statusCode).toBe(401);

    await app.close();
    await cleanupFixture(prisma, fixtureA);
    await cleanupFixture(prisma, fixtureB);
  });
});

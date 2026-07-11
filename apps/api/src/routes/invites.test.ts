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

describe("workspace invite routes", () => {
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

  it("lets an Owner create an invite, which emails a link and appears in the pending list", async () => {
    const fixture = await seedWorkspaceWithRole(prisma, "Owner");
    const emailSender = new RecordingEmailSender();
    const app = await buildApp({ config: testConfig, prisma, emailSender });
    const email = `invitee-${Date.now()}@rbac-test.local`;
    createdEmails.push(email);

    const response = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${fixture.workspaceId}/invites`,
      headers: { "x-api-key": fixture.apiKey },
      payload: { email, role: "developer" },
    });

    expect(response.statusCode).toBe(201);
    expect(emailSender.sent).toHaveLength(1);
    expect(emailSender.sent[0]?.to).toBe(email);

    const list = await app.inject({
      method: "GET",
      url: `/v1/workspaces/${fixture.workspaceId}/invites`,
      headers: { "x-api-key": fixture.apiKey },
    });
    expect(list.statusCode).toBe(200);
    expect(
      parse<{ invites: Array<{ email: string }> }>(list).invites.map((i) => i.email),
    ).toContain(email);

    await app.close();
    await cleanupFixture(prisma, fixture);
  });

  it("blocks a Developer from creating an invite", async () => {
    const fixture = await seedWorkspaceWithRole(prisma, "Developer");
    const app = await buildApp({ config: testConfig, prisma });
    const email = `nope-${Date.now()}@rbac-test.local`;

    const response = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${fixture.workspaceId}/invites`,
      headers: { "x-api-key": fixture.apiKey },
      payload: { email, role: "developer" },
    });

    expect(response.statusCode).toBe(403);

    await app.close();
    await cleanupFixture(prisma, fixture);
  });

  it("rejects a duplicate pending invite for the same email", async () => {
    const fixture = await seedWorkspaceWithRole(prisma, "Owner");
    const app = await buildApp({ config: testConfig, prisma });
    const email = `dup-${Date.now()}@rbac-test.local`;
    createdEmails.push(email);

    const first = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${fixture.workspaceId}/invites`,
      headers: { "x-api-key": fixture.apiKey },
      payload: { email, role: "viewer" },
    });
    const second = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${fixture.workspaceId}/invites`,
      headers: { "x-api-key": fixture.apiKey },
      payload: { email, role: "viewer" },
    });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(409);

    await app.close();
    await cleanupFixture(prisma, fixture);
  });

  it("rejects inviting an email that is already a member of the workspace", async () => {
    const fixture = await seedWorkspaceWithRole(prisma, "Owner");
    const app = await buildApp({ config: testConfig, prisma });
    const owner = await prisma.user.findUniqueOrThrow({ where: { id: fixture.userId } });

    const response = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${fixture.workspaceId}/invites`,
      headers: { "x-api-key": fixture.apiKey },
      payload: { email: owner.email, role: "admin" },
    });

    expect(response.statusCode).toBe(409);

    await app.close();
    await cleanupFixture(prisma, fixture);
  });

  it("lets an Owner revoke a pending invite; revoking twice 409s and it drops off the pending list", async () => {
    const fixture = await seedWorkspaceWithRole(prisma, "Owner");
    const app = await buildApp({ config: testConfig, prisma });
    const email = `revoke-${Date.now()}@rbac-test.local`;
    createdEmails.push(email);

    const created = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${fixture.workspaceId}/invites`,
      headers: { "x-api-key": fixture.apiKey },
      payload: { email, role: "viewer" },
    });
    const inviteId = parse<{ invite: { id: string } }>(created).invite.id;

    const revoked = await app.inject({
      method: "DELETE",
      url: `/v1/workspaces/${fixture.workspaceId}/invites/${inviteId}`,
      headers: { "x-api-key": fixture.apiKey },
    });
    expect(revoked.statusCode).toBe(200);

    const list = await app.inject({
      method: "GET",
      url: `/v1/workspaces/${fixture.workspaceId}/invites`,
      headers: { "x-api-key": fixture.apiKey },
    });
    expect(parse<{ invites: unknown[] }>(list).invites).toHaveLength(0);

    const secondRevoke = await app.inject({
      method: "DELETE",
      url: `/v1/workspaces/${fixture.workspaceId}/invites/${inviteId}`,
      headers: { "x-api-key": fixture.apiKey },
    });
    expect(secondRevoke.statusCode).toBe(409);

    await app.close();
    await cleanupFixture(prisma, fixture);
  });

  it("accepting an invite for a brand-new email creates the User/Principal, joins the workspace, and returns it for redirect", async () => {
    const fixture = await seedWorkspaceWithRole(prisma, "Owner");
    const emailSender = new RecordingEmailSender();
    const app = await buildApp({ config: testConfig, prisma, emailSender });
    const email = `newmember-${Date.now()}@rbac-test.local`;
    createdEmails.push(email);

    await app.inject({
      method: "POST",
      url: `/v1/workspaces/${fixture.workspaceId}/invites`,
      headers: { "x-api-key": fixture.apiKey },
      payload: { email, role: "developer" },
    });
    const token = extractToken(emailSender.sent[0]!.text);

    const verifyResponse = await app.inject({
      method: "POST",
      url: "/v1/auth/verify",
      payload: { token },
    });

    expect(verifyResponse.statusCode).toBe(200);
    const body = parse<{
      user: { id: string; email: string };
      workspace?: { id: string; name: string };
    }>(verifyResponse);
    expect(body.user.email).toBe(email);
    expect(body.workspace?.id).toBe(fixture.workspaceId);
    expect(extractSessionCookie(verifyResponse)).toContain("routemind_session=");

    const dbUser = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(dbUser.principalId).toBeTruthy();

    const membership = await prisma.membership.findUnique({
      where: {
        workspaceId_principalId: {
          workspaceId: fixture.workspaceId,
          principalId: dbUser.principalId!,
        },
      },
    });
    expect(membership?.role).toBe("developer");

    const workspaceMember = await prisma.workspaceMember.findFirst({
      where: { workspaceId: fixture.workspaceId, userId: dbUser.id },
    });
    expect(workspaceMember?.role).toBe("developer");

    const invites = await prisma.workspaceInvite.findMany({ where: { email } });
    expect(invites[0]?.acceptedAt).not.toBeNull();

    await app.close();
    await cleanupFixture(prisma, fixture);
  });

  it("rejects re-using an accepted, a revoked, and an expired invite token", async () => {
    const fixture = await seedWorkspaceWithRole(prisma, "Owner");
    const emailSender = new RecordingEmailSender();
    const app = await buildApp({ config: testConfig, prisma, emailSender });

    // Accepted-then-reused
    const acceptedEmail = `accepted-${Date.now()}@rbac-test.local`;
    createdEmails.push(acceptedEmail);
    await app.inject({
      method: "POST",
      url: `/v1/workspaces/${fixture.workspaceId}/invites`,
      headers: { "x-api-key": fixture.apiKey },
      payload: { email: acceptedEmail, role: "viewer" },
    });
    const acceptedToken = extractToken(emailSender.sent[emailSender.sent.length - 1]!.text);
    await app.inject({ method: "POST", url: "/v1/auth/verify", payload: { token: acceptedToken } });
    const reuse = await app.inject({
      method: "POST",
      url: "/v1/auth/verify",
      payload: { token: acceptedToken },
    });
    expect(reuse.statusCode).toBe(401);

    // Revoked
    const revokedEmail = `revoked-${Date.now()}@rbac-test.local`;
    createdEmails.push(revokedEmail);
    const revokedCreate = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${fixture.workspaceId}/invites`,
      headers: { "x-api-key": fixture.apiKey },
      payload: { email: revokedEmail, role: "viewer" },
    });
    const revokedToken = extractToken(emailSender.sent[emailSender.sent.length - 1]!.text);
    const revokedInviteId = parse<{ invite: { id: string } }>(revokedCreate).invite.id;
    await app.inject({
      method: "DELETE",
      url: `/v1/workspaces/${fixture.workspaceId}/invites/${revokedInviteId}`,
      headers: { "x-api-key": fixture.apiKey },
    });
    const revokedVerify = await app.inject({
      method: "POST",
      url: "/v1/auth/verify",
      payload: { token: revokedToken },
    });
    expect(revokedVerify.statusCode).toBe(401);

    // Expired
    const expiredEmail = `expired-${Date.now()}@rbac-test.local`;
    createdEmails.push(expiredEmail);
    await app.inject({
      method: "POST",
      url: `/v1/workspaces/${fixture.workspaceId}/invites`,
      headers: { "x-api-key": fixture.apiKey },
      payload: { email: expiredEmail, role: "viewer" },
    });
    const expiredToken = extractToken(emailSender.sent[emailSender.sent.length - 1]!.text);
    await prisma.workspaceInvite.updateMany({
      where: { email: expiredEmail },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const expiredVerify = await app.inject({
      method: "POST",
      url: "/v1/auth/verify",
      payload: { token: expiredToken },
    });
    expect(expiredVerify.statusCode).toBe(401);

    await app.close();
    await cleanupFixture(prisma, fixture);
  });

  it("lets the invited member's session cookie call a workspace.manage route with no API key", async () => {
    const fixture = await seedWorkspaceWithRole(prisma, "Owner");
    const emailSender = new RecordingEmailSender();
    const app = await buildApp({ config: testConfig, prisma, emailSender });
    const email = `session-owner-${Date.now()}@rbac-test.local`;
    createdEmails.push(email);

    // "workspace.manage" is Owner-only per seed-rbac.ts's permission
    // taxonomy (Admin doesn't have it) -- invite as owner so the cookie
    // path actually has the permission this route requires.
    await app.inject({
      method: "POST",
      url: `/v1/workspaces/${fixture.workspaceId}/invites`,
      headers: { "x-api-key": fixture.apiKey },
      payload: { email, role: "owner" },
    });
    const token = extractToken(emailSender.sent[0]!.text);
    const verifyResponse = await app.inject({
      method: "POST",
      url: "/v1/auth/verify",
      payload: { token },
    });
    const sessionCookie = extractSessionCookie(verifyResponse);

    // No x-api-key at all -- only the dashboard's session cookie.
    const response = await app.inject({
      method: "GET",
      url: `/v1/workspaces/${fixture.workspaceId}/invites`,
      headers: { cookie: sessionCookie },
    });

    expect(response.statusCode).toBe(200);

    await app.close();
    await cleanupFixture(prisma, fixture);
  });
});

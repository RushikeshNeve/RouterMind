import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../app.js";
import type { EmailMessage, EmailSender } from "../infrastructure/email-sender.js";
import { verifySessionToken } from "../infrastructure/session.js";
import { testConfig } from "./workspaces-rbac-fixtures.js";

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

describe("magic-link auth routes", () => {
  const prisma = new PrismaClient({ datasourceUrl: testConfig.DATABASE_URL });
  const createdUserIds: string[] = [];
  const createdWorkspaceIds: string[] = [];

  afterEach(async () => {
    const userIds = createdUserIds.splice(0);
    const workspaceIds = createdWorkspaceIds.splice(0);
    await prisma.loginToken.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.membership.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await prisma.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function createUserWithPrincipal(email: string) {
    const principal = await prisma.principal.create({
      data: { type: "user", displayName: email },
    });
    const user = await prisma.user.create({
      data: { name: email, email, principalId: principal.id },
    });
    createdUserIds.push(user.id);
    return user;
  }

  async function createUserWithWorkspace(email: string) {
    const user = await createUserWithPrincipal(email);
    const workspace = await prisma.workspace.create({
      data: { name: "Test Workspace", slug: `test-ws-${user.principalId}` },
    });
    await prisma.membership.create({
      data: { workspaceId: workspace.id, principalId: user.principalId!, role: "owner" },
    });
    createdWorkspaceIds.push(workspace.id);
    return { user, workspace };
  }

  it("sends a login link and returns the same generic message whether or not the email exists", async () => {
    const emailSender = new RecordingEmailSender();
    const app = await buildApp({ config: testConfig, prisma, emailSender });

    const user = await createUserWithPrincipal(`known-${Date.now()}@rbac-test.local`);

    const knownResponse = await app.inject({
      method: "POST",
      url: "/v1/auth/request-link",
      payload: { email: user.email },
    });
    const unknownResponse = await app.inject({
      method: "POST",
      url: "/v1/auth/request-link",
      payload: { email: `unknown-${Date.now()}@rbac-test.local` },
    });

    expect(knownResponse.statusCode).toBe(200);
    expect(unknownResponse.statusCode).toBe(200);
    expect(parse<{ message: string }>(knownResponse).message).toBe(
      parse<{ message: string }>(unknownResponse).message,
    );

    // Both get an email now -- the unknown address gets a self-serve
    // signup link (see the "creates a full account" test below), not just
    // the existing user's login link. Enumeration safety comes from the
    // identical response above, not from withholding the email.
    expect(emailSender.sent).toHaveLength(2);
    expect(emailSender.sent.map((message) => message.to)).toContain(user.email);

    await app.close();
  });

  it("verifies a valid token, sets a session cookie, and marks the token used", async () => {
    const emailSender = new RecordingEmailSender();
    const app = await buildApp({ config: testConfig, prisma, emailSender });
    const { user } = await createUserWithWorkspace(`verify-${Date.now()}@rbac-test.local`);

    await app.inject({
      method: "POST",
      url: "/v1/auth/request-link",
      payload: { email: user.email },
    });
    const token = extractToken(emailSender.sent[0]!.text);

    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/verify",
      payload: { token },
    });

    expect(response.statusCode).toBe(200);
    expect(parse<{ user: { email: string } }>(response).user.email).toBe(user.email);

    const setCookie = response.headers["set-cookie"];
    expect(setCookie).toBeDefined();
    const cookieHeader = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    expect(cookieHeader).toContain("routemind_session=");
    expect(cookieHeader).toContain("HttpOnly");

    const cookieValue = cookieHeader!.split(";")[0]!.split("=").slice(1).join("=");
    const session = verifySessionToken(cookieValue, testConfig.SESSION_SECRET);
    expect(session?.userId).toBe(user.id);
    expect(session?.principalId).toBe(user.principalId);

    const dbToken = await prisma.loginToken.findFirst({ where: { userId: user.id } });
    expect(dbToken?.usedAt).not.toBeNull();

    await app.close();
  });

  it("rejects a token that has already been used", async () => {
    const emailSender = new RecordingEmailSender();
    const app = await buildApp({ config: testConfig, prisma, emailSender });
    const { user } = await createUserWithWorkspace(`reuse-${Date.now()}@rbac-test.local`);

    await app.inject({
      method: "POST",
      url: "/v1/auth/request-link",
      payload: { email: user.email },
    });
    const token = extractToken(emailSender.sent[0]!.text);

    const first = await app.inject({ method: "POST", url: "/v1/auth/verify", payload: { token } });
    const second = await app.inject({ method: "POST", url: "/v1/auth/verify", payload: { token } });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(401);

    await app.close();
  });

  it("rejects an expired token", async () => {
    const emailSender = new RecordingEmailSender();
    const app = await buildApp({ config: testConfig, prisma, emailSender });
    const user = await createUserWithPrincipal(`expired-${Date.now()}@rbac-test.local`);

    await app.inject({
      method: "POST",
      url: "/v1/auth/request-link",
      payload: { email: user.email },
    });
    const token = extractToken(emailSender.sent[0]!.text);

    await prisma.loginToken.updateMany({
      where: { userId: user.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/verify",
      payload: { token },
    });
    expect(response.statusCode).toBe(401);

    await app.close();
  });

  it("rejects an unknown token", async () => {
    const app = await buildApp({ config: testConfig, prisma });

    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/verify",
      payload: { token: "not-a-real-token" },
    });
    expect(response.statusCode).toBe(401);

    await app.close();
  });

  it("rejects an invalid email on request-link", async () => {
    const app = await buildApp({ config: testConfig, prisma });

    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/request-link",
      payload: { email: "not-an-email" },
    });
    expect(response.statusCode).toBe(400);

    await app.close();
  });

  describe("ordinary (non-invite) login lands the user in a workspace", () => {
    it("returns the user's workspace via their Membership on a normal login", async () => {
      const emailSender = new RecordingEmailSender();
      const app = await buildApp({ config: testConfig, prisma, emailSender });
      const { user, workspace } = await createUserWithWorkspace(
        `returning-${Date.now()}@rbac-test.local`,
      );

      await app.inject({
        method: "POST",
        url: "/v1/auth/request-link",
        payload: { email: user.email },
      });
      const token = extractToken(emailSender.sent[0]!.text);

      const response = await app.inject({
        method: "POST",
        url: "/v1/auth/verify",
        payload: { token },
      });

      expect(response.statusCode).toBe(200);
      const body = parse<{
        user: { id: string };
        workspace: { id: string; name: string } | undefined;
      }>(response);
      expect(body.user.id).toBe(user.id);
      expect(body.workspace).toBeDefined();
      expect(body.workspace!.id).toBe(workspace.id);
      expect(body.workspace!.name).toBe(workspace.name);

      await app.close();
    });

    it("returns a clear error instead of a silent null workspace when the user has no Membership", async () => {
      const emailSender = new RecordingEmailSender();
      const app = await buildApp({ config: testConfig, prisma, emailSender });
      const user = await createUserWithPrincipal(`no-membership-${Date.now()}@rbac-test.local`);

      await app.inject({
        method: "POST",
        url: "/v1/auth/request-link",
        payload: { email: user.email },
      });
      const token = extractToken(emailSender.sent[0]!.text);

      const response = await app.inject({
        method: "POST",
        url: "/v1/auth/verify",
        payload: { token },
      });

      expect(response.statusCode).toBe(400);
      expect(parse<{ error: { message: string } }>(response).error.message).toMatch(/membership/i);

      // The token must not be consumed by a failed attempt -- a subsequent
      // retry (e.g. after being added to a workspace) should still work.
      const dbToken = await prisma.loginToken.findFirst({ where: { userId: user.id } });
      expect(dbToken?.usedAt).toBeNull();

      await app.close();
    });
  });

  describe("self-serve signup (first-time verify, no existing User)", () => {
    it("creates User + Principal + Organization + Workspace + Owner Membership on first verify", async () => {
      const emailSender = new RecordingEmailSender();
      const app = await buildApp({ config: testConfig, prisma, emailSender });
      const email = `newcomer-${Date.now()}@rbac-test.local`;

      await app.inject({
        method: "POST",
        url: "/v1/auth/request-link",
        payload: { email },
      });
      const token = extractToken(emailSender.sent[0]!.text);

      const response = await app.inject({
        method: "POST",
        url: "/v1/auth/verify",
        payload: { token },
      });

      expect(response.statusCode).toBe(200);
      const body = parse<{
        user: { id: string; email: string };
        workspace: { id: string; name: string } | undefined;
      }>(response);
      expect(body.user.email).toBe(email);
      expect(body.workspace).toBeDefined();
      createdUserIds.push(body.user.id);

      const user = await prisma.user.findUniqueOrThrow({ where: { id: body.user.id } });
      expect(user.principalId).not.toBeNull();

      const membership = await prisma.membership.findUniqueOrThrow({
        where: {
          workspaceId_principalId: {
            workspaceId: body.workspace!.id,
            principalId: user.principalId!,
          },
        },
      });
      expect(membership.role).toBe("owner");
      expect(membership.roleId).not.toBeNull();

      const workspace = await prisma.workspace.findUniqueOrThrow({
        where: { id: body.workspace!.id },
      });
      expect(workspace.organizationId).not.toBeNull();

      const legacyMember = await prisma.workspaceMember.findFirst({
        where: { workspaceId: body.workspace!.id, userId: user.id },
      });
      expect(legacyMember?.role).toBe("owner");

      const auditEvent = await prisma.auditEvent.findFirst({
        where: { workspaceId: body.workspace!.id, action: "member.add" },
      });
      expect((auditEvent?.metadataJson as { viaSignup?: boolean } | null)?.viaSignup).toBe(true);

      // Reusing the same (now-used) token must fail, same as the existing-user path.
      const reuse = await app.inject({
        method: "POST",
        url: "/v1/auth/verify",
        payload: { token },
      });
      expect(reuse.statusCode).toBe(401);

      await prisma.auditEvent.deleteMany({ where: { workspaceId: workspace.id } });
      await prisma.membership.deleteMany({ where: { workspaceId: workspace.id } });
      await prisma.workspaceMember.deleteMany({ where: { workspaceId: workspace.id } });
      await prisma.workspace.deleteMany({ where: { id: workspace.id } });
      await prisma.organization.deleteMany({ where: { id: workspace.organizationId! } });

      await app.close();
    });

    it("leaves no orphaned Organization/Workspace/User row if a step fails partway through", async () => {
      const emailSender = new RecordingEmailSender();
      const app = await buildApp({ config: testConfig, prisma, emailSender });
      const email = `orphan-check-${Date.now()}@rbac-test.local`;

      await app.inject({
        method: "POST",
        url: "/v1/auth/request-link",
        payload: { email },
      });
      const loginToken = await prisma.loginToken.findFirstOrThrow({ where: { email } });
      const token = extractToken(emailSender.sent[0]!.text);

      // Force a deterministic mid-transaction failure: pre-occupy the exact
      // workspace slug the signup transaction will try to insert next
      // (derived from the LoginToken's own id, predictable before the
      // transaction runs). tx.workspace.create() genuinely violates the
      // slug unique constraint AFTER Principal/User/Organization have
      // already been written in that same transaction, proving a real
      // rollback rather than a controlled early return.
      const blockerOrg = await prisma.organization.create({ data: { name: "Blocker Org" } });
      const blockerWorkspace = await prisma.workspace.create({
        data: {
          name: "Blocker",
          slug: `workspace-${loginToken.id}`,
          organizationId: blockerOrg.id,
        },
      });

      const response = await app.inject({
        method: "POST",
        url: "/v1/auth/verify",
        payload: { token },
      });

      expect(response.statusCode).toBeGreaterThanOrEqual(500);

      const userCount = await prisma.user.count({ where: { email } });
      expect(userCount).toBe(0);

      const displayName = email.split("@")[0]!;
      const orgCount = await prisma.organization.count({
        where: { name: `${displayName}'s Organization` },
      });
      expect(orgCount).toBe(0);

      // The token was never marked used, since the write that would have
      // done so rolled back too -- a retry after fixing the root cause
      // (e.g. seeding the Owner role) remains possible with the same link.
      const refreshedToken = await prisma.loginToken.findUniqueOrThrow({
        where: { id: loginToken.id },
      });
      expect(refreshedToken.usedAt).toBeNull();

      await prisma.workspace.deleteMany({ where: { id: blockerWorkspace.id } });
      await prisma.organization.deleteMany({ where: { id: blockerOrg.id } });
      await prisma.loginToken.deleteMany({ where: { id: loginToken.id } });

      await app.close();
    });
  });
});

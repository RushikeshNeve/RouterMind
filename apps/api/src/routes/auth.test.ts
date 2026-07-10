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

  afterEach(async () => {
    const userIds = createdUserIds.splice(0);
    await prisma.loginToken.deleteMany({ where: { userId: { in: userIds } } });
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

    // Only the real user actually gets an email.
    expect(emailSender.sent).toHaveLength(1);
    expect(emailSender.sent[0]?.to).toBe(user.email);

    await app.close();
  });

  it("verifies a valid token, sets a session cookie, and marks the token used", async () => {
    const emailSender = new RecordingEmailSender();
    const app = await buildApp({ config: testConfig, prisma, emailSender });
    const user = await createUserWithPrincipal(`verify-${Date.now()}@rbac-test.local`);

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
    const user = await createUserWithPrincipal(`reuse-${Date.now()}@rbac-test.local`);

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
});

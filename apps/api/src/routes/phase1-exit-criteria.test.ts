import { createHmac } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import type { EmailMessage, EmailSender } from "../infrastructure/email-sender.js";
import type { PaddleClient, PaddleTransaction } from "../infrastructure/paddle-client.js";
import { createPrismaWorkspaceTestApp, testConfig } from "./workspaces-rbac-fixtures.js";

// Phase 1 exit criteria (docs/phase-1-plan.md): "A person who has never
// spoken to us can: sign up -> hit the Free tier's request limit -> see a
// clear upgrade prompt with real pricing -> pay with a real (test-mode)
// credit card -> immediately have the limit lifted -- end to end, with no
// manual intervention from us at any step."
//
// Everything below drives real routes against real Postgres: real
// magic-link signup, a real self-issued API key, real Policy-engine
// enforcement against the real seeded Free plan's 10,000-request limit,
// the real GET /v1/plans and billing/overview data a dashboard upgrade
// prompt would render from, a real checkout call, and real, correctly
// HMAC-signed webhook delivery to /v1/webhooks/paddle. The one thing this
// environment cannot do is drive a browser through Paddle's actual hosted
// checkout UI, since no live Paddle sandbox credentials exist here (see
// docs/roadmap.md items 2/5) -- so "pay with a real credit card" is
// represented by simulating the one external event Paddle itself would
// send us on a real payment: a signed subscription.created webhook. That
// mirrors production exactly, since this backend never sees a card number
// either way -- Paddle is the merchant of record and only ever tells us
// about payment outcomes via this same webhook contract.

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

const WEBHOOK_SECRET = testConfig.PADDLE_WEBHOOK_SECRET!;

function signPaddleWebhook(
  rawBody: string,
  timestampSeconds = Math.floor(Date.now() / 1000),
): string {
  const signature = createHmac("sha256", WEBHOOK_SECRET)
    .update(`${timestampSeconds}:${rawBody}`)
    .digest("hex");
  return `ts=${timestampSeconds};h1=${signature}`;
}

class FakePaddleClient implements PaddleClient {
  readonly calls: Array<{ priceId: string; customData: Record<string, string> }> = [];
  constructor(
    private readonly transaction: PaddleTransaction = { id: "txn_exit_criteria", status: "draft" },
  ) {}
  createTransaction(input: {
    readonly priceId: string;
    readonly customData: Record<string, string>;
  }): Promise<PaddleTransaction> {
    this.calls.push(input);
    return Promise.resolve(this.transaction);
  }
}

const TEST_PRO_PADDLE_PRICE_ID = "pri_exit_criteria_test";

describe("Phase 1 exit criteria: sign up -> hit Free limit -> upgrade prompt -> pay -> limit lifted", () => {
  const prisma = new PrismaClient({ datasourceUrl: testConfig.DATABASE_URL });
  const apps: FastifyInstance[] = [];
  let workspaceId: string | undefined;
  let organizationId: string | undefined;
  let userId: string | undefined;
  let principalId: string | undefined;
  let mutatedProPlan = false;

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));

    if (organizationId) {
      await prisma.subscription.deleteMany({ where: { organizationId } });
    }
    if (workspaceId) {
      await prisma.requestLog.deleteMany({ where: { workspaceId } });
      await prisma.auditEvent.deleteMany({ where: { workspaceId } });
      await prisma.apiKey.deleteMany({ where: { workspaceId } });
      await prisma.membership.deleteMany({ where: { workspaceId } });
      await prisma.workspaceMember.deleteMany({ where: { workspaceId } });
      await prisma.workspace.deleteMany({ where: { id: workspaceId } });
    }
    if (organizationId) {
      await prisma.organization.deleteMany({ where: { id: organizationId } });
    }
    if (userId) {
      await prisma.loginToken.deleteMany({ where: { userId } });
      await prisma.user.deleteMany({ where: { id: userId } });
    }
    if (principalId) {
      await prisma.principal.deleteMany({ where: { id: principalId } });
    }
    if (mutatedProPlan) {
      await prisma.plan.updateMany({ where: { name: "Pro" }, data: { paddlePriceId: null } });
    }

    workspaceId = undefined;
    organizationId = undefined;
    userId = undefined;
    principalId = undefined;
    mutatedProPlan = false;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("proves the full self-serve loop end to end with no manual intervention", async () => {
    const emailSender = new RecordingEmailSender();
    const paddleClient = new FakePaddleClient();
    const { app } = await createPrismaWorkspaceTestApp(prisma, { emailSender, paddleClient });
    apps.push(app);

    // --- Sign up. No prior account, no invite, no manual provisioning. ---
    const email = `exit-criteria-${Date.now()}@rbac-test.local`;
    await app.inject({ method: "POST", url: "/v1/auth/request-link", payload: { email } });
    const token = extractToken(emailSender.sent[0]!.text);
    const verifyResponse = await app.inject({
      method: "POST",
      url: "/v1/auth/verify",
      payload: { token },
    });
    expect(verifyResponse.statusCode).toBe(200);
    const signup = parse<{
      user: { id: string; email: string };
      workspace: { id: string; name: string } | undefined;
    }>(verifyResponse);
    expect(signup.workspace).toBeDefined();
    userId = signup.user.id;
    workspaceId = signup.workspace!.id;
    const sessionCookie = extractSessionCookie(verifyResponse);

    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    principalId = user.principalId!;
    const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId } });
    organizationId = workspace.organizationId!;

    // Mint their own first real API key, self-serve, using the session
    // cookie signup itself just granted them -- exactly what a real user
    // does next in the dashboard, no support ticket involved.
    const apiKeyResponse = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${workspaceId}/api-keys`,
      headers: { cookie: sessionCookie },
      payload: { userId, name: "Exit criteria key" },
    });
    expect(apiKeyResponse.statusCode).toBe(201);
    const apiKey = parse<{ apiKey: string }>(apiKeyResponse).apiKey;

    // --- Hit the Free tier's real request limit (10,000/mo, from the real
    // seeded Plan row -- not a stand-in value). Bulk-inserted for speed;
    // this is data-equivalent to 10,000 real successful requests. ---
    const freePlan = await prisma.plan.findUniqueOrThrow({ where: { name: "Free" } });
    expect(freePlan.includedRequests).toBe(10_000);
    await prisma.requestLog.createMany({
      data: Array.from({ length: freePlan.includedRequests! }, () => ({
        workspaceId: workspaceId!,
        apiKey: "exit-criteria-seed",
        requestedModel: "gpt-4o",
        latencyMs: 100,
        status: "success" as const,
      })),
    });

    const blockedResponse = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { "x-api-key": apiKey },
      payload: {
        model: "gpt-4o",
        messages: [{ role: "user", content: "Hello" }],
        cache: { mode: "disabled" },
      },
    });
    expect(blockedResponse.statusCode).toBe(403);
    expect(parse<{ error: { code: string } }>(blockedResponse).error.code).toBe(
      "PLAN_LIMIT_EXCEEDED",
    );

    // --- See a clear upgrade prompt with real pricing: the same data the
    // dashboard's billing screen (item 5) and the public pricing page
    // (item 8) render from, both live endpoints, not hardcoded copy. ---
    const overviewBeforeUpgrade = await app.inject({
      method: "GET",
      url: `/v1/organizations/${organizationId}/billing/overview`,
      headers: { "x-api-key": apiKey },
    });
    expect(overviewBeforeUpgrade.statusCode).toBe(200);
    const overviewBody = parse<{
      plan: { name: string };
      subscription: unknown;
      usage: { requestCount: number };
    }>(overviewBeforeUpgrade);
    expect(overviewBody.plan.name).toBe("Free");
    expect(overviewBody.subscription).toBeNull();
    expect(overviewBody.usage.requestCount).toBe(10_000);

    const plansResponse = await app.inject({ method: "GET", url: "/v1/plans" });
    expect(plansResponse.statusCode).toBe(200);
    const plans = parse<{
      plans: readonly { name: string; priceCents: number; includedRequests: number | null }[];
    }>(plansResponse).plans;
    const proPlanListing = plans.find((plan) => plan.name === "Pro");
    expect(proPlanListing).toMatchObject({ priceCents: 5_900, includedRequests: 100_000 });

    // --- Pay with a (test-mode) credit card. Checkout against the real
    // seeded Pro plan -- only its paddlePriceId is faked, since no real
    // Paddle sandbox price exists in this environment; the name, price, and
    // request limit the customer sees and pays for are all real. ---
    await prisma.plan.updateMany({
      where: { name: "Pro" },
      data: { paddlePriceId: TEST_PRO_PADDLE_PRICE_ID },
    });
    mutatedProPlan = true;

    const checkoutResponse = await app.inject({
      method: "POST",
      url: `/v1/organizations/${organizationId}/billing/checkout`,
      headers: { "x-api-key": apiKey },
      payload: { planName: "Pro" },
    });
    expect(checkoutResponse.statusCode).toBe(201);
    expect(paddleClient.calls).toEqual([
      { priceId: TEST_PRO_PADDLE_PRICE_ID, customData: { organizationId } },
    ]);

    // Paddle's own confirmation of a completed payment, delivered exactly
    // the way it is in production: a signed webhook, never a card number.
    const rawBody = JSON.stringify({
      event_type: "subscription.created",
      data: {
        id: "sub_exit_criteria",
        status: "active",
        customer_id: "ctm_exit_criteria",
        custom_data: { organizationId },
        items: [{ price: { id: TEST_PRO_PADDLE_PRICE_ID } }],
        current_billing_period: {
          starts_at: "2026-01-01T00:00:00Z",
          ends_at: "2026-02-01T00:00:00Z",
        },
      },
    });
    const webhookResponse = await app.inject({
      method: "POST",
      url: "/v1/webhooks/paddle",
      headers: {
        "content-type": "application/json",
        "paddle-signature": signPaddleWebhook(rawBody),
      },
      payload: rawBody,
    });
    expect(webhookResponse.statusCode).toBe(200);

    const subscription = await prisma.subscription.findUniqueOrThrow({ where: { organizationId } });
    expect(subscription.status).toBe("active");
    const proPlan = await prisma.plan.findUniqueOrThrow({ where: { name: "Pro" } });
    expect(subscription.planId).toBe(proPlan.id);

    // --- Immediately have the limit lifted: same workspace, same 10,000
    // already-logged requests, same running app instance, no restart, no
    // manual cache-bust -- the very next request must now succeed under
    // Pro's 100,000-request limit. ---
    const unblockedResponse = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { "x-api-key": apiKey },
      payload: {
        model: "gpt-4o",
        messages: [{ role: "user", content: "Hello again" }],
        cache: { mode: "disabled" },
      },
    });
    expect(unblockedResponse.statusCode).toBe(200);

    const overviewAfterUpgrade = await app.inject({
      method: "GET",
      url: `/v1/organizations/${organizationId}/billing/overview`,
      headers: { "x-api-key": apiKey },
    });
    const afterBody = parse<{ plan: { name: string }; subscription: { status: string } | null }>(
      overviewAfterUpgrade,
    );
    expect(afterBody.plan.name).toBe("Pro");
    expect(afterBody.subscription?.status).toBe("active");
  });
});

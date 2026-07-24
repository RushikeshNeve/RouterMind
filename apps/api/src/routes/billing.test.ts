import { createHmac, randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import type { PaddleClient, PaddleTransaction } from "../infrastructure/paddle-client.js";
import {
  cleanupFixture,
  createPrismaWorkspaceTestApp,
  seedWorkspaceWithRole,
  testConfig,
  type WorkspaceRoleFixture,
} from "./workspaces-rbac-fixtures.js";

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
    private readonly transaction: PaddleTransaction = { id: "txn_fake", status: "draft" },
  ) {}
  createTransaction(input: {
    readonly priceId: string;
    readonly customData: Record<string, string>;
  }): Promise<PaddleTransaction> {
    this.calls.push(input);
    return Promise.resolve(this.transaction);
  }
}

describe("billing routes", () => {
  const apps: FastifyInstance[] = [];
  const prisma = new PrismaClient({ datasourceUrl: testConfig.DATABASE_URL });
  const fixtures: WorkspaceRoleFixture[] = [];
  const planIds: string[] = [];
  const requestLogIds: string[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
    await prisma.requestLog.deleteMany({ where: { id: { in: requestLogIds.splice(0) } } });
    await prisma.subscription.deleteMany({
      where: { organizationId: { in: fixtures.map((f) => f.organizationId) } },
    });
    await Promise.all(fixtures.splice(0).map((fixture) => cleanupFixture(prisma, fixture)));
    await prisma.plan.deleteMany({ where: { id: { in: planIds.splice(0) } } });
  });

  async function seedRequestLog(
    workspaceId: string,
    input: {
      status: "success" | "failed";
      inputTokens?: number;
      outputTokens?: number;
      createdAt?: Date;
    },
  ): Promise<void> {
    const row = await prisma.requestLog.create({
      data: {
        workspaceId,
        apiKey: "test-key-hash",
        requestedModel: "gpt-4o",
        latencyMs: 100,
        status: input.status,
        inputTokens: input.inputTokens,
        outputTokens: input.outputTokens,
        ...(input.createdAt ? { createdAt: input.createdAt } : {}),
      },
    });
    requestLogIds.push(row.id);
  }

  async function seedPlan(paddlePriceId: string | null): Promise<{ id: string; name: string }> {
    const plan = await prisma.plan.create({
      data: {
        name: `Billing Test Plan ${randomUUID()}`,
        priceCents: 5_900,
        includedRequests: 100_000,
        featuresJson: {},
        paddlePriceId,
      },
    });
    planIds.push(plan.id);
    return plan;
  }

  async function billingTestApp(
    paddleClient: PaddleClient = new FakePaddleClient(),
  ): Promise<FastifyInstance> {
    const { app } = await createPrismaWorkspaceTestApp(prisma, { paddleClient });
    apps.push(app);
    return app;
  }

  describe("POST /v1/organizations/:organizationId/billing/checkout", () => {
    it("creates a Paddle transaction and audits it when caller is Owner", async () => {
      const fixture = await seedWorkspaceWithRole(prisma, "Owner");
      fixtures.push(fixture);
      const plan = await seedPlan("pri_test123");
      const paddleClient = new FakePaddleClient({ id: "txn_abc123", status: "draft" });
      const app = await billingTestApp(paddleClient);

      const response = await app.inject({
        method: "POST",
        url: `/v1/organizations/${fixture.organizationId}/billing/checkout`,
        headers: { "x-api-key": fixture.apiKey },
        payload: { planName: plan.name },
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.payload) as {
        transactionId: string;
        clientToken?: string;
        environment: string;
      };
      expect(body.transactionId).toBe("txn_abc123");
      expect(body.environment).toBe("sandbox");
      expect(paddleClient.calls).toEqual([
        { priceId: "pri_test123", customData: { organizationId: fixture.organizationId } },
      ]);

      const auditEvents = await prisma.auditEvent.findMany({
        where: { workspaceId: fixture.workspaceId, action: "billing.checkout_initiated" },
      });
      expect(auditEvents).toHaveLength(1);
      expect(auditEvents[0]!.targetId).toBe("txn_abc123");
      expect(auditEvents[0]!.principalId).toBe(fixture.principalId);
    });

    it("rejects with 403 when caller lacks billing.manage (Developer)", async () => {
      const fixture = await seedWorkspaceWithRole(prisma, "Developer");
      fixtures.push(fixture);
      const plan = await seedPlan("pri_test123");
      const paddleClient = new FakePaddleClient();
      const app = await billingTestApp(paddleClient);

      const response = await app.inject({
        method: "POST",
        url: `/v1/organizations/${fixture.organizationId}/billing/checkout`,
        headers: { "x-api-key": fixture.apiKey },
        payload: { planName: plan.name },
      });

      expect(response.statusCode).toBe(403);
      expect(paddleClient.calls).toHaveLength(0);
    });

    it("rejects a caller from a different organization", async () => {
      const fixtureA = await seedWorkspaceWithRole(prisma, "Owner");
      const fixtureB = await seedWorkspaceWithRole(prisma, "Owner");
      fixtures.push(fixtureA, fixtureB);
      const plan = await seedPlan("pri_test123");
      const paddleClient = new FakePaddleClient();
      const app = await billingTestApp(paddleClient);

      const response = await app.inject({
        method: "POST",
        url: `/v1/organizations/${fixtureB.organizationId}/billing/checkout`,
        headers: { "x-api-key": fixtureA.apiKey },
        payload: { planName: plan.name },
      });

      expect(response.statusCode).toBe(403);
      expect(paddleClient.calls).toHaveLength(0);
    });

    it("returns 404 for an unknown plan", async () => {
      const fixture = await seedWorkspaceWithRole(prisma, "Owner");
      fixtures.push(fixture);
      const app = await billingTestApp();

      const response = await app.inject({
        method: "POST",
        url: `/v1/organizations/${fixture.organizationId}/billing/checkout`,
        headers: { "x-api-key": fixture.apiKey },
        payload: { planName: "Definitely Not A Real Plan" },
      });

      expect(response.statusCode).toBe(404);
    });

    it("returns 400 for a plan with no paddlePriceId (e.g. Free/Enterprise)", async () => {
      const fixture = await seedWorkspaceWithRole(prisma, "Owner");
      fixtures.push(fixture);
      const plan = await seedPlan(null);
      const app = await billingTestApp();

      const response = await app.inject({
        method: "POST",
        url: `/v1/organizations/${fixture.organizationId}/billing/checkout`,
        headers: { "x-api-key": fixture.apiKey },
        payload: { planName: plan.name },
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe("GET /v1/organizations/:organizationId/billing/usage-summary", () => {
    it("counts only successful requests within the given period, for this org only", async () => {
      const fixture = await seedWorkspaceWithRole(prisma, "Owner");
      fixtures.push(fixture);
      const otherFixture = await seedWorkspaceWithRole(prisma, "Owner");
      fixtures.push(otherFixture);
      const app = await billingTestApp();

      const insidePeriod = new Date("2026-03-15T00:00:00Z");
      const outsidePeriod = new Date("2026-04-15T00:00:00Z");
      await seedRequestLog(fixture.workspaceId, {
        status: "success",
        inputTokens: 100,
        outputTokens: 50,
        createdAt: insidePeriod,
      });
      await seedRequestLog(fixture.workspaceId, {
        status: "success",
        inputTokens: 10,
        outputTokens: 5,
        createdAt: insidePeriod,
      });
      await seedRequestLog(fixture.workspaceId, {
        status: "failed",
        inputTokens: 1000,
        outputTokens: 1000,
        createdAt: insidePeriod,
      });
      await seedRequestLog(fixture.workspaceId, {
        status: "success",
        inputTokens: 999,
        outputTokens: 999,
        createdAt: outsidePeriod,
      });
      await seedRequestLog(otherFixture.workspaceId, {
        status: "success",
        inputTokens: 999,
        outputTokens: 999,
        createdAt: insidePeriod,
      });

      const response = await app.inject({
        method: "GET",
        url:
          `/v1/organizations/${fixture.organizationId}/billing/usage-summary` +
          `?periodStart=2026-03-01T00:00:00.000Z&periodEnd=2026-04-01T00:00:00.000Z`,
        headers: { "x-api-key": fixture.apiKey },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload) as {
        organizationId: string;
        requestCount: number;
        tokenCount: number;
      };
      expect(body.organizationId).toBe(fixture.organizationId);
      expect(body.requestCount).toBe(2);
      expect(body.tokenCount).toBe(100 + 50 + 10 + 5);
    });

    it("defaults to the current calendar month when no period is given and no Subscription exists", async () => {
      const fixture = await seedWorkspaceWithRole(prisma, "Owner");
      fixtures.push(fixture);
      const app = await billingTestApp();
      await seedRequestLog(fixture.workspaceId, {
        status: "success",
        inputTokens: 7,
        outputTokens: 3,
      });

      const response = await app.inject({
        method: "GET",
        url: `/v1/organizations/${fixture.organizationId}/billing/usage-summary`,
        headers: { "x-api-key": fixture.apiKey },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload) as { requestCount: number; tokenCount: number };
      expect(body.requestCount).toBe(1);
      expect(body.tokenCount).toBe(10);
    });

    it("rejects with 403 when caller lacks billing.read (Viewer)", async () => {
      const fixture = await seedWorkspaceWithRole(prisma, "Viewer");
      fixtures.push(fixture);
      const app = await billingTestApp();

      const response = await app.inject({
        method: "GET",
        url: `/v1/organizations/${fixture.organizationId}/billing/usage-summary`,
        headers: { "x-api-key": fixture.apiKey },
      });

      expect(response.statusCode).toBe(403);
    });

    it("allows Admin (billing.read)", async () => {
      const fixture = await seedWorkspaceWithRole(prisma, "Admin");
      fixtures.push(fixture);
      const app = await billingTestApp();

      const response = await app.inject({
        method: "GET",
        url: `/v1/organizations/${fixture.organizationId}/billing/usage-summary`,
        headers: { "x-api-key": fixture.apiKey },
      });

      expect(response.statusCode).toBe(200);
    });

    it("rejects a caller from a different organization", async () => {
      const fixtureA = await seedWorkspaceWithRole(prisma, "Owner");
      const fixtureB = await seedWorkspaceWithRole(prisma, "Owner");
      fixtures.push(fixtureA, fixtureB);
      const app = await billingTestApp();

      const response = await app.inject({
        method: "GET",
        url: `/v1/organizations/${fixtureB.organizationId}/billing/usage-summary`,
        headers: { "x-api-key": fixtureA.apiKey },
      });

      expect(response.statusCode).toBe(403);
    });
  });

  describe("GET /v1/organizations/:organizationId/billing/overview", () => {
    it("returns the Free plan and zeroed usage when the org has no Subscription row", async () => {
      await prisma.plan.upsert({
        where: { name: "Free" },
        create: { name: "Free", priceCents: 0, includedRequests: 10_000, featuresJson: {} },
        update: {},
      });
      const fixture = await seedWorkspaceWithRole(prisma, "Owner");
      fixtures.push(fixture);
      const app = await billingTestApp();

      const response = await app.inject({
        method: "GET",
        url: `/v1/organizations/${fixture.organizationId}/billing/overview`,
        headers: { "x-api-key": fixture.apiKey },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload) as {
        plan: { name: string; selfServe: boolean };
        subscription: unknown;
        usage: { requestCount: number };
      };
      expect(body.plan.name).toBe("Free");
      expect(body.plan.selfServe).toBe(false);
      expect(body.subscription).toBeNull();
      expect(body.usage.requestCount).toBe(0);
    });

    it("returns the org's actual plan and subscription status when one exists", async () => {
      const fixture = await seedWorkspaceWithRole(prisma, "Owner");
      fixtures.push(fixture);
      const plan = await seedPlan("pri_overview_test");
      await prisma.subscription.create({
        data: { organizationId: fixture.organizationId, planId: plan.id, status: "active" },
      });
      const app = await billingTestApp();

      const response = await app.inject({
        method: "GET",
        url: `/v1/organizations/${fixture.organizationId}/billing/overview`,
        headers: { "x-api-key": fixture.apiKey },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload) as {
        plan: { name: string; selfServe: boolean };
        subscription: { status: string } | null;
      };
      expect(body.plan.name).toBe(plan.name);
      expect(body.plan.selfServe).toBe(true);
      expect(body.subscription?.status).toBe("active");
    });

    it("rejects with 403 when caller lacks billing.read (Viewer)", async () => {
      const fixture = await seedWorkspaceWithRole(prisma, "Viewer");
      fixtures.push(fixture);
      const app = await billingTestApp();

      const response = await app.inject({
        method: "GET",
        url: `/v1/organizations/${fixture.organizationId}/billing/overview`,
        headers: { "x-api-key": fixture.apiKey },
      });

      expect(response.statusCode).toBe(403);
    });
  });

  describe("POST /v1/webhooks/paddle", () => {
    it("rejects a request with an invalid signature", async () => {
      const app = await billingTestApp();
      const rawBody = JSON.stringify({
        event_type: "subscription.created",
        data: { id: "sub_1", status: "active" },
      });

      const response = await app.inject({
        method: "POST",
        url: "/v1/webhooks/paddle",
        headers: { "content-type": "application/json", "paddle-signature": "ts=1;h1=deadbeef" },
        payload: rawBody,
      });

      expect(response.statusCode).toBe(401);
    });

    it("creates a Subscription row on subscription.created", async () => {
      const fixture = await seedWorkspaceWithRole(prisma, "Owner");
      fixtures.push(fixture);
      const plan = await seedPlan("pri_created_test");
      const app = await billingTestApp();

      const rawBody = JSON.stringify({
        event_type: "subscription.created",
        data: {
          id: "sub_created_1",
          status: "active",
          customer_id: "ctm_1",
          custom_data: { organizationId: fixture.organizationId },
          items: [{ price: { id: "pri_created_test" } }],
          current_billing_period: {
            starts_at: "2026-01-01T00:00:00Z",
            ends_at: "2026-02-01T00:00:00Z",
          },
        },
      });
      const response = await app.inject({
        method: "POST",
        url: "/v1/webhooks/paddle",
        headers: {
          "content-type": "application/json",
          "paddle-signature": signPaddleWebhook(rawBody),
        },
        payload: rawBody,
      });

      expect(response.statusCode).toBe(200);
      const subscription = await prisma.subscription.findUniqueOrThrow({
        where: { organizationId: fixture.organizationId },
      });
      expect(subscription.planId).toBe(plan.id);
      expect(subscription.status).toBe("active");
      expect(subscription.paddleSubscriptionId).toBe("sub_created_1");
      expect(subscription.paddleCustomerId).toBe("ctm_1");
      expect(subscription.currentPeriodStart?.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    });

    it("updates the existing row on subscription.updated", async () => {
      const fixture = await seedWorkspaceWithRole(prisma, "Owner");
      fixtures.push(fixture);
      const plan = await seedPlan("pri_updated_test");
      const app = await billingTestApp();

      await prisma.subscription.create({
        data: {
          organizationId: fixture.organizationId,
          planId: plan.id,
          status: "active",
          paddleSubscriptionId: "sub_updated_1",
          paddleCustomerId: "ctm_1",
        },
      });

      const rawBody = JSON.stringify({
        event_type: "subscription.updated",
        data: {
          id: "sub_updated_1",
          status: "past_due",
          customer_id: "ctm_1",
          items: [{ price: { id: "pri_updated_test" } }],
        },
      });
      const response = await app.inject({
        method: "POST",
        url: "/v1/webhooks/paddle",
        headers: {
          "content-type": "application/json",
          "paddle-signature": signPaddleWebhook(rawBody),
        },
        payload: rawBody,
      });

      expect(response.statusCode).toBe(200);
      const subscription = await prisma.subscription.findUniqueOrThrow({
        where: { organizationId: fixture.organizationId },
      });
      expect(subscription.status).toBe("past_due");
    });

    it("sets status from the payload on subscription.canceled", async () => {
      const fixture = await seedWorkspaceWithRole(prisma, "Owner");
      fixtures.push(fixture);
      const plan = await seedPlan("pri_canceled_test");
      const app = await billingTestApp();

      await prisma.subscription.create({
        data: {
          organizationId: fixture.organizationId,
          planId: plan.id,
          status: "active",
          paddleSubscriptionId: "sub_canceled_1",
        },
      });

      const rawBody = JSON.stringify({
        event_type: "subscription.canceled",
        data: { id: "sub_canceled_1", status: "canceled" },
      });
      const response = await app.inject({
        method: "POST",
        url: "/v1/webhooks/paddle",
        headers: {
          "content-type": "application/json",
          "paddle-signature": signPaddleWebhook(rawBody),
        },
        payload: rawBody,
      });

      expect(response.statusCode).toBe(200);
      const subscription = await prisma.subscription.findUniqueOrThrow({
        where: { organizationId: fixture.organizationId },
      });
      expect(subscription.status).toBe("canceled");
    });

    it("acknowledges but ignores an unrecognized event type", async () => {
      const app = await billingTestApp();
      const rawBody = JSON.stringify({
        event_type: "some.other.event",
        data: { id: "x", status: "n/a" },
      });

      const response = await app.inject({
        method: "POST",
        url: "/v1/webhooks/paddle",
        headers: {
          "content-type": "application/json",
          "paddle-signature": signPaddleWebhook(rawBody),
        },
        payload: rawBody,
      });

      expect(response.statusCode).toBe(200);
    });
  });
});

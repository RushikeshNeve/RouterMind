import { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../app.js";
import type { ModelDiscoveryClient } from "../infrastructure/model-discovery-client.js";
import { encryptCredential } from "../security/credentials.js";
import {
  cleanupFixture,
  createPrismaWorkspaceTestApp,
  seedWorkspaceWithRole,
  testConfig,
  type WorkspaceRoleFixture,
} from "./workspaces-rbac-fixtures.js";

describe("model discovery routes", () => {
  const prisma = new PrismaClient({ datasourceUrl: testConfig.DATABASE_URL });
  const apps: FastifyInstance[] = [];
  const fixtures: WorkspaceRoleFixture[] = [];
  const credentialIds: string[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
    await prisma.providerCredential.deleteMany({ where: { id: { in: credentialIds.splice(0) } } });
    const workspaceIds = fixtures.map((fixture) => fixture.workspaceId);
    await prisma.modelCatalog.deleteMany({ where: {} }); // platform-level, not workspace-scoped
    await prisma.auditEvent.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await Promise.all(fixtures.splice(0).map((fixture) => cleanupFixture(prisma, fixture)));
  });

  describe("POST /v1/workspaces/:workspaceId/models/discover (mock mode)", () => {
    it("upserts ModelCatalog rows from the static registry and audits, for Owner", async () => {
      const fixture = await seedWorkspaceWithRole(prisma, "Owner");
      fixtures.push(fixture);
      const { app } = await createPrismaWorkspaceTestApp(prisma);
      apps.push(app);

      const response = await app.inject({
        method: "POST",
        url: `/v1/workspaces/${fixture.workspaceId}/models/discover`,
        headers: { "x-api-key": fixture.apiKey },
        payload: { provider: "gemini" },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload) as {
        provider: string;
        discovered: string[];
        count: number;
      };
      expect(body.provider).toBe("gemini");
      expect(body.discovered).toEqual(
        expect.arrayContaining(["gemini-1.5-flash", "gemini-1.5-pro"]),
      );

      const catalogRows = await prisma.modelCatalog.findMany({ where: { provider: "gemini" } });
      const flashRow = catalogRows.find((row) => row.model === "gemini-1.5-flash");
      expect(flashRow).toBeDefined();
      expect(flashRow?.capabilitiesJson).toMatchObject({ supportsCode: true, costTier: "low" });

      const auditEvents = await prisma.auditEvent.findMany({
        where: { workspaceId: fixture.workspaceId, action: "models.discover" },
      });
      expect(auditEvents).toHaveLength(1);
      expect(auditEvents[0]!.targetId).toBe("gemini");
    });

    it("is idempotent -- running discovery twice does not create duplicate rows", async () => {
      const fixture = await seedWorkspaceWithRole(prisma, "Owner");
      fixtures.push(fixture);
      const { app } = await createPrismaWorkspaceTestApp(prisma);
      apps.push(app);

      await app.inject({
        method: "POST",
        url: `/v1/workspaces/${fixture.workspaceId}/models/discover`,
        headers: { "x-api-key": fixture.apiKey },
        payload: { provider: "groq" },
      });
      await app.inject({
        method: "POST",
        url: `/v1/workspaces/${fixture.workspaceId}/models/discover`,
        headers: { "x-api-key": fixture.apiKey },
        payload: { provider: "groq" },
      });

      const catalogRows = await prisma.modelCatalog.findMany({ where: { provider: "groq" } });
      const uniqueModels = new Set(catalogRows.map((row) => row.model));
      expect(catalogRows.length).toBe(uniqueModels.size);
    });

    it("rejects with 403 when caller lacks models.manage (Viewer)", async () => {
      const fixture = await seedWorkspaceWithRole(prisma, "Viewer");
      fixtures.push(fixture);
      const { app } = await createPrismaWorkspaceTestApp(prisma);
      apps.push(app);

      const response = await app.inject({
        method: "POST",
        url: `/v1/workspaces/${fixture.workspaceId}/models/discover`,
        headers: { "x-api-key": fixture.apiKey },
        payload: { provider: "openai" },
      });

      expect(response.statusCode).toBe(403);
    });

    it("rejects a caller acting on a workspace they don't belong to", async () => {
      const fixtureA = await seedWorkspaceWithRole(prisma, "Owner");
      const fixtureB = await seedWorkspaceWithRole(prisma, "Owner");
      fixtures.push(fixtureA, fixtureB);
      const { app } = await createPrismaWorkspaceTestApp(prisma);
      apps.push(app);

      const response = await app.inject({
        method: "POST",
        url: `/v1/workspaces/${fixtureB.workspaceId}/models/discover`,
        headers: { "x-api-key": fixtureA.apiKey },
        payload: { provider: "openai" },
      });

      expect(response.statusCode).toBe(403);
    });
  });

  describe("POST /v1/workspaces/:workspaceId/models/discover (live mode)", () => {
    it("decrypts the workspace's stored credential and calls the injected discovery client", async () => {
      const fixture = await seedWorkspaceWithRole(prisma, "Owner");
      fixtures.push(fixture);
      const credential = await prisma.providerCredential.create({
        data: {
          userId: fixture.userId,
          workspaceId: fixture.workspaceId,
          provider: "openai",
          encryptedApiKey: encryptCredential(
            "sk-test-real-key",
            testConfig.CREDENTIAL_ENCRYPTION_KEY,
          ),
          isEnabled: true,
        },
      });
      credentialIds.push(credential.id);

      const calls: Array<{ provider: string; apiKey: string }> = [];
      const fakeDiscoveryClient: ModelDiscoveryClient = {
        listModels: (provider, apiKey) => {
          calls.push({ provider, apiKey });
          return Promise.resolve(["live-discovered-model-1", "live-discovered-model-2"]);
        },
      };
      const { app } = await createPrismaWorkspaceTestApp(prisma);
      apps.push(app);
      // createPrismaWorkspaceTestApp always uses testConfig (PROVIDER_MODE
      // "mock"); building a second app here with an overridden config is
      // simpler than extending the shared fixture just for this one case.
      const liveApp = await buildApp({
        config: { ...testConfig, PROVIDER_MODE: "live" },
        prisma,
        modelDiscoveryClient: fakeDiscoveryClient,
      });
      apps.push(liveApp);

      const response = await liveApp.inject({
        method: "POST",
        url: `/v1/workspaces/${fixture.workspaceId}/models/discover`,
        headers: { "x-api-key": fixture.apiKey },
        payload: { provider: "openai" },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload) as { discovered: string[] };
      expect(body.discovered).toEqual(["live-discovered-model-1", "live-discovered-model-2"]);
      expect(calls).toEqual([{ provider: "openai", apiKey: "sk-test-real-key" }]);
    });

    it("returns 404 when no enabled credential exists for the requested provider", async () => {
      const fixture = await seedWorkspaceWithRole(prisma, "Owner");
      fixtures.push(fixture);
      const liveApp = await buildApp({
        config: { ...testConfig, PROVIDER_MODE: "live" },
        prisma,
        modelDiscoveryClient: { listModels: () => Promise.resolve([]) },
      });
      apps.push(liveApp);

      const response = await liveApp.inject({
        method: "POST",
        url: `/v1/workspaces/${fixture.workspaceId}/models/discover`,
        headers: { "x-api-key": fixture.apiKey },
        payload: { provider: "anthropic" },
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe("GET /v1/models/catalog", () => {
    it("returns catalog entries publicly, filterable by provider", async () => {
      const fixture = await seedWorkspaceWithRole(prisma, "Owner");
      fixtures.push(fixture);
      const { app } = await createPrismaWorkspaceTestApp(prisma);
      apps.push(app);
      await app.inject({
        method: "POST",
        url: `/v1/workspaces/${fixture.workspaceId}/models/discover`,
        headers: { "x-api-key": fixture.apiKey },
        payload: { provider: "groq" },
      });

      const response = await app.inject({ method: "GET", url: "/v1/models/catalog?provider=groq" });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload) as {
        models: Array<{ provider: string; model: string }>;
      };
      expect(body.models.length).toBeGreaterThan(0);
      expect(body.models.every((entry) => entry.provider === "groq")).toBe(true);
    });
  });
});

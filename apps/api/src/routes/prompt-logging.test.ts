import { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { InMemoryCacheService } from "../infrastructure/cache-service.js";
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

describe("prompt-logging routes", () => {
  const apps: Array<{ readonly app: FastifyInstance }> = [];
  const fixturePrisma = new PrismaClient({ datasourceUrl: testConfig.DATABASE_URL });
  const fixtures: WorkspaceRoleFixture[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map(({ app }) => app.close()));
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

  describe("GET /v1/workspaces/:workspaceId/prompt-logging", () => {
    it("defaults to enabled for a workspace with no explicit setting", async () => {
      const { app, fixture } = await setupForRole("Admin");

      const response = await app.inject({
        method: "GET",
        url: `/v1/workspaces/${fixture.workspaceId}/prompt-logging`,
        headers: { "x-api-key": fixture.apiKey },
      });

      expect(response.statusCode).toBe(200);
      expect(parse<{ promptLoggingEnabled: boolean }>(response).promptLoggingEnabled).toBe(true);
    });

    it.each(["Developer", "Viewer"] as const)(
      "rejects reads when caller has role=%s",
      async (role) => {
        const { app, fixture } = await setupForRole(role);

        const response = await app.inject({
          method: "GET",
          url: `/v1/workspaces/${fixture.workspaceId}/prompt-logging`,
          headers: { "x-api-key": fixture.apiKey },
        });

        expect(response.statusCode).toBe(403);
      },
    );

    it("rejects a cross-workspace read attempt", async () => {
      const { fixture: otherFixture } = await setupForRole("Owner");
      const { app, fixture } = await setupForRole("Owner");

      const response = await app.inject({
        method: "GET",
        url: `/v1/workspaces/${otherFixture.workspaceId}/prompt-logging`,
        headers: { "x-api-key": fixture.apiKey },
      });

      expect(response.statusCode).toBe(403);
    });
  });

  describe("PATCH /v1/workspaces/:workspaceId/prompt-logging", () => {
    it.each(["Owner", "Admin"] as const)(
      "updates the setting when caller has role=%s",
      async (role) => {
        const { app, fixture } = await setupForRole(role);

        const response = await app.inject({
          method: "PATCH",
          url: `/v1/workspaces/${fixture.workspaceId}/prompt-logging`,
          headers: { "x-api-key": fixture.apiKey },
          payload: { promptLoggingEnabled: false },
        });

        expect(response.statusCode).toBe(200);
        expect(parse<{ promptLoggingEnabled: boolean }>(response).promptLoggingEnabled).toBe(false);

        const getResponse = await app.inject({
          method: "GET",
          url: `/v1/workspaces/${fixture.workspaceId}/prompt-logging`,
          headers: { "x-api-key": fixture.apiKey },
        });
        expect(parse<{ promptLoggingEnabled: boolean }>(getResponse).promptLoggingEnabled).toBe(
          false,
        );
      },
    );

    it.each(["Developer", "Viewer"] as const)(
      "rejects updates when caller has role=%s",
      async (role) => {
        const { app, fixture } = await setupForRole(role);

        const response = await app.inject({
          method: "PATCH",
          url: `/v1/workspaces/${fixture.workspaceId}/prompt-logging`,
          headers: { "x-api-key": fixture.apiKey },
          payload: { promptLoggingEnabled: false },
        });

        expect(response.statusCode).toBe(403);
      },
    );

    it("rejects a cross-workspace update attempt", async () => {
      const { fixture: otherFixture } = await setupForRole("Owner");
      const { app, fixture } = await setupForRole("Owner");

      const response = await app.inject({
        method: "PATCH",
        url: `/v1/workspaces/${otherFixture.workspaceId}/prompt-logging`,
        headers: { "x-api-key": fixture.apiKey },
        payload: { promptLoggingEnabled: false },
      });

      expect(response.statusCode).toBe(403);
    });

    it("writes an audit event attributed to the acting principal", async () => {
      const { app, fixture } = await setupForRole("Owner");

      await app.inject({
        method: "PATCH",
        url: `/v1/workspaces/${fixture.workspaceId}/prompt-logging`,
        headers: { "x-api-key": fixture.apiKey },
        payload: { promptLoggingEnabled: false },
      });

      const events = await fixturePrisma.auditEvent.findMany({
        where: { workspaceId: fixture.workspaceId, action: "workspace.update" },
      });
      expect(events).toHaveLength(1);
      expect(events[0]?.principalId).toBe(fixture.principalId);
      expect(events[0]?.metadataJson).toMatchObject({ promptLoggingEnabled: false });
    });
  });
});

describe("prompt logging setting gates response caching", () => {
  const prisma = new PrismaClient({ datasourceUrl: testConfig.DATABASE_URL });
  const apps: Array<{ readonly app: FastifyInstance }> = [];
  const fixtures: WorkspaceRoleFixture[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map(({ app }) => app.close()));
    await Promise.all(fixtures.splice(0).map((fixture) => cleanupFixture(prisma, fixture)));
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function setupWorkspace() {
    const cacheService = new InMemoryCacheService();
    const { app } = await createPrismaWorkspaceTestApp(prisma, { cacheService });
    apps.push({ app });
    const fixture = await seedWorkspaceWithRole(prisma, "Owner");
    fixtures.push(fixture);
    return { app, fixture, cacheService };
  }

  async function sendCacheableChatCompletion(app: FastifyInstance, apiKey: string) {
    return app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { "x-api-key": apiKey },
      payload: {
        model: "gpt-4o",
        messages: [{ role: "user", content: "Should this get cached?" }],
        cache: { mode: "exact", ttlSeconds: 3600 },
      },
    });
  }

  it("never persists a cache entry for a workspace with prompt logging disabled", async () => {
    const { app, fixture, cacheService } = await setupWorkspace();
    await prisma.workspace.update({
      where: { id: fixture.workspaceId },
      data: { promptLoggingEnabled: false },
    });

    const first = await sendCacheableChatCompletion(app, fixture.apiKey);
    const second = await sendCacheableChatCompletion(app, fixture.apiKey);

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    const entries = await cacheService.entries(fixture.userId);
    expect(entries).toHaveLength(0);
    // With no cache entry to hit, the second identical request is decided
    // fresh each time -- confirms this isn't just an empty cache by
    // coincidence, but caching genuinely never engaged for this workspace.
    const secondBody = parse<{ metadata: { cache?: { hit: boolean } } }>(second);
    expect(secondBody.metadata.cache?.hit).not.toBe(true);
  });

  it("persists a cache entry as normal for a workspace with prompt logging enabled (the default)", async () => {
    const { app, fixture, cacheService } = await setupWorkspace();

    const first = await sendCacheableChatCompletion(app, fixture.apiKey);
    const second = await sendCacheableChatCompletion(app, fixture.apiKey);

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    const entries = await cacheService.entries(fixture.userId);
    expect(entries).toHaveLength(1);
    const secondBody = parse<{ metadata: { cache?: { hit: boolean } } }>(second);
    expect(secondBody.metadata.cache?.hit).toBe(true);
  });
});

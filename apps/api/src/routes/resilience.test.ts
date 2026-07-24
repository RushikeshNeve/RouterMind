import { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { InMemoryProviderAttemptLogStore } from "../infrastructure/provider-attempt-log-store.js";
import {
  cleanupFixture,
  createPrismaWorkspaceTestApp,
  seedWorkspaceWithRole,
  type WorkspaceRoleFixture,
} from "./workspaces-rbac-fixtures.js";

interface ProviderAttemptsResponse {
  readonly attempts: readonly { readonly id: string; readonly workspaceId?: string }[];
}

function parseResponse<TResponse>(response: { payload: string }): TResponse {
  return JSON.parse(response.payload) as TResponse;
}

describe("resilience routes", () => {
  const prisma = new PrismaClient({
    datasourceUrl: "postgresql://routemind:routemind@localhost:5432/routemind?schema=public",
  });
  const apps: FastifyInstance[] = [];
  const fixtures: WorkspaceRoleFixture[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
    await Promise.all(fixtures.splice(0).map((fixture) => cleanupFixture(prisma, fixture)));
  });

  describe("GET /v1/workspaces/:workspaceId/resilience/provider-attempts", () => {
    it("returns only the caller's own workspace's attempts", async () => {
      const providerAttemptLogStore = new InMemoryProviderAttemptLogStore();
      const fixtureA = await seedWorkspaceWithRole(prisma, "Owner");
      fixtures.push(fixtureA);
      const fixtureB = await seedWorkspaceWithRole(prisma, "Owner");
      fixtures.push(fixtureB);

      await providerAttemptLogStore.create({
        workspaceId: fixtureA.workspaceId,
        userId: "user-a",
        provider: "openai",
        model: "gpt-4o",
        attemptNumber: 1,
        status: "success",
        latencyMs: 120,
      });
      await providerAttemptLogStore.create({
        workspaceId: fixtureB.workspaceId,
        userId: "user-b",
        provider: "anthropic",
        model: "claude-3-5-sonnet",
        attemptNumber: 1,
        status: "failed",
        latencyMs: 400,
      });

      const { app } = await createPrismaWorkspaceTestApp(prisma, { providerAttemptLogStore });
      apps.push(app);

      const response = await app.inject({
        method: "GET",
        url: `/v1/workspaces/${fixtureA.workspaceId}/resilience/provider-attempts`,
        headers: { "x-api-key": fixtureA.apiKey },
      });
      const body = parseResponse<ProviderAttemptsResponse>(response);

      expect(response.statusCode).toBe(200);
      expect(body.attempts).toHaveLength(1);
      expect(body.attempts[0]).toMatchObject({ provider: "openai" });
    });

    it("rejects an unauthenticated request", async () => {
      const fixture = await seedWorkspaceWithRole(prisma, "Owner");
      fixtures.push(fixture);
      const { app } = await createPrismaWorkspaceTestApp(prisma);
      apps.push(app);

      const response = await app.inject({
        method: "GET",
        url: `/v1/workspaces/${fixture.workspaceId}/resilience/provider-attempts`,
      });

      expect(response.statusCode).toBe(401);
    });

    it("rejects a caller whose key belongs to a different workspace", async () => {
      const fixtureA = await seedWorkspaceWithRole(prisma, "Owner");
      fixtures.push(fixtureA);
      const fixtureB = await seedWorkspaceWithRole(prisma, "Owner");
      fixtures.push(fixtureB);
      const { app } = await createPrismaWorkspaceTestApp(prisma);
      apps.push(app);

      const response = await app.inject({
        method: "GET",
        url: `/v1/workspaces/${fixtureA.workspaceId}/resilience/provider-attempts`,
        headers: { "x-api-key": fixtureB.apiKey },
      });

      expect(response.statusCode).toBe(403);
    });
  });

  describe("GET /v1/resilience/circuit-breakers", () => {
    it("stays platform-wide and unauthenticated -- no tenant dimension to scope", async () => {
      const fixture = await seedWorkspaceWithRole(prisma, "Owner");
      fixtures.push(fixture);
      const { app } = await createPrismaWorkspaceTestApp(prisma);
      apps.push(app);

      const response = await app.inject({ method: "GET", url: "/v1/resilience/circuit-breakers" });

      expect(response.statusCode).toBe(200);
    });
  });
});

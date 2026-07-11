import type { PrismaClient } from "@prisma/client";
import cookie from "@fastify/cookie";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ApiConfig } from "../config.js";
import { requirePermission } from "./rbac.js";

const testConfig = { SESSION_SECRET: "test-session-secret" } as ApiConfig;

async function buildTestApp(prisma: PrismaClient, permission: string) {
  const app = Fastify();
  await app.register(cookie);
  app.get("/protected", { preHandler: requirePermission(prisma, permission, testConfig) }, () => ({
    ok: true,
  }));
  await app.ready();
  return app;
}

describe("requirePermission", () => {
  const apps: Awaited<ReturnType<typeof buildTestApp>>[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it("returns 401 when no API key is present", async () => {
    const findUnique = vi.fn();
    const prisma = { apiKey: { findUnique } } as unknown as PrismaClient;
    const app = await buildTestApp(prisma, "models.use");
    apps.push(app);

    const response = await app.inject({ method: "GET", url: "/protected" });

    expect(response.statusCode).toBe(401);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("returns 401 when the API key does not resolve to an active, workspace-scoped principal", async () => {
    const prisma = {
      apiKey: { findUnique: vi.fn().mockResolvedValue(null) },
    } as unknown as PrismaClient;
    const app = await buildTestApp(prisma, "models.use");
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/protected",
      headers: { "x-api-key": "unknown-key" },
    });

    expect(response.statusCode).toBe(401);
  });

  it("returns 403 when the caller's role has no Membership.roleId assigned", async () => {
    const prisma = {
      apiKey: {
        findUnique: vi.fn().mockResolvedValue({
          isActive: true,
          principalId: "principal-1",
          workspaceId: "workspace-1",
        }),
      },
      membership: {
        findUnique: vi.fn().mockResolvedValue({ roleId: null }),
      },
    } as unknown as PrismaClient;
    const app = await buildTestApp(prisma, "models.use");
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/protected",
      headers: { "x-api-key": "valid-key" },
    });

    expect(response.statusCode).toBe(403);
  });

  it("returns 403 when the role does not have the required permission", async () => {
    const rolePermissionFindUnique = vi.fn().mockResolvedValue(null);
    const prisma = {
      apiKey: {
        findUnique: vi.fn().mockResolvedValue({
          isActive: true,
          principalId: "principal-1",
          workspaceId: "workspace-1",
        }),
      },
      membership: {
        findUnique: vi.fn().mockResolvedValue({ roleId: "role-viewer" }),
      },
      rolePermission: {
        findUnique: rolePermissionFindUnique,
      },
    } as unknown as PrismaClient;
    const app = await buildTestApp(prisma, "budget.manage");
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/protected",
      headers: { "x-api-key": "valid-key" },
    });

    expect(response.statusCode).toBe(403);
    expect(rolePermissionFindUnique).toHaveBeenCalledWith({
      where: { roleId_permission: { roleId: "role-viewer", permission: "budget.manage" } },
    });
  });

  it("allows the request through when the role has the required permission", async () => {
    const prisma = {
      apiKey: {
        findUnique: vi.fn().mockResolvedValue({
          isActive: true,
          principalId: "principal-1",
          workspaceId: "workspace-1",
        }),
      },
      membership: {
        findUnique: vi.fn().mockResolvedValue({ roleId: "role-owner" }),
      },
      rolePermission: {
        findUnique: vi
          .fn()
          .mockResolvedValue({ id: "rp-1", roleId: "role-owner", permission: "budget.manage" }),
      },
    } as unknown as PrismaClient;
    const app = await buildTestApp(prisma, "budget.manage");
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/protected",
      headers: { "x-api-key": "valid-key" },
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.payload)).toEqual({ ok: true });
  });

  it("returns 401 for an inactive API key even with a valid workspace/principal", async () => {
    const prisma = {
      apiKey: {
        findUnique: vi.fn().mockResolvedValue({
          isActive: false,
          principalId: "principal-1",
          workspaceId: "workspace-1",
        }),
      },
    } as unknown as PrismaClient;
    const app = await buildTestApp(prisma, "models.use");
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/protected",
      headers: { authorization: "Bearer valid-key" },
    });

    expect(response.statusCode).toBe(401);
  });
});

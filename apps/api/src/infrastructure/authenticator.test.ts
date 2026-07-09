import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { PrismaApiKeyAuthenticator } from "./authenticator.js";

describe("PrismaApiKeyAuthenticator", () => {
  it("falls back to the configured development key when no database record exists", async () => {
    const prisma = {
      apiKey: {
        findFirst: vi.fn().mockResolvedValue(null),
      },
    } as unknown as PrismaClient;

    const authenticator = new PrismaApiKeyAuthenticator(prisma, "dev-key");

    await expect(authenticator.authenticate("dev-key")).resolves.toEqual({
      id: "dev-user",
      name: "Development User",
      email: "dev@routemind.local",
      apiKey: "dev-key",
    });
  });
});

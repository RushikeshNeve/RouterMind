import type { PrismaClient } from "@prisma/client";

import { hashApiKey } from "../security/api-key.js";

export interface AuthenticatedUser {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly apiKey: string;
}

export interface ApiKeyAuthenticator {
  authenticate(apiKey: string): Promise<AuthenticatedUser | undefined>;
}

export class PrismaApiKeyAuthenticator implements ApiKeyAuthenticator {
  constructor(private readonly prisma: PrismaClient) {}

  async authenticate(apiKey: string): Promise<AuthenticatedUser | undefined> {
    const record = await this.prisma.apiKey.findFirst({
      where: {
        keyHash: hashApiKey(apiKey),
        isActive: true,
      },
      include: {
        user: true,
      },
    });

    if (!record) {
      return undefined;
    }

    return {
      id: record.user.id,
      name: record.user.name,
      email: record.user.email,
      apiKey,
    };
  }
}

export class StaticApiKeyAuthenticator implements ApiKeyAuthenticator {
  constructor(
    private readonly apiKey: string,
    private readonly user: Omit<AuthenticatedUser, "apiKey"> = {
      id: "test-user",
      name: "Test User",
      email: "test@routemind.local",
    },
  ) {}

  authenticate(apiKey: string): Promise<AuthenticatedUser | undefined> {
    if (apiKey !== this.apiKey) {
      return Promise.resolve(undefined);
    }

    return Promise.resolve({
      ...this.user,
      apiKey,
    });
  }
}

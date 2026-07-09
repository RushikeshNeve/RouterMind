import type { PrismaClient } from "@prisma/client";
import { listModelsForProvider, modelRegistry, type ProviderId } from "@routemind/providers";

import type { ApiConfig } from "../config.js";
import type { AuthenticatedUser } from "./authenticator.js";
import { decryptCredential } from "../security/credentials.js";

export interface UserProviderAvailability {
  readonly enabledProviders: readonly ProviderId[];
  readonly enabledModels: readonly string[];
  readonly providerApiKeys: {
    readonly openai?: string | undefined;
    readonly anthropic?: string | undefined;
    readonly gemini?: string | undefined;
    readonly groq?: string | undefined;
  };
}

export interface UserAvailabilityStore {
  getAvailability(user: AuthenticatedUser): Promise<UserProviderAvailability>;
}

export class PrismaUserAvailabilityStore implements UserAvailabilityStore {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly config: ApiConfig,
  ) {}

  async getAvailability(user: AuthenticatedUser): Promise<UserProviderAvailability> {
    if (user.id === "dev-user") {
      return createDefaultAvailability(this.config);
    }

    if (user.workspaceId) {
      const [credentials, modelAccess] = await Promise.all([
        this.prisma.$queryRaw<{ readonly provider: string; readonly encryptedApiKey: string }[]>`
          SELECT "provider", "encryptedApiKey"
          FROM "ProviderCredential"
          WHERE "workspaceId" = ${user.workspaceId}
            AND "isEnabled" = true
        `,
        this.prisma.$queryRaw<{ readonly provider: string; readonly model: string }[]>`
          SELECT "provider", "model"
          FROM "UserModelAccess"
          WHERE "workspaceId" = ${user.workspaceId}
            AND "isEnabled" = true
        `,
      ]);
      const enabledProviders = credentials.map((credential) => credential.provider);
      const providerApiKeys = Object.fromEntries(
        credentials.map((credential) => [
          credential.provider,
          decryptCredential(credential.encryptedApiKey, this.config.CREDENTIAL_ENCRYPTION_KEY),
        ]),
      ) as UserProviderAvailability["providerApiKeys"];

      return {
        enabledProviders,
        providerApiKeys,
        enabledModels: modelAccess
          .filter((access) => enabledProviders.includes(access.provider))
          .map((access) => access.model),
      };
    }

    const [credentials, modelAccess] = await Promise.all([
      this.prisma.providerCredential.findMany({
        where: {
          userId: user.id,
          isEnabled: true,
        },
      }),
      this.prisma.userModelAccess.findMany({
        where: {
          userId: user.id,
          isEnabled: true,
        },
      }),
    ]);

    const enabledProviders = credentials.map((credential) => credential.provider);
    const providerApiKeys = Object.fromEntries(
      credentials.map((credential) => [
        credential.provider,
        decryptCredential(credential.encryptedApiKey, this.config.CREDENTIAL_ENCRYPTION_KEY),
      ]),
    ) as UserProviderAvailability["providerApiKeys"];
    const enabledModels = modelAccess
      .filter((access) => enabledProviders.includes(access.provider))
      .map((access) => access.model);

    return {
      enabledProviders,
      enabledModels,
      providerApiKeys,
    };
  }
}

export class StaticUserAvailabilityStore implements UserAvailabilityStore {
  constructor(private readonly availability: UserProviderAvailability) {}

  getAvailability(): Promise<UserProviderAvailability> {
    return Promise.resolve(this.availability);
  }
}

export function createDefaultAvailability(config: ApiConfig): UserProviderAvailability {
  const providerApiKeys = {
    openai: config.OPENAI_API_KEY,
    anthropic: config.ANTHROPIC_API_KEY,
    gemini: config.GEMINI_API_KEY,
    groq: config.GROQ_API_KEY,
  };
  const enabledProviders =
    config.PROVIDER_MODE === "mock"
      ? Array.from(new Set(Object.values(modelRegistry).map((entry) => entry.provider)))
      : Object.entries(providerApiKeys)
          .filter(([, apiKey]) => typeof apiKey === "string" && apiKey.length > 0)
          .map(([provider]) => provider);

  return {
    enabledProviders,
    enabledModels: enabledProviders.flatMap((provider) => [...listModelsForProvider(provider)]),
    providerApiKeys,
  };
}

import { randomBytes } from "node:crypto";
import { getModelRegistryEntry, modelRegistry, type ProviderId } from "@routemind/providers";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import type { ApiConfig } from "../config.js";
import type { OnboardingStore } from "../infrastructure/onboarding-store.js";

const providers = ["openai", "anthropic", "gemini", "groq"] as const;

const createUserSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
});

const createApiKeySchema = z.object({
  userId: z.string().min(1),
  name: z.string().min(1),
});

const providerCredentialSchema = z.object({
  userId: z.string().min(1),
  provider: z.enum(providers),
  apiKey: z.string().min(1),
});

const updateProviderCredentialSchema = z.object({
  isEnabled: z.boolean(),
});

const providerCredentialParamsSchema = z.object({
  id: z.string().min(1),
});

const modelAccessSchema = z.object({
  userId: z.string().min(1),
  provider: z.enum(providers),
  model: z.string().min(1),
  isEnabled: z.boolean().default(true),
});

const userParamsSchema = z.object({
  userId: z.string().min(1),
});

export interface OnboardingRouteDependencies {
  readonly config: ApiConfig;
  readonly onboardingStore: OnboardingStore;
}

export function registerOnboardingRoutes(
  app: FastifyInstance,
  dependencies: OnboardingRouteDependencies,
): void {
  app.post("/v1/users", async (request, reply) => {
    const parsed = createUserSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendValidationError(reply, parsed.error.flatten());
    }

    try {
      const user = await dependencies.onboardingStore.createUser(parsed.data);
      return reply.status(201).send(serializeUser(user));
    } catch {
      return reply.status(409).send({
        error: {
          message: "User could not be created. The email may already exist.",
        },
      });
    }
  });

  app.post("/v1/api-keys", async (request, reply) => {
    const parsed = createApiKeySchema.safeParse(request.body);
    if (!parsed.success) {
      return sendValidationError(reply, parsed.error.flatten());
    }

    const user = await dependencies.onboardingStore.findUser(parsed.data.userId);
    if (!user) {
      return reply.status(404).send({ error: { message: "User not found." } });
    }

    const apiKey = generateRouteMindApiKey(dependencies.config.NODE_ENV);
    const record = await dependencies.onboardingStore.createApiKey({
      userId: parsed.data.userId,
      name: parsed.data.name,
      rawApiKey: apiKey,
    });

    return reply.status(201).send({
      apiKey,
      name: record.name,
      createdAt: record.createdAt.toISOString(),
    });
  });

  app.post("/v1/provider-credentials", async (request, reply) => {
    const parsed = providerCredentialSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendValidationError(reply, parsed.error.flatten());
    }

    const user = await dependencies.onboardingStore.findUser(parsed.data.userId);
    if (!user) {
      return reply.status(404).send({ error: { message: "User not found." } });
    }

    const record = await dependencies.onboardingStore.createProviderCredential({
      userId: parsed.data.userId,
      provider: parsed.data.provider,
      apiKey: parsed.data.apiKey,
      encryptionKey: dependencies.config.CREDENTIAL_ENCRYPTION_KEY,
    });

    return reply.status(201).send({
      id: record.id,
      provider: record.provider,
      isEnabled: record.isEnabled,
      createdAt: record.createdAt.toISOString(),
    });
  });

  app.patch("/v1/provider-credentials/:id", async (request, reply) => {
    const params = providerCredentialParamsSchema.safeParse(request.params);
    const body = updateProviderCredentialSchema.safeParse(request.body);
    if (!params.success) {
      return sendValidationError(reply, params.error.flatten());
    }
    if (!body.success) {
      return sendValidationError(reply, body.error.flatten());
    }

    const record = await dependencies.onboardingStore.updateProviderCredential({
      id: params.data.id,
      isEnabled: body.data.isEnabled,
    });

    if (!record) {
      return reply.status(404).send({ error: { message: "Provider credential not found." } });
    }

    return reply.send({
      id: record.id,
      provider: record.provider,
      isEnabled: record.isEnabled,
      updatedAt: record.updatedAt.toISOString(),
    });
  });

  app.post("/v1/model-access", async (request, reply) => {
    const parsed = modelAccessSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendValidationError(reply, parsed.error.flatten());
    }

    const user = await dependencies.onboardingStore.findUser(parsed.data.userId);
    if (!user) {
      return reply.status(404).send({ error: { message: "User not found." } });
    }

    const modelEntry = getModelRegistryEntry(parsed.data.model);
    if (!modelEntry || modelEntry.provider !== parsed.data.provider) {
      return reply.status(400).send({
        error: {
          message: `Model ${parsed.data.model} is not supported by provider ${parsed.data.provider}.`,
        },
      });
    }

    const record = await dependencies.onboardingStore.upsertModelAccess({
      userId: parsed.data.userId,
      provider: parsed.data.provider,
      model: parsed.data.model,
      isEnabled: parsed.data.isEnabled,
    });

    return reply.status(201).send({
      id: record.id,
      provider: record.provider,
      model: record.model,
      isEnabled: record.isEnabled,
    });
  });

  app.get("/v1/users/:userId/available-models", async (request, reply) => {
    const params = userParamsSchema.safeParse(request.params);
    if (!params.success) {
      return sendValidationError(reply, params.error.flatten());
    }

    const user = await dependencies.onboardingStore.findUser(params.data.userId);
    if (!user) {
      return reply.status(404).send({ error: { message: "User not found." } });
    }

    const models = await dependencies.onboardingStore.listAvailableModels(params.data.userId);
    return reply.send({
      userId: params.data.userId,
      models,
    });
  });
}

function serializeUser(user: {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly createdAt: Date;
}) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    createdAt: user.createdAt.toISOString(),
  };
}

function generateRouteMindApiKey(nodeEnv: ApiConfig["NODE_ENV"]): string {
  const prefix = nodeEnv === "production" ? "rm_live" : "rm_test";
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}

function sendValidationError(reply: FastifyReply, issues: unknown) {
  return reply.status(400).send({
    error: {
      message: "Invalid request body.",
      issues,
    },
  });
}

export function isSupportedProvider(provider: string): provider is ProviderId {
  return providers.includes(provider as (typeof providers)[number]);
}

export function registeredModelIds(): readonly string[] {
  return Object.keys(modelRegistry);
}

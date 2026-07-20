import { randomBytes } from "node:crypto";
import { getModelRegistryEntry, modelRegistry, type ProviderId } from "@routemind/providers";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import type { ApiConfig } from "../config.js";
import type { ApiKeyAuthenticator } from "../infrastructure/authenticator.js";
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
  readonly authenticator: ApiKeyAuthenticator;
}

/**
 * Authenticates the caller via X-API-Key and requires it to belong to
 * expectedUserId -- onboarding.ts's mutating routes (other than the true
 * bootstrap steps) accept a userId in the body/params, and without this
 * check that userId was trusted unchecked, letting any caller act on any
 * other user's account. Sends the 401/403 response itself; returns the
 * authenticated user on success, undefined on failure.
 */
async function requireOwnUser(
  request: FastifyRequest,
  reply: FastifyReply,
  authenticator: ApiKeyAuthenticator,
  expectedUserId: string,
) {
  const header = request.headers["x-api-key"];
  const apiKey = Array.isArray(header) ? header[0] : header;
  if (!apiKey) {
    reply.status(401).send({ error: { message: "An X-API-Key header is required." } });
    return undefined;
  }

  const authenticated = await authenticator.authenticate(apiKey);
  if (!authenticated) {
    reply.status(401).send({ error: { message: "Invalid API key." } });
    return undefined;
  }

  if (authenticated.id !== expectedUserId) {
    reply.status(403).send({ error: { message: "You may only act on your own account." } });
    return undefined;
  }

  return authenticated;
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

    // First key for a user is the true bootstrap step (no prior key exists
    // to authenticate with). Once a user has one, minting another requires
    // proving you already control this account.
    if (await dependencies.onboardingStore.hasActiveApiKey(parsed.data.userId)) {
      const authenticated = await requireOwnUser(
        request,
        reply,
        dependencies.authenticator,
        parsed.data.userId,
      );
      if (!authenticated) {
        return reply;
      }
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

    const authenticated = await requireOwnUser(
      request,
      reply,
      dependencies.authenticator,
      parsed.data.userId,
    );
    if (!authenticated) {
      return reply;
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

    // Ownership isn't known until the caller is authenticated -- unlike the
    // other routes, expectedUserId can't be checked up front here.
    const header = request.headers["x-api-key"];
    const apiKey = Array.isArray(header) ? header[0] : header;
    if (!apiKey) {
      return reply.status(401).send({ error: { message: "An X-API-Key header is required." } });
    }
    const authenticated = await dependencies.authenticator.authenticate(apiKey);
    if (!authenticated) {
      return reply.status(401).send({ error: { message: "Invalid API key." } });
    }

    const record = await dependencies.onboardingStore.updateProviderCredential({
      id: params.data.id,
      isEnabled: body.data.isEnabled,
      callerUserId: authenticated.id,
    });

    if (!record) {
      // Same response whether the credential doesn't exist or belongs to
      // someone else -- distinguishing the two would leak which is true.
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

    const authenticated = await requireOwnUser(
      request,
      reply,
      dependencies.authenticator,
      parsed.data.userId,
    );
    if (!authenticated) {
      return reply;
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

    const authenticated = await requireOwnUser(
      request,
      reply,
      dependencies.authenticator,
      params.data.userId,
    );
    if (!authenticated) {
      return reply;
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

import type { Prisma, PrismaClient } from "@prisma/client";
import { getModelRegistryEntry, listModelsForProvider, modelRegistry } from "@routemind/providers";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import type { ApiConfig } from "../config.js";
import type { ApiKeyAuthenticator } from "../infrastructure/authenticator.js";
import { writeAuditEvent } from "../infrastructure/audit.js";
import {
  ModelDiscoveryError,
  type ModelDiscoveryClient,
} from "../infrastructure/model-discovery-client.js";
import { ensureSameWorkspace, requirePermission } from "../infrastructure/rbac.js";
import type { UserAvailabilityStore } from "../infrastructure/user-availability.js";
import { decryptCredential } from "../security/credentials.js";

const MODEL_CREATED_AT = 1_700_000_000;

const workspaceParamsSchema = z.object({ workspaceId: z.string().min(1) });
const discoverBodySchema = z.object({
  provider: z.enum(["openai", "anthropic", "gemini", "groq"]),
});
const catalogQuerySchema = z.object({ provider: z.string().min(1).optional() });

export interface ModelRouteDependencies {
  readonly authenticator: ApiKeyAuthenticator;
  readonly availabilityStore: UserAvailabilityStore;
  readonly config: ApiConfig;
  readonly prisma: PrismaClient;
  readonly modelDiscoveryClient: ModelDiscoveryClient;
}

/** Mirrors ModelRegistryEntry's own boolean/tier fields exactly. */
function capabilitiesFromRegistry(modelId: string): Prisma.InputJsonObject {
  const entry = getModelRegistryEntry(modelId);
  if (!entry) return {};
  return {
    supportsCode: entry.supportsCode,
    supportsReasoning: entry.supportsReasoning,
    supportsSummarization: entry.supportsSummarization,
    supportsFastResponse: entry.supportsFastResponse,
    costTier: entry.costTier,
    latencyTier: entry.latencyTier,
    qualityTier: entry.qualityTier,
  };
}

function validation(reply: FastifyReply): FastifyReply {
  return reply.status(400).send({ error: { message: "Invalid model discovery request." } });
}

export function registerModelRoutes(
  app: FastifyInstance,
  dependencies: ModelRouteDependencies,
): void {
  app.get("/v1/models", async (request, reply) => {
    const apiKey = extractApiKey(request);

    if (!apiKey) {
      return {
        object: "list",
        data: serializeModels(["auto", ...Object.keys(modelRegistry)]),
      };
    }

    const user = await dependencies.authenticator.authenticate(apiKey);
    if (!user) {
      return reply.status(401).send({
        error: {
          message: "Missing or invalid API key.",
          type: "authentication_error",
          code: "invalid_api_key",
        },
      });
    }

    const availability = await dependencies.availabilityStore.getAvailability(user);

    return {
      object: "list",
      data: serializeModels(["auto", ...availability.enabledModels]),
    };
  });

  const { config, prisma, modelDiscoveryClient } = dependencies;

  app.post(
    "/v1/workspaces/:workspaceId/models/discover",
    { preHandler: requirePermission(prisma, "models.manage", config) },
    async (request, reply) => {
      const params = workspaceParamsSchema.safeParse(request.params);
      const body = discoverBodySchema.safeParse(request.body);
      if (!params.success || !body.success) {
        return validation(reply);
      }
      if (!ensureSameWorkspace(request, params.data.workspaceId, reply)) {
        return reply;
      }
      const { provider } = body.data;

      let modelIds: readonly string[];
      if (config.PROVIDER_MODE === "mock") {
        // No real credential needed or used -- matches every other mock-mode
        // code path in this codebase (chat completions, router-LLM, etc.).
        modelIds = listModelsForProvider(provider);
      } else {
        const credential = await prisma.providerCredential.findFirst({
          where: { workspaceId: params.data.workspaceId, provider, isEnabled: true },
        });
        if (!credential) {
          return reply.status(404).send({
            error: {
              message: `No enabled ${provider} credential is configured for this workspace.`,
            },
          });
        }
        const apiKey = decryptCredential(
          credential.encryptedApiKey,
          config.CREDENTIAL_ENCRYPTION_KEY,
        );
        try {
          modelIds = await modelDiscoveryClient.listModels(provider, apiKey);
        } catch (error) {
          if (error instanceof ModelDiscoveryError) {
            return reply.status(error.status).send({ error: { message: error.message } });
          }
          throw error;
        }
      }

      await prisma.$transaction(async (tx) => {
        for (const modelId of modelIds) {
          await tx.modelCatalog.upsert({
            where: { provider_model: { provider, model: modelId } },
            create: {
              provider,
              model: modelId,
              capabilitiesJson: capabilitiesFromRegistry(modelId),
              pricingJson: {},
            },
            update: {
              capabilitiesJson: capabilitiesFromRegistry(modelId),
              lastSyncedAt: new Date(),
            },
          });
        }
        const rbacContext = request.rbacContext!;
        await writeAuditEvent(tx, {
          workspaceId: params.data.workspaceId,
          principalId: rbacContext.principalId,
          action: "models.discover",
          targetType: "ModelCatalog",
          targetId: provider,
          metadata: { provider, discoveredCount: modelIds.length },
        });
      });

      return reply.status(200).send({ provider, discovered: modelIds, count: modelIds.length });
    },
  );

  // Public, unauthenticated -- platform-level reference data, same category
  // as GET /v1/plans.
  app.get("/v1/models/catalog", async (request, reply) => {
    const query = catalogQuerySchema.safeParse(request.query);
    if (!query.success) {
      return validation(reply);
    }
    const rows = await prisma.modelCatalog.findMany({
      where: query.data.provider ? { provider: query.data.provider } : undefined,
      orderBy: [{ provider: "asc" }, { model: "asc" }],
    });
    return reply.status(200).send({
      models: rows.map((row) => ({
        provider: row.provider,
        model: row.model,
        capabilitiesJson: row.capabilitiesJson,
        pricingJson: row.pricingJson,
        lastSyncedAt: row.lastSyncedAt.toISOString(),
      })),
    });
  });
}

function serializeModels(modelIds: readonly string[]) {
  return [...new Set(modelIds)].map((modelId) => ({
    id: modelId,
    object: "model",
    created: MODEL_CREATED_AT,
    owned_by:
      modelId === "auto" ? "routemind" : (getModelRegistryEntry(modelId)?.provider ?? "routemind"),
  }));
}

function extractApiKey(request: FastifyRequest): string | undefined {
  const directApiKey = request.headers["x-api-key"];
  if (typeof directApiKey === "string" && directApiKey.length > 0) {
    return directApiKey;
  }

  const authorization = request.headers.authorization;
  if (typeof authorization !== "string") {
    return undefined;
  }

  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim();
}

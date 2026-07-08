import { getModelRegistryEntry, modelRegistry } from "@routemind/providers";
import type { FastifyInstance, FastifyRequest } from "fastify";

import type { ApiKeyAuthenticator } from "../infrastructure/authenticator.js";
import type { UserAvailabilityStore } from "../infrastructure/user-availability.js";

const MODEL_CREATED_AT = 1_700_000_000;

export interface ModelRouteDependencies {
  readonly authenticator: ApiKeyAuthenticator;
  readonly availabilityStore: UserAvailabilityStore;
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
}

function serializeModels(modelIds: readonly string[]) {
  return [...new Set(modelIds)].map((modelId) => ({
    id: modelId,
    object: "model",
    created: MODEL_CREATED_AT,
    owned_by: modelId === "auto" ? "routemind" : (getModelRegistryEntry(modelId)?.provider ?? "routemind"),
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

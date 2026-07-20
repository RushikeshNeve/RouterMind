import type { PrismaClient } from "@prisma/client";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import type { ApiConfig } from "../config.js";
import { ensureSameWorkspace, requirePermission } from "../infrastructure/rbac.js";

const workspaceParamsSchema = z.object({
  workspaceId: z.string().min(1),
});

export function registerProviderCredentialRoutes(
  app: FastifyInstance,
  dependencies: {
    readonly config: ApiConfig;
    readonly prisma: PrismaClient;
  },
): void {
  const prisma = dependencies.prisma;
  const config = dependencies.config;

  // Metadata only -- never encryptedApiKey. This exists so the dashboard's
  // RouterConfig credential picker can list what's actually available to
  // point a config at, matching the same ownership rule router-config.ts
  // enforces server-side when a config is saved.
  app.get(
    "/v1/workspaces/:workspaceId/provider-credentials",
    { preHandler: requirePermission(prisma, "provider.manage", config) },
    async (request, reply) => {
      const params = workspaceParamsSchema.safeParse(request.params);
      if (!params.success) {
        return validation(reply);
      }
      if (!ensureSameWorkspace(request, params.data.workspaceId, reply)) {
        return reply;
      }

      const credentials = await prisma.providerCredential.findMany({
        where: { workspaceId: params.data.workspaceId, isEnabled: true },
        select: { id: true, provider: true, isEnabled: true, createdAt: true },
        orderBy: { createdAt: "asc" },
      });

      return reply.status(200).send({ credentials });
    },
  );
}

function validation(reply: FastifyReply) {
  return reply.status(400).send({ error: { message: "Invalid provider credentials request." } });
}

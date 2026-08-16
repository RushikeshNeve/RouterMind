import type { PrismaClient } from "@prisma/client";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import type { ApiConfig } from "../config.js";
import { writeAuditEvent } from "../infrastructure/audit.js";
import { ensureSameWorkspace, requirePermission } from "../infrastructure/rbac.js";

const workspaceParamsSchema = z.object({
  workspaceId: z.string().min(1),
});

const updateSchema = z.object({
  promptLoggingEnabled: z.boolean(),
});

export function registerPromptLoggingRoutes(
  app: FastifyInstance,
  dependencies: {
    readonly config: ApiConfig;
    readonly prisma: PrismaClient;
  },
): void {
  const prisma = dependencies.prisma;
  const config = dependencies.config;

  app.get(
    "/v1/workspaces/:workspaceId/prompt-logging",
    { preHandler: requirePermission(prisma, "dataRetention.read", config) },
    async (request, reply) => {
      const params = workspaceParamsSchema.safeParse(request.params);
      if (!params.success) {
        return validation(reply);
      }
      if (!ensureSameWorkspace(request, params.data.workspaceId, reply)) {
        return reply;
      }

      const workspace = await prisma.workspace.findUnique({
        where: { id: params.data.workspaceId },
        select: { promptLoggingEnabled: true },
      });
      if (!workspace) {
        return reply.status(404).send({ error: { message: "Workspace not found." } });
      }

      return reply.status(200).send({ promptLoggingEnabled: workspace.promptLoggingEnabled });
    },
  );

  app.patch(
    "/v1/workspaces/:workspaceId/prompt-logging",
    { preHandler: requirePermission(prisma, "dataRetention.manage", config) },
    async (request, reply) => {
      const params = workspaceParamsSchema.safeParse(request.params);
      const body = updateSchema.safeParse(request.body);
      if (!params.success || !body.success) {
        return validation(reply);
      }
      if (!ensureSameWorkspace(request, params.data.workspaceId, reply)) {
        return reply;
      }

      const existing = await prisma.workspace.findUnique({
        where: { id: params.data.workspaceId },
        select: { id: true },
      });
      if (!existing) {
        return reply.status(404).send({ error: { message: "Workspace not found." } });
      }

      const rbacContext = request.rbacContext!;
      const updated = await prisma.$transaction(async (tx) => {
        const row = await tx.workspace.update({
          where: { id: params.data.workspaceId },
          data: { promptLoggingEnabled: body.data.promptLoggingEnabled },
          select: { promptLoggingEnabled: true },
        });
        await writeAuditEvent(tx, {
          workspaceId: params.data.workspaceId,
          principalId: rbacContext.principalId,
          action: "workspace.update",
          targetType: "Workspace",
          targetId: params.data.workspaceId,
          metadata: { promptLoggingEnabled: row.promptLoggingEnabled },
        });
        return row;
      });

      return reply.status(200).send({ promptLoggingEnabled: updated.promptLoggingEnabled });
    },
  );
}

function validation(reply: FastifyReply) {
  return reply.status(400).send({ error: { message: "Invalid prompt-logging request." } });
}

import type { Prisma, PrismaClient } from "@prisma/client";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import type { ApiConfig } from "../config.js";
import { writeAuditEvent } from "../infrastructure/audit.js";
import { ensureSameWorkspace, requirePermission } from "../infrastructure/rbac.js";
import {
  PrismaWorkspaceService,
  type WorkspaceService,
} from "../infrastructure/workspace-service.js";

const roleSchema = z.enum(["Owner", "Admin", "Developer", "Viewer"]);

const serviceAccountCreateSchema = z.object({
  workspaceId: z.string().min(1),
  displayName: z.string().min(1),
  description: z.string().min(1).optional(),
  role: roleSchema,
});

const serviceAccountKeyCreateSchema = z.object({
  workspaceId: z.string().min(1),
  name: z.string().min(1),
});

const paramsSchema = z.object({
  serviceAccountId: z.string().min(1),
});

export function registerServiceAccountRoutes(
  app: FastifyInstance,
  dependencies: {
    readonly config: ApiConfig;
    readonly workspaceService: WorkspaceService;
    readonly prisma: PrismaClient;
  },
): void {
  const prisma = dependencies.prisma;
  const workspaceService = dependencies.workspaceService;

  function scopedWorkspaceService(tx: Prisma.TransactionClient): WorkspaceService {
    return workspaceService instanceof PrismaWorkspaceService
      ? new PrismaWorkspaceService(tx)
      : workspaceService;
  }

  app.post(
    "/v1/service-accounts",
    { preHandler: requirePermission(prisma, "workspace.manage") },
    async (request, reply) => {
      const body = serviceAccountCreateSchema.safeParse(request.body);
      if (!body.success) {
        return validation(reply);
      }
      if (!ensureSameWorkspace(request, body.data.workspaceId, reply)) {
        return reply;
      }

      const role = await prisma.role.findUnique({ where: { name: body.data.role } });
      if (!role) {
        return reply.status(400).send({
          error: { message: `Unknown role "${body.data.role}". Run seed-rbac.ts first.` },
        });
      }

      const rbacContext = request.rbacContext!;
      const { principal, serviceAccount } = await prisma.$transaction(async (tx) => {
        const createdPrincipal = await tx.principal.create({
          data: { type: "service_account", displayName: body.data.displayName },
        });
        const createdServiceAccount = await tx.serviceAccount.create({
          data: {
            principalId: createdPrincipal.id,
            createdByUserId: rbacContext.userId,
            description: body.data.description,
          },
        });
        await tx.membership.create({
          data: {
            workspaceId: body.data.workspaceId,
            principalId: createdPrincipal.id,
            role: body.data.role,
            roleId: role.id,
          },
        });
        await writeAuditEvent(tx, {
          workspaceId: body.data.workspaceId,
          principalId: rbacContext.principalId,
          action: "service_account.create",
          targetType: "ServiceAccount",
          targetId: createdServiceAccount.id,
          metadata: { displayName: body.data.displayName, role: body.data.role },
        });
        return { principal: createdPrincipal, serviceAccount: createdServiceAccount };
      });

      return reply.status(201).send({
        serviceAccount: {
          id: serviceAccount.id,
          principalId: principal.id,
          displayName: principal.displayName,
          description: serviceAccount.description,
          workspaceId: body.data.workspaceId,
          role: body.data.role,
          createdAt: serviceAccount.createdAt.toISOString(),
        },
      });
    },
  );

  app.post(
    "/v1/service-accounts/:serviceAccountId/keys",
    { preHandler: requirePermission(prisma, "apikey.create") },
    async (request, reply) => {
      const params = paramsSchema.safeParse(request.params);
      const body = serviceAccountKeyCreateSchema.safeParse(request.body);
      if (!params.success || !body.success) {
        return validation(reply);
      }
      if (!ensureSameWorkspace(request, body.data.workspaceId, reply)) {
        return reply;
      }

      const serviceAccount = await prisma.serviceAccount.findUnique({
        where: { id: params.data.serviceAccountId },
      });
      if (!serviceAccount) {
        return reply.status(404).send({ error: { message: "Service account not found." } });
      }

      const membership = await prisma.membership.findUnique({
        where: {
          workspaceId_principalId: {
            workspaceId: body.data.workspaceId,
            principalId: serviceAccount.principalId,
          },
        },
      });
      if (!membership) {
        return reply.status(404).send({
          error: { message: "Service account does not belong to this workspace." },
        });
      }

      const rbacContext = request.rbacContext!;
      // Same issuance path as a user's key (PrismaWorkspaceService.createApiKey /
      // InMemoryWorkspaceService.createApiKey) — only principalId differs.
      const record = await prisma.$transaction(async (tx) => {
        const created = await scopedWorkspaceService(tx).createApiKey({
          workspaceId: body.data.workspaceId,
          userId: serviceAccount.createdByUserId,
          principalId: serviceAccount.principalId,
          name: body.data.name,
          nodeEnv: dependencies.config.NODE_ENV,
        });
        await writeAuditEvent(tx, {
          workspaceId: body.data.workspaceId,
          principalId: rbacContext.principalId,
          action: "apikey.create",
          targetType: "ApiKey",
          targetId: created.id,
          metadata: { name: body.data.name, forServiceAccountId: serviceAccount.id },
        });
        return created;
      });

      return reply.status(201).send({
        apiKey: record.apiKey,
        workspaceId: record.workspaceId,
        name: record.name,
        createdAt: record.createdAt.toISOString(),
      });
    },
  );
}

function validation(reply: FastifyReply) {
  return reply.status(400).send({ error: { message: "Invalid service account request." } });
}

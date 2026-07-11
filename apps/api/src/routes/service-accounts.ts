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
  displayName: z.string().min(1),
  description: z.string().min(1).optional(),
  role: roleSchema,
});

const serviceAccountKeyCreateSchema = z.object({
  name: z.string().min(1),
});

const workspaceParamsSchema = z.object({
  workspaceId: z.string().min(1),
});

const serviceAccountParamsSchema = workspaceParamsSchema.extend({
  serviceAccountId: z.string().min(1),
});

const keyParamsSchema = serviceAccountParamsSchema.extend({
  keyId: z.string().min(1),
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
    "/v1/workspaces/:workspaceId/service-accounts",
    { preHandler: requirePermission(prisma, "workspace.manage", dependencies.config) },
    async (request, reply) => {
      const params = workspaceParamsSchema.safeParse(request.params);
      const body = serviceAccountCreateSchema.safeParse(request.body);
      if (!params.success || !body.success) {
        return validation(reply);
      }
      if (!ensureSameWorkspace(request, params.data.workspaceId, reply)) {
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
            workspaceId: params.data.workspaceId,
            principalId: createdPrincipal.id,
            role: body.data.role,
            roleId: role.id,
          },
        });
        await writeAuditEvent(tx, {
          workspaceId: params.data.workspaceId,
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
          workspaceId: params.data.workspaceId,
          role: body.data.role,
          createdByUserId: serviceAccount.createdByUserId,
          createdAt: serviceAccount.createdAt.toISOString(),
          keys: [],
        },
      });
    },
  );

  app.get(
    "/v1/workspaces/:workspaceId/service-accounts",
    { preHandler: requirePermission(prisma, "apikey.read", dependencies.config) },
    async (request, reply) => {
      const params = workspaceParamsSchema.safeParse(request.params);
      if (!params.success) {
        return validation(reply);
      }
      if (!ensureSameWorkspace(request, params.data.workspaceId, reply)) {
        return reply;
      }

      const memberships = await prisma.membership.findMany({
        where: { workspaceId: params.data.workspaceId, principal: { type: "service_account" } },
        include: {
          principal: { include: { serviceAccount: true } },
          roleRecord: { select: { name: true } },
        },
        orderBy: { createdAt: "asc" },
      });

      const principalIds = memberships.map((membership) => membership.principalId);
      const keys = await prisma.apiKey.findMany({
        where: { workspaceId: params.data.workspaceId, principalId: { in: principalIds } },
        select: { id: true, principalId: true, name: true, createdAt: true, isActive: true },
        orderBy: { createdAt: "desc" },
      });
      const keysByPrincipal = new Map<string, typeof keys>();
      for (const key of keys) {
        // The where clause only matches rows whose principalId is one of
        // `principalIds` (all non-null), so this is always populated here
        // -- the nullability is just ApiKey.principalId's column type.
        if (!key.principalId) continue;
        const list = keysByPrincipal.get(key.principalId) ?? [];
        list.push(key);
        keysByPrincipal.set(key.principalId, list);
      }

      return {
        serviceAccounts: memberships
          .filter((membership) => membership.principal.serviceAccount)
          .map((membership) => {
            const serviceAccount = membership.principal.serviceAccount!;
            return {
              id: serviceAccount.id,
              principalId: membership.principalId,
              displayName: membership.principal.displayName,
              description: serviceAccount.description,
              role: membership.roleRecord?.name ?? membership.role,
              createdByUserId: serviceAccount.createdByUserId,
              createdAt: serviceAccount.createdAt.toISOString(),
              keys: (keysByPrincipal.get(membership.principalId) ?? []).map((key) => ({
                id: key.id,
                name: key.name,
                createdAt: key.createdAt.toISOString(),
                isActive: key.isActive,
              })),
            };
          }),
      };
    },
  );

  app.post(
    "/v1/workspaces/:workspaceId/service-accounts/:serviceAccountId/keys",
    { preHandler: requirePermission(prisma, "apikey.create", dependencies.config) },
    async (request, reply) => {
      const params = serviceAccountParamsSchema.safeParse(request.params);
      const body = serviceAccountKeyCreateSchema.safeParse(request.body);
      if (!params.success || !body.success) {
        return validation(reply);
      }
      if (!ensureSameWorkspace(request, params.data.workspaceId, reply)) {
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
            workspaceId: params.data.workspaceId,
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
          workspaceId: params.data.workspaceId,
          userId: serviceAccount.createdByUserId,
          principalId: serviceAccount.principalId,
          name: body.data.name,
          nodeEnv: dependencies.config.NODE_ENV,
        });
        await writeAuditEvent(tx, {
          workspaceId: params.data.workspaceId,
          principalId: rbacContext.principalId,
          action: "apikey.create",
          targetType: "ApiKey",
          targetId: created.id,
          metadata: { name: body.data.name, forServiceAccountId: serviceAccount.id },
        });
        return created;
      });

      return reply.status(201).send({
        id: record.id,
        apiKey: record.apiKey,
        workspaceId: record.workspaceId,
        name: record.name,
        createdAt: record.createdAt.toISOString(),
      });
    },
  );

  app.delete(
    "/v1/workspaces/:workspaceId/service-accounts/:serviceAccountId/keys/:keyId",
    { preHandler: requirePermission(prisma, "apikey.delete", dependencies.config) },
    async (request, reply) => {
      const params = keyParamsSchema.safeParse(request.params);
      if (!params.success) {
        return validation(reply);
      }
      if (!ensureSameWorkspace(request, params.data.workspaceId, reply)) {
        return reply;
      }

      const serviceAccount = await prisma.serviceAccount.findUnique({
        where: { id: params.data.serviceAccountId },
      });
      if (!serviceAccount) {
        return reply.status(404).send({ error: { message: "Service account not found." } });
      }

      const key = await prisma.apiKey.findUnique({ where: { id: params.data.keyId } });
      if (
        !key ||
        key.workspaceId !== params.data.workspaceId ||
        key.principalId !== serviceAccount.principalId
      ) {
        return reply.status(404).send({ error: { message: "Key not found." } });
      }
      if (!key.isActive) {
        return reply.status(409).send({ error: { message: "Key is already revoked." } });
      }

      const rbacContext = request.rbacContext!;
      await prisma.$transaction(async (tx) => {
        await tx.apiKey.update({ where: { id: key.id }, data: { isActive: false } });
        await writeAuditEvent(tx, {
          workspaceId: params.data.workspaceId,
          principalId: rbacContext.principalId,
          action: "apikey.delete",
          targetType: "ApiKey",
          targetId: key.id,
          metadata: { name: key.name, forServiceAccountId: serviceAccount.id },
        });
      });

      return { revoked: true };
    },
  );
}

function validation(reply: FastifyReply) {
  return reply.status(400).send({ error: { message: "Invalid service account request." } });
}

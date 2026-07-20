import type { PrismaClient } from "@prisma/client";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import type { ApiConfig } from "../config.js";
import { writeAuditEvent } from "../infrastructure/audit.js";
import {
  ensureSameWorkspace,
  requireOrganizationPermission,
  requirePermission,
} from "../infrastructure/rbac.js";

const providerSchema = z.enum(["openai", "anthropic", "gemini", "groq"]);

const createSchema = z.object({
  provider: providerSchema,
  model: z.string().min(1),
  fallbackModel: z.string().min(1).optional(),
  credentialId: z.string().min(1).optional(),
});

const updateSchema = z.object({
  provider: providerSchema.optional(),
  model: z.string().min(1).optional(),
  fallbackModel: z.string().min(1).nullable().optional(),
  credentialId: z.string().min(1).nullable().optional(),
});

const workspaceParamsSchema = z.object({
  workspaceId: z.string().min(1),
});

const organizationParamsSchema = z.object({
  organizationId: z.string().min(1),
});

export function registerRouterConfigRoutes(
  app: FastifyInstance,
  dependencies: {
    readonly config: ApiConfig;
    readonly prisma: PrismaClient;
  },
): void {
  const prisma = dependencies.prisma;
  const config = dependencies.config;

  // Fetches the exact ProviderCredential a scope is trying to point its
  // RouterConfig at, and confirms it's actually usable for that save --
  // enabled, matching the RouterConfig's own `provider`, and owned by the
  // scope doing the saving (this workspace, or a workspace in this org).
  // Returns an error message on failure, undefined when the credential
  // checks out.
  async function validateCredential(options: {
    readonly credentialId: string;
    readonly provider: string;
    readonly scope:
      | { readonly type: "workspace"; readonly workspaceId: string }
      | {
          readonly type: "org";
          readonly organizationId: string;
        };
  }): Promise<string | undefined> {
    const credential = await prisma.providerCredential.findUnique({
      where: { id: options.credentialId },
      select: {
        provider: true,
        isEnabled: true,
        workspaceId: true,
        workspace: { select: { organizationId: true } },
      },
    });

    if (!credential || !credential.isEnabled) {
      return "credentialId does not reference an existing, enabled provider credential.";
    }
    if (credential.provider !== options.provider) {
      return `credentialId belongs to provider "${credential.provider}", not "${options.provider}".`;
    }
    if (options.scope.type === "workspace") {
      if (credential.workspaceId !== options.scope.workspaceId) {
        return "credentialId does not belong to this workspace.";
      }
      return undefined;
    }
    if (
      !credential.workspaceId ||
      credential.workspace?.organizationId !== options.scope.organizationId
    ) {
      return "credentialId does not belong to a workspace in this organization.";
    }
    return undefined;
  }

  // ---- Workspace-scoped ----

  app.post(
    "/v1/workspaces/:workspaceId/router-config",
    { preHandler: requirePermission(prisma, "router.manage", config) },
    async (request, reply) => {
      const params = workspaceParamsSchema.safeParse(request.params);
      const body = createSchema.safeParse(request.body);
      if (!params.success || !body.success) {
        return validation(reply);
      }
      if (!ensureSameWorkspace(request, params.data.workspaceId, reply)) {
        return reply;
      }

      const existing = await prisma.routerConfig.findUnique({
        where: { scopeType_scopeId: { scopeType: "workspace", scopeId: params.data.workspaceId } },
      });
      if (existing) {
        return reply.status(409).send({
          error: {
            message: "A router config already exists for this workspace. Use PATCH to update it.",
          },
        });
      }

      if (body.data.credentialId) {
        const error = await validateCredential({
          credentialId: body.data.credentialId,
          provider: body.data.provider,
          scope: { type: "workspace", workspaceId: params.data.workspaceId },
        });
        if (error) {
          return reply.status(400).send({ error: { message: error } });
        }
      }

      const rbacContext = request.rbacContext!;
      const created = await prisma.$transaction(async (tx) => {
        const row = await tx.routerConfig.create({
          data: {
            scopeType: "workspace",
            scopeId: params.data.workspaceId,
            provider: body.data.provider,
            model: body.data.model,
            fallbackModel: body.data.fallbackModel,
            credentialId: body.data.credentialId,
          },
        });
        await writeAuditEvent(tx, {
          workspaceId: params.data.workspaceId,
          principalId: rbacContext.principalId,
          action: "router_config.create",
          targetType: "RouterConfig",
          targetId: row.id,
          metadata: { provider: row.provider, model: row.model, scopeType: "workspace" },
        });
        return row;
      });

      return reply.status(201).send(created);
    },
  );

  app.get(
    "/v1/workspaces/:workspaceId/router-config",
    { preHandler: requirePermission(prisma, "router.read", config) },
    async (request, reply) => {
      const params = workspaceParamsSchema.safeParse(request.params);
      if (!params.success) {
        return validation(reply);
      }
      if (!ensureSameWorkspace(request, params.data.workspaceId, reply)) {
        return reply;
      }

      const row = await prisma.routerConfig.findUnique({
        where: { scopeType_scopeId: { scopeType: "workspace", scopeId: params.data.workspaceId } },
      });
      if (!row) {
        return reply
          .status(404)
          .send({ error: { message: "No router config exists for this workspace." } });
      }

      return reply.status(200).send(row);
    },
  );

  app.patch(
    "/v1/workspaces/:workspaceId/router-config",
    { preHandler: requirePermission(prisma, "router.manage", config) },
    async (request, reply) => {
      const params = workspaceParamsSchema.safeParse(request.params);
      const body = updateSchema.safeParse(request.body);
      if (!params.success || !body.success) {
        return validation(reply);
      }
      if (!ensureSameWorkspace(request, params.data.workspaceId, reply)) {
        return reply;
      }

      const existing = await prisma.routerConfig.findUnique({
        where: { scopeType_scopeId: { scopeType: "workspace", scopeId: params.data.workspaceId } },
      });
      if (!existing) {
        return reply
          .status(404)
          .send({ error: { message: "No router config exists for this workspace." } });
      }

      const nextProvider = body.data.provider ?? existing.provider;
      const nextCredentialId =
        body.data.credentialId === null ? null : (body.data.credentialId ?? existing.credentialId);

      if (nextCredentialId) {
        const error = await validateCredential({
          credentialId: nextCredentialId,
          provider: nextProvider,
          scope: { type: "workspace", workspaceId: params.data.workspaceId },
        });
        if (error) {
          return reply.status(400).send({ error: { message: error } });
        }
      }

      const rbacContext = request.rbacContext!;
      const updated = await prisma.$transaction(async (tx) => {
        const row = await tx.routerConfig.update({
          where: { id: existing.id },
          data: {
            provider: nextProvider,
            model: body.data.model ?? existing.model,
            fallbackModel:
              body.data.fallbackModel === null
                ? null
                : (body.data.fallbackModel ?? existing.fallbackModel),
            credentialId: nextCredentialId,
          },
        });
        await writeAuditEvent(tx, {
          workspaceId: params.data.workspaceId,
          principalId: rbacContext.principalId,
          action: "router_config.update",
          targetType: "RouterConfig",
          targetId: row.id,
          metadata: { provider: row.provider, model: row.model, scopeType: "workspace" },
        });
        return row;
      });

      return reply.status(200).send(updated);
    },
  );

  app.delete(
    "/v1/workspaces/:workspaceId/router-config",
    { preHandler: requirePermission(prisma, "router.manage", config) },
    async (request, reply) => {
      const params = workspaceParamsSchema.safeParse(request.params);
      if (!params.success) {
        return validation(reply);
      }
      if (!ensureSameWorkspace(request, params.data.workspaceId, reply)) {
        return reply;
      }

      const existing = await prisma.routerConfig.findUnique({
        where: { scopeType_scopeId: { scopeType: "workspace", scopeId: params.data.workspaceId } },
      });
      if (!existing) {
        return reply
          .status(404)
          .send({ error: { message: "No router config exists for this workspace." } });
      }

      const rbacContext = request.rbacContext!;
      await prisma.$transaction(async (tx) => {
        await tx.routerConfig.delete({ where: { id: existing.id } });
        await writeAuditEvent(tx, {
          workspaceId: params.data.workspaceId,
          principalId: rbacContext.principalId,
          action: "router_config.delete",
          targetType: "RouterConfig",
          targetId: existing.id,
          metadata: { provider: existing.provider, model: existing.model, scopeType: "workspace" },
        });
      });

      return reply.status(200).send({ deleted: true });
    },
  );

  // ---- Org-scoped ----

  app.post(
    "/v1/organizations/:organizationId/router-config",
    { preHandler: requireOrganizationPermission(prisma, "router.manage", config) },
    async (request, reply) => {
      const params = organizationParamsSchema.safeParse(request.params);
      const body = createSchema.safeParse(request.body);
      if (!params.success || !body.success) {
        return validation(reply);
      }

      const existing = await prisma.routerConfig.findUnique({
        where: { scopeType_scopeId: { scopeType: "org", scopeId: params.data.organizationId } },
      });
      if (existing) {
        return reply.status(409).send({
          error: {
            message:
              "A router config already exists for this organization. Use PATCH to update it.",
          },
        });
      }

      if (body.data.credentialId) {
        const error = await validateCredential({
          credentialId: body.data.credentialId,
          provider: body.data.provider,
          scope: { type: "org", organizationId: params.data.organizationId },
        });
        if (error) {
          return reply.status(400).send({ error: { message: error } });
        }
      }

      const orgContext = request.rbacOrgContext!;
      const created = await prisma.$transaction(async (tx) => {
        const row = await tx.routerConfig.create({
          data: {
            scopeType: "org",
            scopeId: params.data.organizationId,
            provider: body.data.provider,
            model: body.data.model,
            fallbackModel: body.data.fallbackModel,
            credentialId: body.data.credentialId,
          },
        });
        await writeAuditEvent(tx, {
          workspaceId: orgContext.workspaceId,
          principalId: orgContext.principalId,
          action: "router_config.create",
          targetType: "RouterConfig",
          targetId: row.id,
          metadata: {
            provider: row.provider,
            model: row.model,
            scopeType: "org",
            organizationId: params.data.organizationId,
          },
        });
        return row;
      });

      return reply.status(201).send(created);
    },
  );

  app.get(
    "/v1/organizations/:organizationId/router-config",
    { preHandler: requireOrganizationPermission(prisma, "router.read", config) },
    async (request, reply) => {
      const params = organizationParamsSchema.safeParse(request.params);
      if (!params.success) {
        return validation(reply);
      }

      const row = await prisma.routerConfig.findUnique({
        where: { scopeType_scopeId: { scopeType: "org", scopeId: params.data.organizationId } },
      });
      if (!row) {
        return reply
          .status(404)
          .send({ error: { message: "No router config exists for this organization." } });
      }

      return reply.status(200).send(row);
    },
  );

  app.patch(
    "/v1/organizations/:organizationId/router-config",
    { preHandler: requireOrganizationPermission(prisma, "router.manage", config) },
    async (request, reply) => {
      const params = organizationParamsSchema.safeParse(request.params);
      const body = updateSchema.safeParse(request.body);
      if (!params.success || !body.success) {
        return validation(reply);
      }

      const existing = await prisma.routerConfig.findUnique({
        where: { scopeType_scopeId: { scopeType: "org", scopeId: params.data.organizationId } },
      });
      if (!existing) {
        return reply
          .status(404)
          .send({ error: { message: "No router config exists for this organization." } });
      }

      const nextProvider = body.data.provider ?? existing.provider;
      const nextCredentialId =
        body.data.credentialId === null ? null : (body.data.credentialId ?? existing.credentialId);

      if (nextCredentialId) {
        const error = await validateCredential({
          credentialId: nextCredentialId,
          provider: nextProvider,
          scope: { type: "org", organizationId: params.data.organizationId },
        });
        if (error) {
          return reply.status(400).send({ error: { message: error } });
        }
      }

      const orgContext = request.rbacOrgContext!;
      const updated = await prisma.$transaction(async (tx) => {
        const row = await tx.routerConfig.update({
          where: { id: existing.id },
          data: {
            provider: nextProvider,
            model: body.data.model ?? existing.model,
            fallbackModel:
              body.data.fallbackModel === null
                ? null
                : (body.data.fallbackModel ?? existing.fallbackModel),
            credentialId: nextCredentialId,
          },
        });
        await writeAuditEvent(tx, {
          workspaceId: orgContext.workspaceId,
          principalId: orgContext.principalId,
          action: "router_config.update",
          targetType: "RouterConfig",
          targetId: row.id,
          metadata: {
            provider: row.provider,
            model: row.model,
            scopeType: "org",
            organizationId: params.data.organizationId,
          },
        });
        return row;
      });

      return reply.status(200).send(updated);
    },
  );

  app.delete(
    "/v1/organizations/:organizationId/router-config",
    { preHandler: requireOrganizationPermission(prisma, "router.manage", config) },
    async (request, reply) => {
      const params = organizationParamsSchema.safeParse(request.params);
      if (!params.success) {
        return validation(reply);
      }

      const existing = await prisma.routerConfig.findUnique({
        where: { scopeType_scopeId: { scopeType: "org", scopeId: params.data.organizationId } },
      });
      if (!existing) {
        return reply
          .status(404)
          .send({ error: { message: "No router config exists for this organization." } });
      }

      const orgContext = request.rbacOrgContext!;
      await prisma.$transaction(async (tx) => {
        await tx.routerConfig.delete({ where: { id: existing.id } });
        await writeAuditEvent(tx, {
          workspaceId: orgContext.workspaceId,
          principalId: orgContext.principalId,
          action: "router_config.delete",
          targetType: "RouterConfig",
          targetId: existing.id,
          metadata: {
            provider: existing.provider,
            model: existing.model,
            scopeType: "org",
            organizationId: params.data.organizationId,
          },
        });
      });

      return reply.status(200).send({ deleted: true });
    },
  );
}

function validation(reply: FastifyReply) {
  return reply.status(400).send({ error: { message: "Invalid router config request." } });
}

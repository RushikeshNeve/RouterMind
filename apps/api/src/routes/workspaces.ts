import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import type { ApiConfig } from "../config.js";
import {
  hasWorkspacePermission,
  type WorkspacePermission,
  type WorkspaceRole,
  type WorkspaceService,
} from "../infrastructure/workspace-service.js";

const roleSchema = z.enum(["owner", "admin", "developer", "viewer"]);

const workspaceCreateSchema = z.object({
  name: z.string().min(1),
  slug: z.string().min(1).optional(),
  ownerUserId: z.string().min(1).optional(),
});

const workspacePatchSchema = z.object({
  name: z.string().min(1).optional(),
  slug: z.string().min(1).optional(),
  actorUserId: z.string().min(1).optional(),
});

const memberCreateSchema = z.object({
  userId: z.string().min(1),
  role: roleSchema,
  actorUserId: z.string().min(1).optional(),
});

const memberPatchSchema = z.object({
  role: roleSchema,
  actorUserId: z.string().min(1).optional(),
});

const apiKeyCreateSchema = z.object({
  userId: z.string().min(1),
  name: z.string().min(1),
});

const paramsSchema = z.object({
  workspaceId: z.string().min(1),
});

const memberParamsSchema = paramsSchema.extend({
  memberId: z.string().min(1),
});

export function registerWorkspaceRoutes(
  app: FastifyInstance,
  dependencies: {
    readonly config: ApiConfig;
    readonly workspaceService: WorkspaceService;
  },
): void {
  const workspaceService = dependencies.workspaceService;

  app.post("/v1/workspaces", async (request, reply) => {
    const parsed = workspaceCreateSchema.safeParse(request.body);
    if (!parsed.success) {
      return validation(reply);
    }
    const workspace = await workspaceService.createWorkspace({
      name: parsed.data.name,
      slug: parsed.data.slug,
      ownerUserId: parsed.data.ownerUserId ?? "dev-user",
    });
    return reply.status(201).send({ workspace: serializeWorkspace(workspace) });
  });

  app.get("/v1/workspaces", async (request) => {
    const query = z.object({ userId: z.string().min(1).optional() }).safeParse(request.query);
    return {
      workspaces: (
        await workspaceService.listWorkspaces(query.success ? query.data.userId : undefined)
      ).map(serializeWorkspace),
    };
  });

  app.get("/v1/workspaces/:workspaceId", async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    if (!params.success) {
      return validation(reply);
    }
    const workspace = await workspaceService.getWorkspace(params.data.workspaceId);
    if (!workspace) {
      return reply.status(404).send({ error: { message: "Workspace not found." } });
    }
    return { workspace: serializeWorkspace(workspace) };
  });

  app.patch("/v1/workspaces/:workspaceId", async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    const body = workspacePatchSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return validation(reply);
    }
    if (
      !(await assertPermission(
        workspaceService,
        params.data.workspaceId,
        body.data.actorUserId,
        "manage_members",
        reply,
      ))
    ) {
      return reply;
    }
    const workspace = await workspaceService.updateWorkspace(params.data.workspaceId, body.data);
    if (!workspace) {
      return reply.status(404).send({ error: { message: "Workspace not found." } });
    }
    return { workspace: serializeWorkspace(workspace) };
  });

  app.post("/v1/workspaces/:workspaceId/members", async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    const body = memberCreateSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return validation(reply);
    }
    if (
      !(await assertPermission(
        workspaceService,
        params.data.workspaceId,
        body.data.actorUserId,
        "manage_members",
        reply,
      ))
    ) {
      return reply;
    }
    const member = await workspaceService.addMember({
      workspaceId: params.data.workspaceId,
      userId: body.data.userId,
      role: body.data.role,
    });
    return reply.status(201).send({ member: serializeMember(member) });
  });

  app.get("/v1/workspaces/:workspaceId/members", async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    if (!params.success) {
      return validation(reply);
    }
    return {
      members: (await workspaceService.listMembers(params.data.workspaceId)).map(serializeMember),
    };
  });

  app.patch("/v1/workspaces/:workspaceId/members/:memberId", async (request, reply) => {
    const params = memberParamsSchema.safeParse(request.params);
    const body = memberPatchSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return validation(reply);
    }
    if (
      !(await assertPermission(
        workspaceService,
        params.data.workspaceId,
        body.data.actorUserId,
        "manage_members",
        reply,
      ))
    ) {
      return reply;
    }
    const member = await workspaceService.updateMember(params.data.memberId, body.data.role);
    if (!member) {
      return reply.status(404).send({ error: { message: "Workspace member not found." } });
    }
    return { member: serializeMember(member) };
  });

  app.delete("/v1/workspaces/:workspaceId/members/:memberId", async (request, reply) => {
    const params = memberParamsSchema.safeParse(request.params);
    const query = z.object({ actorUserId: z.string().min(1).optional() }).safeParse(request.query);
    if (!params.success || !query.success) {
      return validation(reply);
    }
    if (
      !(await assertPermission(
        workspaceService,
        params.data.workspaceId,
        query.data.actorUserId,
        "manage_members",
        reply,
      ))
    ) {
      return reply;
    }
    const deleted = await workspaceService.removeMember(params.data.memberId);
    if (!deleted) {
      return reply.status(404).send({ error: { message: "Workspace member not found." } });
    }
    return { deleted: true };
  });

  app.post("/v1/workspaces/:workspaceId/api-keys", async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    const body = apiKeyCreateSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return validation(reply);
    }
    const member = await workspaceService.getMember(params.data.workspaceId, body.data.userId);
    if (!hasWorkspacePermission(member?.role, "manage_api_keys")) {
      return reply.status(403).send({ error: { message: "Role cannot manage API keys." } });
    }
    const record = await workspaceService.createApiKey({
      workspaceId: params.data.workspaceId,
      userId: body.data.userId,
      name: body.data.name,
      nodeEnv: dependencies.config.NODE_ENV,
    });
    return reply.status(201).send({
      apiKey: record.apiKey,
      workspaceId: record.workspaceId,
      name: record.name,
      createdAt: record.createdAt.toISOString(),
    });
  });
}

async function assertPermission(
  workspaceService: WorkspaceService,
  workspaceId: string,
  actorUserId: string | undefined,
  permission: WorkspacePermission,
  reply: FastifyReply,
): Promise<boolean> {
  if (!actorUserId) {
    return true;
  }
  const member = await workspaceService.getMember(workspaceId, actorUserId);
  if (!hasWorkspacePermission(member?.role, permission)) {
    void reply.status(403).send({ error: { message: "Workspace role is not permitted." } });
    return false;
  }
  return true;
}

function serializeWorkspace(workspace: {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}) {
  return {
    ...workspace,
    createdAt: workspace.createdAt.toISOString(),
    updatedAt: workspace.updatedAt.toISOString(),
  };
}

function serializeMember(member: {
  readonly id: string;
  readonly workspaceId: string;
  readonly userId: string;
  readonly role: WorkspaceRole;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}) {
  return {
    ...member,
    createdAt: member.createdAt.toISOString(),
    updatedAt: member.updatedAt.toISOString(),
  };
}

function validation(reply: FastifyReply) {
  return reply.status(400).send({ error: { message: "Invalid workspace request." } });
}

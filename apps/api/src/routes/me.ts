import type { PrismaClient } from "@prisma/client";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import type { ApiConfig } from "../config.js";
import { resolveIdentity, resolveMembership } from "../infrastructure/rbac.js";

const paramsSchema = z.object({ workspaceId: z.string().min(1) });

/**
 * Lets the dashboard ask "what can I do here?" once on load, instead of
 * discovering permissions by trial-and-error 403s on every action. Purely
 * a read of the same Membership/Role/RolePermission rows requirePermission
 * already checks per-route — this changes no authorization behavior, it
 * just exposes it for the UI to gate on.
 */
export function registerMeRoutes(
  app: FastifyInstance,
  dependencies: {
    readonly config: ApiConfig;
    readonly prisma: PrismaClient;
  },
): void {
  const { config, prisma } = dependencies;

  app.get("/v1/workspaces/:workspaceId/me", async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    if (!params.success) {
      return validation(reply);
    }

    const identity = await resolveIdentity(prisma, request, config);
    if (!identity || identity.workspaceId !== params.data.workspaceId) {
      return reply
        .status(401)
        .send({ error: { message: "No valid session or API key for this workspace." } });
    }

    const context = await resolveMembership(prisma, identity);
    if (!context) {
      return reply.status(403).send({ error: { message: "Not a member of this workspace." } });
    }

    const [role, rolePermissions] = await Promise.all([
      prisma.role.findUnique({ where: { id: context.roleId } }),
      prisma.rolePermission.findMany({
        where: { roleId: context.roleId },
        select: { permission: true },
      }),
    ]);

    return {
      userId: context.userId,
      principalId: context.principalId,
      workspaceId: context.workspaceId,
      role: role ? { id: role.id, name: role.name } : null,
      permissions: rolePermissions.map((rolePermission) => rolePermission.permission),
    };
  });
}

function validation(reply: FastifyReply) {
  return reply.status(400).send({ error: { message: "Invalid request." } });
}

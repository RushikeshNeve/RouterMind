import type { PrismaClient } from "@prisma/client";
import type { FastifyReply, FastifyRequest } from "fastify";

import type { ApiConfig } from "../config.js";
import { hashApiKey } from "../security/api-key.js";
import { SESSION_COOKIE_NAME, verifySessionToken } from "./session.js";

export interface RbacContext {
  readonly userId: string;
  readonly principalId: string;
  readonly workspaceId: string;
  readonly roleId: string;
}

declare module "fastify" {
  interface FastifyRequest {
    rbacContext?: RbacContext;
  }
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

async function sendUnauthorized(reply: FastifyReply): Promise<void> {
  await reply.status(401).send({ error: { message: "A valid API key is required." } });
}

async function sendForbidden(reply: FastifyReply): Promise<void> {
  await reply
    .status(403)
    .send({ error: { message: "Role is not permitted to perform this action." } });
}

function extractWorkspaceIdParam(request: FastifyRequest): string | undefined {
  const params = request.params as { workspaceId?: unknown } | undefined;
  return typeof params?.workspaceId === "string" ? params.workspaceId : undefined;
}

/**
 * Resolves the caller's Principal/Workspace/Role directly from ApiKey and
 * Membership, independent of authenticator.ts. On success, attaches the
 * resolved identity to `request.rbacContext` so route handlers can use it
 * instead of trusting a caller-supplied actorUserId/userId body param.
 *
 * Machine callers authenticate with an API key. The dashboard has no API
 * key (by design — pasting one into a browser is the wrong trust model for
 * a human, see auth.ts) so it authenticates with the `routemind_session`
 * cookie instead. Since a session isn't pinned to one workspace, the target
 * workspace is read from the route's `:workspaceId` param and Membership is
 * looked up against that — every route this guards already has that param.
 */
export function requirePermission(
  prisma: PrismaClient,
  permission: string,
  config: ApiConfig,
): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const apiKey = extractApiKey(request);

    if (apiKey) {
      const keyRecord = await prisma.apiKey.findUnique({
        where: { keyHash: hashApiKey(apiKey) },
        select: { isActive: true, userId: true, principalId: true, workspaceId: true },
      });

      if (!keyRecord || !keyRecord.isActive || !keyRecord.principalId || !keyRecord.workspaceId) {
        await sendUnauthorized(reply);
        return;
      }

      const membership = await prisma.membership.findUnique({
        where: {
          workspaceId_principalId: {
            workspaceId: keyRecord.workspaceId,
            principalId: keyRecord.principalId,
          },
        },
        select: { roleId: true },
      });

      if (!membership?.roleId) {
        await sendForbidden(reply);
        return;
      }

      const rolePermission = await prisma.rolePermission.findUnique({
        where: { roleId_permission: { roleId: membership.roleId, permission } },
      });

      if (!rolePermission) {
        await sendForbidden(reply);
        return;
      }

      request.rbacContext = {
        userId: keyRecord.userId,
        principalId: keyRecord.principalId,
        workspaceId: keyRecord.workspaceId,
        roleId: membership.roleId,
      };
      return;
    }

    const sessionCookie = request.cookies[SESSION_COOKIE_NAME];
    const session = sessionCookie
      ? verifySessionToken(sessionCookie, config.SESSION_SECRET)
      : undefined;
    if (!session) {
      await sendUnauthorized(reply);
      return;
    }

    const targetWorkspaceId = extractWorkspaceIdParam(request);
    if (!targetWorkspaceId) {
      await sendUnauthorized(reply);
      return;
    }

    const membership = await prisma.membership.findUnique({
      where: {
        workspaceId_principalId: {
          workspaceId: targetWorkspaceId,
          principalId: session.principalId,
        },
      },
      select: { roleId: true },
    });

    if (!membership?.roleId) {
      await sendForbidden(reply);
      return;
    }

    const rolePermission = await prisma.rolePermission.findUnique({
      where: { roleId_permission: { roleId: membership.roleId, permission } },
    });

    if (!rolePermission) {
      await sendForbidden(reply);
      return;
    }

    request.rbacContext = {
      userId: session.userId,
      principalId: session.principalId,
      workspaceId: targetWorkspaceId,
      roleId: membership.roleId,
    };
  };
}

/**
 * requirePermission only confirms the caller's role grants the permission
 * within THEIR OWN workspace — it doesn't know which workspace the route
 * targets. Without this check, a valid API key for workspace A could act
 * on any workspace B's resources as long as the caller's role in A happens
 * to carry the required permission.
 */
export function ensureSameWorkspace(
  request: FastifyRequest,
  targetWorkspaceId: string,
  reply: FastifyReply,
): boolean {
  if (request.rbacContext?.workspaceId !== targetWorkspaceId) {
    void reply
      .status(403)
      .send({ error: { message: "API key does not belong to this workspace." } });
    return false;
  }
  return true;
}

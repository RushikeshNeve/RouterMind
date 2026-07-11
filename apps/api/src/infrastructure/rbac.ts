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

export interface ResolvedIdentity {
  readonly userId: string;
  readonly principalId: string;
  readonly workspaceId: string;
}

/**
 * Resolves *who* is calling and *which workspace* they're calling about,
 * without yet checking whether they're actually a member of it. Shared by
 * `requirePermission` and any route (like `/v1/workspaces/:id/me`) that
 * needs the caller's identity but isn't gating on one fixed permission.
 *
 * Machine callers authenticate with an API key, which is itself pinned to
 * one workspace. The dashboard has no API key (by design — pasting one into
 * a browser is the wrong trust model for a human, see auth.ts) so it
 * authenticates with the `routemind_session` cookie instead; since a
 * session isn't pinned to one workspace, the target workspace is read from
 * the route's `:workspaceId` param.
 */
export async function resolveIdentity(
  prisma: PrismaClient,
  request: FastifyRequest,
  config: ApiConfig,
): Promise<ResolvedIdentity | undefined> {
  const apiKey = extractApiKey(request);
  if (apiKey) {
    const keyRecord = await prisma.apiKey.findUnique({
      where: { keyHash: hashApiKey(apiKey) },
      select: { isActive: true, userId: true, principalId: true, workspaceId: true },
    });

    if (!keyRecord || !keyRecord.isActive || !keyRecord.principalId || !keyRecord.workspaceId) {
      return undefined;
    }

    return {
      userId: keyRecord.userId,
      principalId: keyRecord.principalId,
      workspaceId: keyRecord.workspaceId,
    };
  }

  const sessionCookie = request.cookies[SESSION_COOKIE_NAME];
  const session = sessionCookie
    ? verifySessionToken(sessionCookie, config.SESSION_SECRET)
    : undefined;
  if (!session) {
    return undefined;
  }

  const targetWorkspaceId = extractWorkspaceIdParam(request);
  if (!targetWorkspaceId) {
    return undefined;
  }

  return {
    userId: session.userId,
    principalId: session.principalId,
    workspaceId: targetWorkspaceId,
  };
}

/**
 * Given a resolved identity, looks up their Membership/Role in that
 * workspace. Returns undefined if they're not a member, or a member with
 * no role assigned yet.
 */
export async function resolveMembership(
  prisma: PrismaClient,
  identity: ResolvedIdentity,
): Promise<RbacContext | undefined> {
  const membership = await prisma.membership.findUnique({
    where: {
      workspaceId_principalId: {
        workspaceId: identity.workspaceId,
        principalId: identity.principalId,
      },
    },
    select: { roleId: true },
  });

  if (!membership?.roleId) {
    return undefined;
  }

  return { ...identity, roleId: membership.roleId };
}

/**
 * Resolves the caller's Principal/Workspace/Role, then confirms their role
 * grants `permission`. On success, attaches the resolved identity to
 * `request.rbacContext` so route handlers can use it instead of trusting a
 * caller-supplied actorUserId/userId body param.
 */
export function requirePermission(
  prisma: PrismaClient,
  permission: string,
  config: ApiConfig,
): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const identity = await resolveIdentity(prisma, request, config);
    if (!identity) {
      await sendUnauthorized(reply);
      return;
    }

    const context = await resolveMembership(prisma, identity);
    if (!context) {
      await sendForbidden(reply);
      return;
    }

    const rolePermission = await prisma.rolePermission.findUnique({
      where: { roleId_permission: { roleId: context.roleId, permission } },
    });

    if (!rolePermission) {
      await sendForbidden(reply);
      return;
    }

    request.rbacContext = context;
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

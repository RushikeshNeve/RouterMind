import type { PrismaClient } from "@prisma/client";
import type { FastifyReply, FastifyRequest } from "fastify";

import { hashApiKey } from "../security/api-key.js";

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

/**
 * Not wired into any route yet — this is a standalone, testable preHandler.
 * It resolves the caller's Principal/Workspace/Role directly from ApiKey and
 * Membership, independent of authenticator.ts, so it can be adopted by
 * routes later without requiring changes to the existing auth flow.
 */
export function requirePermission(
  prisma: PrismaClient,
  permission: string,
): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const apiKey = extractApiKey(request);
    if (!apiKey) {
      await sendUnauthorized(reply);
      return;
    }

    const keyRecord = await prisma.apiKey.findUnique({
      where: { keyHash: hashApiKey(apiKey) },
      select: { isActive: true, principalId: true, workspaceId: true },
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
  };
}

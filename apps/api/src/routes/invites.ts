import { randomBytes } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import type { ApiConfig } from "../config.js";
import { writeAuditEvent } from "../infrastructure/audit.js";
import type { EmailSender } from "../infrastructure/email-sender.js";
import { ensureSameWorkspace, requirePermission } from "../infrastructure/rbac.js";
import { hashApiKey } from "../security/api-key.js";

const INVITE_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// Lowercase, matching the existing member-management routes' role casing
// (workspaces.ts memberCreateSchema) — this is the role shown/chosen in the
// dashboard's member table, distinct from service-accounts.ts's capitalized
// Role.name casing, which this resolves to internally.
const roleSchema = z.enum(["owner", "admin", "developer", "viewer"]);

const inviteCreateSchema = z.object({
  email: z.string().email(),
  role: roleSchema,
});

const paramsSchema = z.object({ workspaceId: z.string().min(1) });
const inviteParamsSchema = paramsSchema.extend({ inviteId: z.string().min(1) });

export function registerInviteRoutes(
  app: FastifyInstance,
  dependencies: {
    readonly config: ApiConfig;
    readonly prisma: PrismaClient;
    readonly emailSender: EmailSender;
  },
): void {
  const { config, prisma, emailSender } = dependencies;

  app.post(
    "/v1/workspaces/:workspaceId/invites",
    { preHandler: requirePermission(prisma, "workspace.manage", config) },
    async (request, reply) => {
      const params = paramsSchema.safeParse(request.params);
      const body = inviteCreateSchema.safeParse(request.body);
      if (!params.success || !body.success) {
        return validation(reply);
      }
      if (!ensureSameWorkspace(request, params.data.workspaceId, reply)) {
        return reply;
      }

      const roleName = capitalize(body.data.role);
      const role = await prisma.role.findUnique({ where: { name: roleName } });
      if (!role) {
        return reply
          .status(400)
          .send({ error: { message: `Unknown role "${roleName}". Run seed-rbac.ts first.` } });
      }

      const existingUser = await prisma.user.findUnique({
        where: { email: body.data.email },
        select: { principalId: true },
      });
      if (existingUser?.principalId) {
        const existingMembership = await prisma.membership.findUnique({
          where: {
            workspaceId_principalId: {
              workspaceId: params.data.workspaceId,
              principalId: existingUser.principalId,
            },
          },
        });
        if (existingMembership) {
          return reply
            .status(409)
            .send({ error: { message: "This email is already a member of the workspace." } });
        }
      }

      const pendingInvite = await prisma.workspaceInvite.findFirst({
        where: {
          workspaceId: params.data.workspaceId,
          email: body.data.email,
          acceptedAt: null,
          revokedAt: null,
          expiresAt: { gt: new Date() },
        },
      });
      if (pendingInvite) {
        return reply
          .status(409)
          .send({ error: { message: "An invite is already pending for this email." } });
      }

      const rbacContext = request.rbacContext!;
      const rawToken = randomBytes(32).toString("base64url");
      const invite = await prisma.$transaction(async (tx) => {
        const created = await tx.workspaceInvite.create({
          data: {
            workspaceId: params.data.workspaceId,
            email: body.data.email,
            role: body.data.role,
            tokenHash: hashApiKey(rawToken),
            invitedByPrincipalId: rbacContext.principalId,
            expiresAt: new Date(Date.now() + INVITE_TOKEN_TTL_MS),
          },
        });
        await writeAuditEvent(tx, {
          workspaceId: params.data.workspaceId,
          principalId: rbacContext.principalId,
          action: "invite.create",
          targetType: "WorkspaceInvite",
          targetId: created.id,
          metadata: { email: body.data.email, role: body.data.role },
        });
        return created;
      });

      const workspace = await prisma.workspace.findUnique({
        where: { id: params.data.workspaceId },
        select: { name: true },
      });
      const link = `${config.DASHBOARD_URL}/auth/callback?token=${rawToken}`;
      await emailSender.send({
        to: body.data.email,
        subject: `You're invited to join ${workspace?.name ?? "a RouteMind workspace"}`,
        text: `You've been invited to join ${workspace?.name ?? "a RouteMind workspace"} as ${roleName}.\n\nClick to accept (expires in 7 days):\n\n${link}\n\nIf you weren't expecting this, you can ignore this email.`,
      });

      return reply.status(201).send({ invite: serializeInvite(invite) });
    },
  );

  app.get(
    "/v1/workspaces/:workspaceId/invites",
    { preHandler: requirePermission(prisma, "workspace.manage", config) },
    async (request, reply) => {
      const params = paramsSchema.safeParse(request.params);
      if (!params.success) {
        return validation(reply);
      }
      if (!ensureSameWorkspace(request, params.data.workspaceId, reply)) {
        return reply;
      }
      const invites = await prisma.workspaceInvite.findMany({
        where: { workspaceId: params.data.workspaceId, acceptedAt: null, revokedAt: null },
        orderBy: { createdAt: "desc" },
      });
      return { invites: invites.map(serializeInvite) };
    },
  );

  app.delete(
    "/v1/workspaces/:workspaceId/invites/:inviteId",
    { preHandler: requirePermission(prisma, "workspace.manage", config) },
    async (request, reply) => {
      const params = inviteParamsSchema.safeParse(request.params);
      if (!params.success) {
        return validation(reply);
      }
      if (!ensureSameWorkspace(request, params.data.workspaceId, reply)) {
        return reply;
      }
      const existing = await prisma.workspaceInvite.findUnique({
        where: { id: params.data.inviteId },
      });
      if (!existing || existing.workspaceId !== params.data.workspaceId) {
        return reply.status(404).send({ error: { message: "Invite not found." } });
      }
      if (existing.acceptedAt || existing.revokedAt) {
        return reply.status(409).send({ error: { message: "Invite is no longer pending." } });
      }

      const rbacContext = request.rbacContext!;
      await prisma.$transaction(async (tx) => {
        await tx.workspaceInvite.update({
          where: { id: params.data.inviteId },
          data: { revokedAt: new Date() },
        });
        await writeAuditEvent(tx, {
          workspaceId: params.data.workspaceId,
          principalId: rbacContext.principalId,
          action: "invite.revoke",
          targetType: "WorkspaceInvite",
          targetId: params.data.inviteId,
          metadata: { email: existing.email },
        });
      });

      return { revoked: true };
    },
  );
}

function serializeInvite(invite: {
  readonly id: string;
  readonly workspaceId: string;
  readonly email: string;
  readonly role: string;
  readonly expiresAt: Date;
  readonly acceptedAt: Date | null;
  readonly revokedAt: Date | null;
  readonly createdAt: Date;
}) {
  return {
    id: invite.id,
    workspaceId: invite.workspaceId,
    email: invite.email,
    role: invite.role,
    expiresAt: invite.expiresAt.toISOString(),
    acceptedAt: invite.acceptedAt?.toISOString() ?? null,
    revokedAt: invite.revokedAt?.toISOString() ?? null,
    createdAt: invite.createdAt.toISOString(),
  };
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function validation(reply: FastifyReply) {
  return reply.status(400).send({ error: { message: "Invalid invite request." } });
}

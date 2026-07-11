import { randomBytes } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import type { ApiConfig } from "../config.js";
import { writeAuditEvent } from "../infrastructure/audit.js";
import type { EmailSender } from "../infrastructure/email-sender.js";
import { createSessionToken, SESSION_COOKIE_NAME } from "../infrastructure/session.js";
import { PrismaWorkspaceService, type WorkspaceRole } from "../infrastructure/workspace-service.js";
import { hashApiKey } from "../security/api-key.js";

const LOGIN_TOKEN_TTL_MS = 15 * 60 * 1000; // 15 minutes

const requestLinkSchema = z.object({
  email: z.string().email(),
});

const verifySchema = z.object({
  token: z.string().min(1),
});

// Always the same response whether or not the email matches a real account
// -- an enumeration-safe message, not an implementation detail.
const GENERIC_REQUEST_LINK_MESSAGE = "If that email is registered, a login link has been sent.";

export function registerAuthRoutes(
  app: FastifyInstance,
  dependencies: {
    readonly config: ApiConfig;
    readonly prisma: PrismaClient;
    readonly emailSender: EmailSender;
  },
): void {
  const { config, prisma, emailSender } = dependencies;

  app.post("/v1/auth/request-link", async (request, reply) => {
    const body = requestLinkSchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: { message: "A valid email is required." } });
    }

    const user = await prisma.user.findUnique({ where: { email: body.data.email } });
    if (user) {
      const rawToken = randomBytes(32).toString("base64url");
      await prisma.loginToken.create({
        data: {
          userId: user.id,
          tokenHash: hashApiKey(rawToken),
          expiresAt: new Date(Date.now() + LOGIN_TOKEN_TTL_MS),
        },
      });

      const link = `${config.DASHBOARD_URL}/auth/callback?token=${rawToken}`;
      await emailSender.send({
        to: user.email,
        subject: "Your RouteMind login link",
        text: `Click to log in to RouteMind (expires in 15 minutes):\n\n${link}\n\nIf you didn't request this, you can ignore this email.`,
      });
    }

    // Same response whether or not `user` was found -- see comment above.
    return reply.status(200).send({ message: GENERIC_REQUEST_LINK_MESSAGE });
  });

  app.post("/v1/auth/verify", async (request, reply) => {
    const body = verifySchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: { message: "A token is required." } });
    }
    const tokenHash = hashApiKey(body.data.token);
    const invalidLinkResponse = () =>
      reply.status(401).send({ error: { message: "This login link is invalid or has expired." } });

    const loginToken = await prisma.loginToken.findUnique({
      where: { tokenHash },
      include: { user: true },
    });

    if (loginToken) {
      if (loginToken.usedAt !== null || loginToken.expiresAt.getTime() < Date.now()) {
        return invalidLinkResponse();
      }

      if (!loginToken.user.principalId) {
        return reply.status(400).send({
          error: { message: "This account has no Principal yet — run the tenancy backfill first." },
        });
      }

      await prisma.loginToken.update({
        where: { id: loginToken.id },
        data: { usedAt: new Date() },
      });

      const sessionToken = createSessionToken(
        { userId: loginToken.user.id, principalId: loginToken.user.principalId },
        config.SESSION_SECRET,
      );
      setSessionCookie(reply, sessionToken, config);

      return reply.status(200).send({
        user: { id: loginToken.user.id, email: loginToken.user.email, name: loginToken.user.name },
      });
    }

    // Not a LoginToken -- try a workspace invite token. Same token/hash/
    // cookie mechanism as login, but on first acceptance it also creates
    // the User/Principal (an invited email may not have an account yet)
    // and joins them to the inviting workspace.
    const invite = await prisma.workspaceInvite.findUnique({ where: { tokenHash } });
    if (
      !invite ||
      invite.acceptedAt !== null ||
      invite.revokedAt !== null ||
      invite.expiresAt.getTime() < Date.now()
    ) {
      return invalidLinkResponse();
    }

    const role = await prisma.role.findUnique({ where: { name: capitalize(invite.role) } });
    if (!role) {
      return reply.status(400).send({
        error: { message: `Unknown role "${invite.role}" on invite — run seed-rbac.ts first.` },
      });
    }

    const { user, workspace } = await prisma.$transaction(async (tx) => {
      let user = await tx.user.findUnique({ where: { email: invite.email } });
      let principalId = user?.principalId ?? undefined;

      if (!user) {
        const displayName = invite.email.split("@")[0] ?? invite.email;
        const principal = await tx.principal.create({ data: { type: "user", displayName } });
        principalId = principal.id;
        user = await tx.user.create({
          data: { email: invite.email, name: displayName, principalId },
        });
      } else if (!principalId) {
        const principal = await tx.principal.create({
          data: { type: "user", displayName: user.name },
        });
        principalId = principal.id;
        user = await tx.user.update({ where: { id: user.id }, data: { principalId } });
      }

      await tx.membership.upsert({
        where: { workspaceId_principalId: { workspaceId: invite.workspaceId, principalId } },
        create: {
          workspaceId: invite.workspaceId,
          principalId,
          role: invite.role,
          roleId: role.id,
        },
        update: { role: invite.role, roleId: role.id },
      });

      const workspaceMember = await new PrismaWorkspaceService(tx).addMember({
        workspaceId: invite.workspaceId,
        userId: user.id,
        role: invite.role as WorkspaceRole,
      });

      await tx.workspaceInvite.update({
        where: { id: invite.id },
        data: { acceptedAt: new Date() },
      });

      await writeAuditEvent(tx, {
        workspaceId: invite.workspaceId,
        principalId,
        action: "member.add",
        targetType: "WorkspaceMember",
        targetId: workspaceMember.id,
        metadata: { email: invite.email, role: invite.role, viaInvite: true },
      });

      const workspaceRow = await tx.workspace.findUnique({
        where: { id: invite.workspaceId },
        select: { id: true, name: true },
      });

      return { user, workspace: workspaceRow };
    });

    const sessionToken = createSessionToken(
      { userId: user.id, principalId: user.principalId! },
      config.SESSION_SECRET,
    );
    setSessionCookie(reply, sessionToken, config);

    return reply.status(200).send({
      user: { id: user.id, email: user.email, name: user.name },
      workspace: workspace ? { id: workspace.id, name: workspace.name } : undefined,
    });
  });
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function setSessionCookie(reply: FastifyReply, token: string, config: ApiConfig): void {
  const isProduction = config.NODE_ENV === "production";
  void reply.setCookie(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: isProduction,
    // Dashboard (Vercel) and API (Render) sit on different top-level
    // domains in production, so the cookie is genuinely cross-site there
    // and needs SameSite=None (which requires Secure). In dev both run on
    // localhost (different ports only), which browsers treat as same-site,
    // so Lax is sufficient and simpler.
    sameSite: isProduction ? "none" : "lax",
    path: "/",
    maxAge: 30 * 24 * 60 * 60,
  });
}

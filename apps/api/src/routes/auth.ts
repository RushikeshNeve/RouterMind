import { randomBytes } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import type { ApiConfig } from "../config.js";
import type { EmailSender } from "../infrastructure/email-sender.js";
import { createSessionToken, SESSION_COOKIE_NAME } from "../infrastructure/session.js";
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

    const loginToken = await prisma.loginToken.findUnique({
      where: { tokenHash: hashApiKey(body.data.token) },
      include: { user: true },
    });

    if (!loginToken || loginToken.usedAt !== null || loginToken.expiresAt.getTime() < Date.now()) {
      return reply
        .status(401)
        .send({ error: { message: "This login link is invalid or has expired." } });
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
  });
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

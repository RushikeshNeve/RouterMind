import type { PrismaClient } from "@prisma/client";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import type { ApiConfig } from "../config.js";
import { writeAuditEvent } from "../infrastructure/audit.js";
import { requireOrganizationPermission } from "../infrastructure/rbac.js";
import { PaddleApiError, type PaddleClient } from "../infrastructure/paddle-client.js";
import { verifyPaddleWebhookSignature } from "../infrastructure/paddle-webhook.js";
import {
  computeUsageSummary,
  defaultUsagePeriod,
} from "../infrastructure/usage-summary-service.js";

declare module "fastify" {
  interface FastifyRequest {
    // Only ever populated for routes registered inside this file's raw-body
    // plugin scope (the Paddle webhook) -- every other route keeps Fastify's
    // default JSON-parsed body untouched.
    rawBody?: Buffer;
  }
}

const orgParamsSchema = z.object({
  organizationId: z.string().min(1),
});

const checkoutBodySchema = z.object({
  planName: z.string().min(1),
});

const usageSummaryQuerySchema = z.object({
  periodStart: z.string().datetime().optional(),
  periodEnd: z.string().datetime().optional(),
});

const paddleWebhookBodySchema = z.object({
  event_type: z.string().min(1),
  data: z.object({
    id: z.string().min(1),
    status: z.string().min(1),
    customer_id: z.string().min(1).optional(),
    custom_data: z
      .object({ organizationId: z.string().min(1).optional() })
      .nullable()
      .optional(),
    items: z.array(z.object({ price: z.object({ id: z.string().min(1) }) })).optional(),
    current_billing_period: z
      .object({ starts_at: z.string().optional(), ends_at: z.string().optional() })
      .nullable()
      .optional(),
  }),
});

function validation(reply: FastifyReply): FastifyReply {
  return reply.status(400).send({ error: { message: "Invalid billing request." } });
}

export function registerBillingRoutes(
  app: FastifyInstance,
  dependencies: {
    readonly config: ApiConfig;
    readonly prisma: PrismaClient;
    readonly paddleClient: PaddleClient;
  },
): void {
  const { config, prisma, paddleClient } = dependencies;

  app.post(
    "/v1/organizations/:organizationId/billing/checkout",
    { preHandler: requireOrganizationPermission(prisma, "billing.manage", config) },
    async (request, reply) => {
      const params = orgParamsSchema.safeParse(request.params);
      const body = checkoutBodySchema.safeParse(request.body);
      if (!params.success || !body.success) {
        return validation(reply);
      }
      const orgContext = request.rbacOrgContext!;
      if (orgContext.organizationId !== params.data.organizationId) {
        return reply
          .status(403)
          .send({ error: { message: "Caller does not have access to this organization." } });
      }

      const plan = await prisma.plan.findUnique({ where: { name: body.data.planName } });
      if (!plan) {
        return reply.status(404).send({ error: { message: "Unknown plan." } });
      }
      if (!plan.paddlePriceId) {
        return reply.status(400).send({
          error: {
            message: `"${plan.name}" isn't available for self-serve checkout -- contact sales.`,
          },
        });
      }

      let transaction;
      try {
        transaction = await paddleClient.createTransaction({
          priceId: plan.paddlePriceId,
          customData: { organizationId: orgContext.organizationId },
        });
      } catch (error) {
        if (error instanceof PaddleApiError) {
          return reply.status(error.status).send({ error: { message: error.message } });
        }
        throw error;
      }

      // Audited separately from the Paddle call itself (not inside one
      // $transaction together) -- the external HTTP call already succeeded
      // and can't be rolled back by our database either way, so there's no
      // atomicity to gain by holding a DB transaction open across it. If
      // this audit write fails, the only consequence is a missing audit
      // row for an otherwise-harmless Paddle transaction -- Subscription
      // state itself is only ever written by the webhook, never here.
      await prisma.$transaction(async (tx) => {
        await writeAuditEvent(tx, {
          workspaceId: orgContext.workspaceId,
          principalId: orgContext.principalId,
          action: "billing.checkout_initiated",
          targetType: "PaddleTransaction",
          targetId: transaction.id,
          metadata: { planName: plan.name, priceId: plan.paddlePriceId },
        });
      });

      return reply.status(201).send({
        transactionId: transaction.id,
        clientToken: config.PADDLE_CLIENT_TOKEN,
        environment: config.PADDLE_ENVIRONMENT,
      });
    },
  );

  app.get(
    "/v1/organizations/:organizationId/billing/usage-summary",
    { preHandler: requireOrganizationPermission(prisma, "billing.read", config) },
    async (request, reply) => {
      const params = orgParamsSchema.safeParse(request.params);
      const query = usageSummaryQuerySchema.safeParse(request.query);
      if (!params.success || !query.success) {
        return validation(reply);
      }
      const orgContext = request.rbacOrgContext!;
      if (orgContext.organizationId !== params.data.organizationId) {
        return reply
          .status(403)
          .send({ error: { message: "Caller does not have access to this organization." } });
      }

      let periodStart: Date;
      let periodEnd: Date;
      if (query.data.periodStart && query.data.periodEnd) {
        periodStart = new Date(query.data.periodStart);
        periodEnd = new Date(query.data.periodEnd);
      } else {
        const subscription = await prisma.subscription.findUnique({
          where: { organizationId: orgContext.organizationId },
          select: { currentPeriodStart: true, currentPeriodEnd: true },
        });
        ({ periodStart, periodEnd } = defaultUsagePeriod(subscription));
      }

      const summary = await computeUsageSummary(prisma, {
        organizationId: orgContext.organizationId,
        periodStart,
        periodEnd,
      });

      return reply.status(200).send({
        organizationId: summary.organizationId,
        periodStart: summary.periodStart.toISOString(),
        periodEnd: summary.periodEnd.toISOString(),
        requestCount: summary.requestCount,
        tokenCount: summary.tokenCount,
      });
    },
  );

  // Encapsulated in its own plugin scope so the raw-body content-type
  // parser below only applies to this one route -- every other route in
  // the app keeps Fastify's default JSON body parsing untouched.
  void app.register((scoped, _opts, done) => {
    scoped.addContentTypeParser(
      "application/json",
      { parseAs: "buffer" },
      (request: FastifyRequest, body: Buffer, done) => {
        request.rawBody = body;
        try {
          done(null, body.length > 0 ? JSON.parse(body.toString("utf8")) : {});
        } catch (error) {
          done(error as Error, undefined);
        }
      },
    );

    scoped.post("/v1/webhooks/paddle", async (request, reply) => {
      if (!config.PADDLE_WEBHOOK_SECRET) {
        return reply
          .status(503)
          .send({ error: { message: "Paddle webhooks are not configured." } });
      }

      const signatureHeader = request.headers["paddle-signature"];
      const valid = verifyPaddleWebhookSignature(
        request.rawBody ?? Buffer.alloc(0),
        typeof signatureHeader === "string" ? signatureHeader : undefined,
        config.PADDLE_WEBHOOK_SECRET,
      );
      if (!valid) {
        return reply.status(401).send({ error: { message: "Invalid webhook signature." } });
      }

      const parsed = paddleWebhookBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return validation(reply);
      }
      const { event_type: eventType, data } = parsed.data;

      if (
        eventType === "subscription.created" ||
        eventType === "subscription.updated" ||
        eventType === "subscription.canceled"
      ) {
        const priceId = data.items?.[0]?.price.id;
        const plan = priceId
          ? await prisma.plan.findFirst({ where: { paddlePriceId: priceId } })
          : null;

        const periodStart = data.current_billing_period?.starts_at
          ? new Date(data.current_billing_period.starts_at)
          : undefined;
        const periodEnd = data.current_billing_period?.ends_at
          ? new Date(data.current_billing_period.ends_at)
          : undefined;

        const existing = await prisma.subscription.findFirst({
          where: { paddleSubscriptionId: data.id },
        });

        if (existing) {
          await prisma.subscription.update({
            where: { id: existing.id },
            data: {
              status: data.status,
              ...(plan ? { planId: plan.id } : {}),
              paddleCustomerId: data.customer_id ?? existing.paddleCustomerId,
              currentPeriodStart: periodStart ?? existing.currentPeriodStart,
              currentPeriodEnd: periodEnd ?? existing.currentPeriodEnd,
            },
          });
        } else {
          const organizationId = data.custom_data?.organizationId;
          // Genuinely un-processable without either a matching existing row
          // or an organizationId to create one against -- retrying wouldn't
          // fix a payload that will never carry this data, so this
          // acknowledges (200) rather than making Paddle retry forever.
          if (organizationId && plan) {
            await prisma.subscription.upsert({
              where: { organizationId },
              create: {
                organizationId,
                planId: plan.id,
                status: data.status,
                paddleSubscriptionId: data.id,
                paddleCustomerId: data.customer_id,
                currentPeriodStart: periodStart,
                currentPeriodEnd: periodEnd,
              },
              update: {
                planId: plan.id,
                status: data.status,
                paddleSubscriptionId: data.id,
                paddleCustomerId: data.customer_id,
                currentPeriodStart: periodStart,
                currentPeriodEnd: periodEnd,
              },
            });
          } else {
            request.log.warn(
              { eventType, subscriptionId: data.id, organizationId, priceId },
              "Paddle webhook could not be matched to an organization or plan -- skipped.",
            );
          }
        }
      }

      return reply.status(200).send({ received: true });
    });

    done();
  });
}

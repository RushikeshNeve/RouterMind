import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { PromptFirewallService } from "../infrastructure/prompt-firewall-service.js";

const querySchema = z.object({
  userId: z.string().min(1).optional(),
});

const ruleSchema = z.object({
  userId: z.string().min(1).nullable().optional(),
  name: z.string().min(1),
  type: z.enum([
    "secret_detection",
    "pii_detection",
    "prompt_injection",
    "blocked_keyword",
    "max_prompt_size",
    "custom_regex",
  ]),
  pattern: z.string().nullable().optional(),
  action: z.enum(["block", "warn", "redact"]),
  isActive: z.boolean().optional(),
});

const rulePatchSchema = ruleSchema.partial();

export function registerFirewallRoutes(
  app: FastifyInstance,
  firewallService: PromptFirewallService,
): void {
  app.get("/v1/firewall/events", async (request, reply) => {
    const parsed = querySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: { message: "Invalid firewall filters." } });
    }

    return {
      events: (await firewallService.listEvents(parsed.data.userId)).map((event) => ({
        ...event,
        createdAt: event.createdAt.toISOString(),
      })),
    };
  });

  app.get("/v1/firewall/rules", async (request, reply) => {
    const parsed = querySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: { message: "Invalid firewall filters." } });
    }

    return {
      rules: (await firewallService.listRules(parsed.data.userId)).map((rule) => ({
        ...rule,
        createdAt: rule.createdAt.toISOString(),
        updatedAt: rule.updatedAt.toISOString(),
      })),
    };
  });

  app.post("/v1/firewall/rules", async (request, reply) => {
    const parsed = ruleSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: { message: "Invalid firewall rule." } });
    }

    const rule = await firewallService.createRule(parsed.data);
    return reply.status(201).send({
      rule: {
        ...rule,
        createdAt: rule.createdAt.toISOString(),
        updatedAt: rule.updatedAt.toISOString(),
      },
    });
  });

  app.patch("/v1/firewall/rules/:ruleId", async (request, reply) => {
    const params = z.object({ ruleId: z.string().min(1) }).safeParse(request.params);
    const parsed = rulePatchSchema.safeParse(request.body);
    if (!params.success || !parsed.success) {
      return reply.status(400).send({ error: { message: "Invalid firewall rule update." } });
    }

    const rule = await firewallService.updateRule(params.data.ruleId, parsed.data);
    if (!rule) {
      return reply.status(404).send({ error: { message: "Firewall rule not found." } });
    }

    return {
      rule: {
        ...rule,
        createdAt: rule.createdAt.toISOString(),
        updatedAt: rule.updatedAt.toISOString(),
      },
    };
  });

  app.delete("/v1/firewall/rules/:ruleId", async (request, reply) => {
    const params = z.object({ ruleId: z.string().min(1) }).safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({ error: { message: "Invalid firewall rule id." } });
    }

    const deleted = await firewallService.deleteRule(params.data.ruleId);
    if (!deleted) {
      return reply.status(404).send({ error: { message: "Firewall rule not found." } });
    }

    return { deleted: true };
  });
}

import type { Prisma, PrismaClient } from "@prisma/client";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import type { ApiConfig } from "../config.js";
import { writeAuditEvent } from "../infrastructure/audit.js";
import { ensureSameWorkspace, requirePermission } from "../infrastructure/rbac.js";

const subjectTypeSchema = z.enum(["role", "user", "api_key"]);
const ruleTypeSchema = z.enum(["model_restriction", "cost_cap", "budget"]);

// Mirrors packages/policy-engine's ModelRestrictionRuleJson/CostCapRuleJson/
// BudgetRuleJson exactly -- a saved row whose ruleJson doesn't match its own
// ruleType's shape would silently never match inside evaluateRule() (it reads
// fields off `rule.ruleJson as Partial<...>` and treats missing fields as
// "rule doesn't apply"), so this validation is what keeps a bad save from
// looking like it succeeded while quietly never enforcing anything.
const ruleJsonSchemas = {
  model_restriction: z.object({
    blockedModels: z.array(z.string().min(1)).min(1),
  }),
  cost_cap: z.object({
    maxCostUsd: z.number().positive(),
  }),
  budget: z.object({
    maxSpendUsd: z.number().positive(),
  }),
} as const;

const createSchema = z.object({
  subjectType: subjectTypeSchema,
  subjectId: z.string().min(1),
  ruleType: ruleTypeSchema,
  ruleJson: z.record(z.string(), z.unknown()),
  priority: z.number().int().optional(),
});

const updateSchema = z.object({
  ruleJson: z.record(z.string(), z.unknown()).optional(),
  priority: z.number().int().optional(),
});

const workspaceParamsSchema = z.object({
  workspaceId: z.string().min(1),
});

const policyParamsSchema = z.object({
  workspaceId: z.string().min(1),
  policyId: z.string().min(1),
});

export function registerPolicyRoutes(
  app: FastifyInstance,
  dependencies: {
    readonly config: ApiConfig;
    readonly prisma: PrismaClient;
  },
): void {
  const prisma = dependencies.prisma;
  const config = dependencies.config;

  // Confirms subjectId actually names something reachable from this
  // workspace before letting a policy reference it -- otherwise a typo'd or
  // foreign id would silently save as a rule that can never match anything
  // (evaluatePolicy only matches on exact subjectId equality against the
  // caller's own roleId/userId/apiKeyId at request time).
  async function validateSubject(
    workspaceId: string,
    subjectType: "role" | "user" | "api_key",
    subjectId: string,
  ): Promise<string | undefined> {
    if (subjectType === "role") {
      const role = await prisma.role.findUnique({ where: { id: subjectId } });
      if (!role) {
        return "subjectId does not reference an existing role.";
      }
      return undefined;
    }
    if (subjectType === "user") {
      const member = await prisma.workspaceMember.findFirst({
        where: { workspaceId, userId: subjectId },
      });
      if (!member) {
        return "subjectId does not reference a member of this workspace.";
      }
      return undefined;
    }
    const apiKey = await prisma.apiKey.findUnique({ where: { id: subjectId } });
    if (!apiKey || apiKey.workspaceId !== workspaceId) {
      return "subjectId does not reference an API key belonging to this workspace.";
    }
    return undefined;
  }

  function validateRuleJson(
    ruleType: "model_restriction" | "cost_cap" | "budget",
    ruleJson: unknown,
  ): string | undefined {
    const result = ruleJsonSchemas[ruleType].safeParse(ruleJson);
    if (!result.success) {
      return `ruleJson does not match the shape required for ruleType "${ruleType}": ${result.error.issues.map((issue) => issue.message).join("; ")}`;
    }
    return undefined;
  }

  // Roles are global reference data (seeded once, not workspace-owned), but
  // the dashboard's role-subject picker needs to resolve a role NAME to the
  // Role.id that evaluatePolicy() actually matches subjectId against -- no
  // other endpoint exposes this list today.
  app.get(
    "/v1/workspaces/:workspaceId/roles",
    { preHandler: requirePermission(prisma, "policy.read", config) },
    async (request, reply) => {
      const params = workspaceParamsSchema.safeParse(request.params);
      if (!params.success) {
        return validation(reply);
      }
      if (!ensureSameWorkspace(request, params.data.workspaceId, reply)) {
        return reply;
      }

      const roles = await prisma.role.findMany({ orderBy: { name: "asc" } });
      return reply
        .status(200)
        .send({ roles: roles.map((role) => ({ id: role.id, name: role.name })) });
    },
  );

  app.post(
    "/v1/workspaces/:workspaceId/policies",
    { preHandler: requirePermission(prisma, "policy.manage", config) },
    async (request, reply) => {
      const params = workspaceParamsSchema.safeParse(request.params);
      const body = createSchema.safeParse(request.body);
      if (!params.success || !body.success) {
        return validation(reply);
      }
      if (!ensureSameWorkspace(request, params.data.workspaceId, reply)) {
        return reply;
      }

      const ruleJsonError = validateRuleJson(body.data.ruleType, body.data.ruleJson);
      if (ruleJsonError) {
        return reply.status(400).send({ error: { message: ruleJsonError } });
      }
      const subjectError = await validateSubject(
        params.data.workspaceId,
        body.data.subjectType,
        body.data.subjectId,
      );
      if (subjectError) {
        return reply.status(400).send({ error: { message: subjectError } });
      }

      const rbacContext = request.rbacContext!;
      const created = await prisma.$transaction(async (tx) => {
        const row = await tx.policy.create({
          data: {
            workspaceId: params.data.workspaceId,
            subjectType: body.data.subjectType,
            subjectId: body.data.subjectId,
            ruleType: body.data.ruleType,
            ruleJson: body.data.ruleJson as Prisma.InputJsonValue,
            priority: body.data.priority ?? 0,
          },
        });
        await writeAuditEvent(tx, {
          workspaceId: params.data.workspaceId,
          principalId: rbacContext.principalId,
          action: "policy.create",
          targetType: "Policy",
          targetId: row.id,
          metadata: {
            subjectType: row.subjectType,
            subjectId: row.subjectId,
            ruleType: row.ruleType,
          },
        });
        return row;
      });

      return reply.status(201).send(created);
    },
  );

  app.get(
    "/v1/workspaces/:workspaceId/policies",
    { preHandler: requirePermission(prisma, "policy.read", config) },
    async (request, reply) => {
      const params = workspaceParamsSchema.safeParse(request.params);
      if (!params.success) {
        return validation(reply);
      }
      if (!ensureSameWorkspace(request, params.data.workspaceId, reply)) {
        return reply;
      }

      const rows = await prisma.policy.findMany({
        where: { workspaceId: params.data.workspaceId },
        orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
      });
      return reply.status(200).send({ policies: rows });
    },
  );

  app.patch(
    "/v1/workspaces/:workspaceId/policies/:policyId",
    { preHandler: requirePermission(prisma, "policy.manage", config) },
    async (request, reply) => {
      const params = policyParamsSchema.safeParse(request.params);
      const body = updateSchema.safeParse(request.body);
      if (!params.success || !body.success) {
        return validation(reply);
      }
      if (!ensureSameWorkspace(request, params.data.workspaceId, reply)) {
        return reply;
      }

      const existing = await prisma.policy.findUnique({ where: { id: params.data.policyId } });
      if (!existing || existing.workspaceId !== params.data.workspaceId) {
        return reply.status(404).send({ error: { message: "Policy not found." } });
      }

      const nextRuleJson = body.data.ruleJson ?? existing.ruleJson;
      if (body.data.ruleJson !== undefined) {
        const ruleJsonError = validateRuleJson(
          existing.ruleType as "model_restriction" | "cost_cap" | "budget",
          body.data.ruleJson,
        );
        if (ruleJsonError) {
          return reply.status(400).send({ error: { message: ruleJsonError } });
        }
      }

      const rbacContext = request.rbacContext!;
      const updated = await prisma.$transaction(async (tx) => {
        const row = await tx.policy.update({
          where: { id: existing.id },
          data: {
            ruleJson: nextRuleJson as Prisma.InputJsonValue,
            priority: body.data.priority ?? existing.priority,
          },
        });
        await writeAuditEvent(tx, {
          workspaceId: params.data.workspaceId,
          principalId: rbacContext.principalId,
          action: "policy.update",
          targetType: "Policy",
          targetId: row.id,
          metadata: {
            subjectType: row.subjectType,
            subjectId: row.subjectId,
            ruleType: row.ruleType,
          },
        });
        return row;
      });

      return reply.status(200).send(updated);
    },
  );

  app.delete(
    "/v1/workspaces/:workspaceId/policies/:policyId",
    { preHandler: requirePermission(prisma, "policy.manage", config) },
    async (request, reply) => {
      const params = policyParamsSchema.safeParse(request.params);
      if (!params.success) {
        return validation(reply);
      }
      if (!ensureSameWorkspace(request, params.data.workspaceId, reply)) {
        return reply;
      }

      const existing = await prisma.policy.findUnique({ where: { id: params.data.policyId } });
      if (!existing || existing.workspaceId !== params.data.workspaceId) {
        return reply.status(404).send({ error: { message: "Policy not found." } });
      }

      const rbacContext = request.rbacContext!;
      await prisma.$transaction(async (tx) => {
        await tx.policy.delete({ where: { id: existing.id } });
        await writeAuditEvent(tx, {
          workspaceId: params.data.workspaceId,
          principalId: rbacContext.principalId,
          action: "policy.delete",
          targetType: "Policy",
          targetId: existing.id,
          metadata: {
            subjectType: existing.subjectType,
            subjectId: existing.subjectId,
            ruleType: existing.ruleType,
          },
        });
      });

      return reply.status(200).send({ deleted: true });
    },
  );
}

function validation(reply: FastifyReply) {
  return reply.status(400).send({ error: { message: "Invalid policy request." } });
}

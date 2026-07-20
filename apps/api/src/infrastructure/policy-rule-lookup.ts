import type { PrismaClient } from "@prisma/client";
import type { PolicyRuleLookup, PolicyRuleRow, PolicySubjectType } from "@routemind/policy-engine";

export class PrismaPolicyRuleLookup implements PolicyRuleLookup {
  constructor(private readonly prisma: PrismaClient) {}

  async findRulesForWorkspace(workspaceId: string): Promise<readonly PolicyRuleRow[]> {
    const rows = await this.prisma.policy.findMany({ where: { workspaceId } });

    return rows.map((row) => ({
      id: row.id,
      workspaceId: row.workspaceId,
      subjectType: row.subjectType as PolicySubjectType,
      subjectId: row.subjectId,
      ruleType: row.ruleType as PolicyRuleRow["ruleType"],
      ruleJson: row.ruleJson,
      priority: row.priority,
      createdAt: row.createdAt,
    }));
  }
}

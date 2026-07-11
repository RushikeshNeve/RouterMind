import type { Prisma } from "@prisma/client";

export type AuditAction =
  | "workspace.update"
  | "member.add"
  | "member.update"
  | "member.remove"
  | "apikey.create"
  | "apikey.delete"
  | "service_account.create"
  | "invite.create"
  | "invite.revoke";

export type AuditTargetType =
  "Workspace" | "WorkspaceMember" | "ApiKey" | "ServiceAccount" | "WorkspaceInvite";

export interface AuditEventInput {
  readonly workspaceId: string;
  readonly principalId: string;
  readonly action: AuditAction;
  readonly targetType: AuditTargetType;
  readonly targetId: string;
  readonly metadata?: Record<string, unknown>;
}

/**
 * Must be called with a transaction client (from prisma.$transaction), not
 * the top-level PrismaClient, so the audit event and the mutation it's
 * recording commit or roll back together.
 */
export async function writeAuditEvent(
  tx: Prisma.TransactionClient,
  input: AuditEventInput,
): Promise<void> {
  await tx.auditEvent.create({
    data: {
      workspaceId: input.workspaceId,
      principalId: input.principalId,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId,
      metadataJson: input.metadata as Prisma.InputJsonValue | undefined,
    },
  });
}

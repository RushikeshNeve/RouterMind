import type { PrismaClient } from "@prisma/client";

export interface PromptLoggingPolicyLookup {
  isEnabled(workspaceId: string | undefined): Promise<boolean>;
}

// Legacy/no-workspace callers (the dev-key path, or any request without a
// resolved workspace) keep today's behavior unchanged -- prompt logging is
// only ever disabled by an explicit per-workspace opt-out, never inferred
// from the absence of a workspace.
export class PrismaPromptLoggingPolicyLookup implements PromptLoggingPolicyLookup {
  constructor(private readonly prisma: PrismaClient) {}

  async isEnabled(workspaceId: string | undefined): Promise<boolean> {
    if (!workspaceId) {
      return true;
    }

    const workspace = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { promptLoggingEnabled: true },
    });

    return workspace?.promptLoggingEnabled ?? true;
  }
}

export class StaticPromptLoggingPolicyLookup implements PromptLoggingPolicyLookup {
  constructor(private readonly enabled: boolean = true) {}

  isEnabled(): Promise<boolean> {
    return Promise.resolve(this.enabled);
  }
}

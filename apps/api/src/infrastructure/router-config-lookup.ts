import type { PrismaClient } from "@prisma/client";
import type {
  RouterConfigLookup,
  RouterConfigScopeType,
  RouterModelSelection,
} from "@routemind/routing";

export class PrismaRouterConfigLookup implements RouterConfigLookup {
  constructor(private readonly prisma: PrismaClient) {}

  async findByScope(
    scopeType: RouterConfigScopeType,
    scopeId: string,
  ): Promise<RouterModelSelection | undefined> {
    const row = await this.prisma.routerConfig.findUnique({
      where: { scopeType_scopeId: { scopeType, scopeId } },
    });

    if (!row) {
      return undefined;
    }

    return {
      provider: row.provider,
      model: row.model,
      fallbackModel: row.fallbackModel ?? undefined,
      credentialId: row.credentialId ?? undefined,
    };
  }
}

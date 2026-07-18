import type { ProviderId } from "@routemind/providers";

export type RouterConfigScopeType = "org" | "workspace" | "api_key";

export interface RouterModelSelection {
  readonly provider: ProviderId;
  readonly model: string;
  readonly fallbackModel?: string;
  readonly credentialId?: string;
}

export interface ResolveRouterConfigContext {
  readonly requestOverride?: RouterModelSelection;
  readonly apiKeyId?: string;
  readonly workspaceId?: string;
  readonly organizationId?: string;
}

export type RouterConfigSource = "request" | "api_key" | "workspace" | "org" | "platform_default";

export interface ResolvedRouterConfig extends RouterModelSelection {
  readonly source: RouterConfigSource;
}

export interface RouterConfigLookup {
  findByScope(
    scopeType: RouterConfigScopeType,
    scopeId: string,
  ): Promise<RouterModelSelection | undefined>;
}

export interface PlatformDefaultRouterConfig {
  readonly provider: ProviderId;
  readonly model: string;
}

// Takes a RouterConfigLookup rather than a Prisma client directly, so this
// stays a pure, framework-free function callable from tests with an
// in-memory fake -- the real Prisma-backed lookup lives in apps/api.
export async function resolveRouterConfig(
  context: ResolveRouterConfigContext,
  lookup: RouterConfigLookup,
  platformDefault: PlatformDefaultRouterConfig,
): Promise<ResolvedRouterConfig> {
  if (context.requestOverride) {
    return { ...context.requestOverride, source: "request" };
  }

  if (context.apiKeyId) {
    const found = await lookup.findByScope("api_key", context.apiKeyId);
    if (found) {
      return { ...found, source: "api_key" };
    }
  }

  if (context.workspaceId) {
    const found = await lookup.findByScope("workspace", context.workspaceId);
    if (found) {
      return { ...found, source: "workspace" };
    }
  }

  if (context.organizationId) {
    const found = await lookup.findByScope("org", context.organizationId);
    if (found) {
      return { ...found, source: "org" };
    }
  }

  return { ...platformDefault, source: "platform_default" };
}

import { describe, expect, it } from "vitest";

import {
  resolveRouterConfig,
  type PlatformDefaultRouterConfig,
  type RouterConfigLookup,
  type RouterConfigScopeType,
  type RouterModelSelection,
} from "./router-config.js";

const platformDefault: PlatformDefaultRouterConfig = {
  provider: "openai",
  model: "gpt-4o-mini",
};

function fakeLookup(
  configs: Partial<Record<`${RouterConfigScopeType}:${string}`, RouterModelSelection>>,
): RouterConfigLookup {
  return {
    findByScope(scopeType, scopeId) {
      return Promise.resolve(configs[`${scopeType}:${scopeId}`]);
    },
  };
}

describe("resolveRouterConfig", () => {
  it("uses the request override when present, without consulting any scope", async () => {
    const requestOverride: RouterModelSelection = {
      provider: "anthropic",
      model: "claude-3-5-sonnet",
    };
    const lookup = fakeLookup({
      "api_key:key-1": { provider: "groq", model: "llama-3.1-70b-versatile" },
    });

    const result = await resolveRouterConfig(
      { requestOverride, apiKeyId: "key-1" },
      lookup,
      platformDefault,
    );

    expect(result).toEqual({ ...requestOverride, source: "request" });
  });

  it("resolves to the API key's config when one exists", async () => {
    const apiKeyConfig: RouterModelSelection = {
      provider: "groq",
      model: "llama-3.1-70b-versatile",
    };
    const lookup = fakeLookup({
      "api_key:key-1": apiKeyConfig,
      "workspace:ws-1": { provider: "gemini", model: "gemini-1.5-pro" },
    });

    const result = await resolveRouterConfig(
      { apiKeyId: "key-1", workspaceId: "ws-1" },
      lookup,
      platformDefault,
    );

    expect(result).toEqual({ ...apiKeyConfig, source: "api_key" });
  });

  it("falls through to the workspace's config when the API key has none", async () => {
    const workspaceConfig: RouterModelSelection = { provider: "gemini", model: "gemini-1.5-pro" };
    const lookup = fakeLookup({
      "workspace:ws-1": workspaceConfig,
      "org:org-1": { provider: "anthropic", model: "claude-3-5-sonnet" },
    });

    const result = await resolveRouterConfig(
      { apiKeyId: "key-with-no-config", workspaceId: "ws-1", organizationId: "org-1" },
      lookup,
      platformDefault,
    );

    expect(result).toEqual({ ...workspaceConfig, source: "workspace" });
  });

  it("falls through to the org's config when neither the API key nor workspace have one", async () => {
    const orgConfig: RouterModelSelection = { provider: "anthropic", model: "claude-3-5-sonnet" };
    const lookup = fakeLookup({
      "org:org-1": orgConfig,
    });

    const result = await resolveRouterConfig(
      { apiKeyId: "key-1", workspaceId: "ws-1", organizationId: "org-1" },
      lookup,
      platformDefault,
    );

    expect(result).toEqual({ ...orgConfig, source: "org" });
  });

  it("falls through to the platform default when no scope has a config", async () => {
    const lookup = fakeLookup({});

    const result = await resolveRouterConfig(
      { apiKeyId: "key-1", workspaceId: "ws-1", organizationId: "org-1" },
      lookup,
      platformDefault,
    );

    expect(result).toEqual({ ...platformDefault, source: "platform_default" });
  });

  it("falls through to the platform default when the context has no scope ids at all", async () => {
    const lookup = fakeLookup({
      "org:org-1": { provider: "anthropic", model: "claude-3-5-sonnet" },
    });

    const result = await resolveRouterConfig({}, lookup, platformDefault);

    expect(result).toEqual({ ...platformDefault, source: "platform_default" });
  });

  it("skips a scope level entirely when its id is absent from the context, rather than treating it as a miss", async () => {
    const orgConfig: RouterModelSelection = { provider: "anthropic", model: "claude-3-5-sonnet" };
    // No workspaceId in context at all -- workspace scope must be skipped,
    // not looked up with an undefined id, and fall straight through to org.
    const lookup: RouterConfigLookup = {
      findByScope(scopeType) {
        if (scopeType === "workspace") {
          throw new Error("workspace scope should not be queried when workspaceId is absent");
        }
        return Promise.resolve(scopeType === "org" ? orgConfig : undefined);
      },
    };

    const result = await resolveRouterConfig({ organizationId: "org-1" }, lookup, platformDefault);

    expect(result).toEqual({ ...orgConfig, source: "org" });
  });

  it("preserves optional fallbackModel and credentialId through each resolution level", async () => {
    const apiKeyConfig: RouterModelSelection = {
      provider: "openai",
      model: "gpt-4.1",
      fallbackModel: "gpt-4o-mini",
      credentialId: "cred-1",
    };
    const lookup = fakeLookup({ "api_key:key-1": apiKeyConfig });

    const result = await resolveRouterConfig({ apiKeyId: "key-1" }, lookup, platformDefault);

    expect(result).toEqual({ ...apiKeyConfig, source: "api_key" });
  });
});

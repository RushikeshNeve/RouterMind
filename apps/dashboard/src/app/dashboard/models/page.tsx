"use client";

import { useCallback, useEffect, useState } from "react";

import { AppShell, PageBanner } from "../../../components/app-shell";
import { Card, CardHeader, EmptyState, LoadingPanel } from "../../../components/ui";
import { permissionRequirementLabel, usePermissions } from "../../../lib/permissions-context";
import {
  discoverModels,
  getActiveWorkspace,
  listModelCatalog,
  listWorkspaceProviderCredentials,
  type ActiveWorkspace,
  type ModelCatalogEntry,
  type ProviderCredentialSummary,
  type RouterProvider,
} from "../../../lib/workspace-client";

const apiBaseUrl =
  process.env.NEXT_PUBLIC_ROUTEMIND_API_URL?.replace(/\/$/, "") ?? "http://localhost:3000";

const PROVIDERS: readonly RouterProvider[] = ["openai", "anthropic", "gemini", "groq"];

export default function ModelsPage() {
  const { permissions, isLoading: permissionsLoading } = usePermissions();
  const canManage = permissionsLoading || permissions.has("models.manage");
  const manageTitle = canManage ? undefined : permissionRequirementLabel("models.manage");

  const [workspace, setWorkspace] = useState<ActiveWorkspace | undefined>();
  const [credentials, setCredentials] = useState<readonly ProviderCredentialSummary[]>([]);
  const [catalog, setCatalog] = useState<readonly ModelCatalogEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();
  const [discoveringProvider, setDiscoveringProvider] = useState<string | undefined>();

  const reload = useCallback((workspaceId: string) => {
    setIsLoading(true);
    setError(undefined);
    Promise.all([listWorkspaceProviderCredentials(workspaceId), listModelCatalog()])
      .then(([credentialsResult, catalogResult]) => {
        setCredentials(credentialsResult.credentials);
        setCatalog(catalogResult.models);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "Failed to load models.");
      })
      .finally(() => setIsLoading(false));
  }, []);

  useEffect(() => {
    const active = getActiveWorkspace();
    setWorkspace(active);
    if (active) {
      reload(active.id);
    } else {
      setIsLoading(false);
    }
  }, [reload]);

  async function handleDiscover(provider: string) {
    if (!workspace) return;
    setDiscoveringProvider(provider);
    setError(undefined);
    try {
      await discoverModels(workspace.id, provider);
      reload(workspace.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to discover ${provider} models.`);
    } finally {
      setDiscoveringProvider(undefined);
    }
  }

  return (
    <AppShell
      title="Models"
      description={workspace ? `Available models for ${workspace.name}` : "Available models"}
      isDemo={false}
      apiBaseUrl={apiBaseUrl}
    >
      <PageBanner message={error} />
      {!workspace ? (
        <EmptyState label="No active workspace. Accept a workspace invite to get started." />
      ) : isLoading ? (
        <LoadingPanel />
      ) : (
        <div className="space-y-4">
          <Card>
            <CardHeader
              title="Discover models"
              description="Calls each provider's real model-listing API using this workspace's stored credential, instead of entering model ids by hand."
            />
            <div className="flex flex-wrap gap-2 px-4 py-4">
              {PROVIDERS.map((provider) => {
                const hasCredential = credentials.some(
                  (credential) => credential.provider === provider && credential.isEnabled,
                );
                return (
                  <button
                    key={provider}
                    type="button"
                    disabled={!canManage || discoveringProvider !== undefined}
                    title={
                      manageTitle ??
                      (hasCredential
                        ? undefined
                        : `No enabled ${provider} credential yet -- discovery uses mock data in dev.`)
                    }
                    onClick={() => {
                      void handleDiscover(provider);
                    }}
                    className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium capitalize text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-900"
                  >
                    {discoveringProvider === provider ? "Discovering…" : `Discover ${provider}`}
                  </button>
                );
              })}
            </div>
          </Card>

          <Card>
            <CardHeader
              title="Model catalog"
              description={`${catalog.length} model(s) discovered so far`}
            />
            {catalog.length === 0 ? (
              <div className="px-4 py-4">
                <EmptyState label="No models discovered yet -- click Discover above." />
              </div>
            ) : (
              <table className="w-full text-left text-sm">
                <thead className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800 dark:text-slate-400">
                  <tr>
                    <th className="px-4 py-2 font-medium">Provider</th>
                    <th className="px-4 py-2 font-medium">Model</th>
                    <th className="px-4 py-2 font-medium">Last synced</th>
                  </tr>
                </thead>
                <tbody>
                  {catalog.map((entry) => (
                    <tr
                      key={`${entry.provider}:${entry.model}`}
                      className="border-b border-slate-100 last:border-0 dark:border-slate-900"
                    >
                      <td className="px-4 py-3 capitalize text-slate-700 dark:text-slate-300">
                        {entry.provider}
                      </td>
                      <td className="px-4 py-3 text-slate-950 dark:text-white">{entry.model}</td>
                      <td className="px-4 py-3 text-slate-500 dark:text-slate-400">
                        {new Date(entry.lastSyncedAt).toLocaleString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        </div>
      )}
    </AppShell>
  );
}

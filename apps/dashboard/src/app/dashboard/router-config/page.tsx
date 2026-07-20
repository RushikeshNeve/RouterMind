"use client";

import { useCallback, useEffect, useState } from "react";

import { AppShell, PageBanner } from "../../../components/app-shell";
import { Card, CardHeader, EmptyState, LoadingPanel } from "../../../components/ui";
import { permissionRequirementLabel, usePermissions } from "../../../lib/permissions-context";
import {
  createRouterConfig,
  deleteRouterConfig,
  getActiveWorkspace,
  getRouterConfig,
  listWorkspaceProviderCredentials,
  updateRouterConfig,
  type ActiveWorkspace,
  type ProviderCredentialSummary,
  type RouterConfig,
  type RouterProvider,
} from "../../../lib/workspace-client";

const apiBaseUrl =
  process.env.NEXT_PUBLIC_ROUTEMIND_API_URL?.replace(/\/$/, "") ?? "http://localhost:3000";

const PROVIDER_OPTIONS: readonly RouterProvider[] = ["openai", "anthropic", "gemini", "groq"];

export default function RouterConfigPage() {
  const { permissions, isLoading: permissionsLoading } = usePermissions();
  const canManage = permissionsLoading || permissions.has("router.manage");
  const manageTitle = canManage ? undefined : permissionRequirementLabel("router.manage");

  const [workspace, setWorkspace] = useState<ActiveWorkspace | undefined>();
  const [config, setConfig] = useState<RouterConfig | undefined>();
  const [credentials, setCredentials] = useState<readonly ProviderCredentialSummary[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();
  const [rowError, setRowError] = useState<string | undefined>();
  const [isSaving, setIsSaving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  const [provider, setProvider] = useState<RouterProvider>("openai");
  const [model, setModel] = useState("");
  const [fallbackModel, setFallbackModel] = useState("");
  const [credentialId, setCredentialId] = useState("");

  const reload = useCallback((workspaceId: string) => {
    setIsLoading(true);
    setError(undefined);
    Promise.all([getRouterConfig(workspaceId), listWorkspaceProviderCredentials(workspaceId)])
      .then(([existing, credentialsResult]) => {
        setConfig(existing);
        setCredentials(credentialsResult.credentials);
        setProvider(existing?.provider ?? "openai");
        setModel(existing?.model ?? "");
        setFallbackModel(existing?.fallbackModel ?? "");
        setCredentialId(existing?.credentialId ?? "");
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "Failed to load router config.");
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

  const matchingCredentials = credentials.filter((credential) => credential.provider === provider);

  async function handleSave(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!workspace) return;
    setIsSaving(true);
    setRowError(undefined);
    try {
      const input = {
        provider,
        model,
        fallbackModel: fallbackModel || undefined,
        credentialId: credentialId || undefined,
      };
      if (config) {
        await updateRouterConfig(workspace.id, input);
      } else {
        await createRouterConfig(workspace.id, input);
      }
      reload(workspace.id);
    } catch (err) {
      setRowError(err instanceof Error ? err.message : "Failed to save router config.");
    } finally {
      setIsSaving(false);
    }
  }

  async function handleDelete() {
    if (!workspace) return;
    setIsDeleting(true);
    setRowError(undefined);
    try {
      await deleteRouterConfig(workspace.id);
      reload(workspace.id);
    } catch (err) {
      setRowError(err instanceof Error ? err.message : "Failed to delete router config.");
    } finally {
      setIsDeleting(false);
    }
  }

  return (
    <AppShell
      title="Router Config"
      description={workspace ? `BYO router model for ${workspace.name}` : "BYO router model"}
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
              title={config ? "Edit router config" : "Set up a router config"}
              description="Choose which provider, model, and credential this workspace's own LLM-assisted routing decisions should use, instead of the platform default."
            />
            <form
              onSubmit={(event) => {
                void handleSave(event);
              }}
              className="grid grid-cols-1 gap-4 px-4 py-4 sm:grid-cols-2"
            >
              <label className="text-sm font-medium text-slate-700 dark:text-slate-300">
                Provider
                <select
                  value={provider}
                  disabled={!canManage}
                  title={manageTitle}
                  onChange={(event) => {
                    setProvider(event.target.value as RouterProvider);
                    setCredentialId("");
                  }}
                  className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-950 outline-none focus:border-slate-500 disabled:cursor-not-allowed disabled:opacity-60 dark:border-slate-700 dark:bg-slate-950 dark:text-white"
                >
                  {PROVIDER_OPTIONS.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-sm font-medium text-slate-700 dark:text-slate-300">
                Model
                <input
                  type="text"
                  required
                  value={model}
                  disabled={!canManage}
                  title={manageTitle}
                  onChange={(event) => setModel(event.target.value)}
                  placeholder="gpt-4o"
                  className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-950 outline-none focus:border-slate-500 disabled:cursor-not-allowed disabled:opacity-60 dark:border-slate-700 dark:bg-slate-950 dark:text-white"
                />
              </label>
              <label className="text-sm font-medium text-slate-700 dark:text-slate-300">
                Fallback model (optional)
                <input
                  type="text"
                  value={fallbackModel}
                  disabled={!canManage}
                  title={manageTitle}
                  onChange={(event) => setFallbackModel(event.target.value)}
                  placeholder="gpt-4o-mini"
                  className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-950 outline-none focus:border-slate-500 disabled:cursor-not-allowed disabled:opacity-60 dark:border-slate-700 dark:bg-slate-950 dark:text-white"
                />
              </label>
              <label className="text-sm font-medium text-slate-700 dark:text-slate-300">
                Credential (optional)
                <select
                  value={credentialId}
                  disabled={!canManage}
                  title={manageTitle}
                  onChange={(event) => setCredentialId(event.target.value)}
                  className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-950 outline-none focus:border-slate-500 disabled:cursor-not-allowed disabled:opacity-60 dark:border-slate-700 dark:bg-slate-950 dark:text-white"
                >
                  <option value="">Platform default</option>
                  {matchingCredentials.map((credential) => (
                    <option key={credential.id} value={credential.id}>
                      {credential.provider} credential ({credential.id.slice(0, 8)}…)
                    </option>
                  ))}
                </select>
                {matchingCredentials.length === 0 ? (
                  <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                    No enabled {provider} credential in this workspace yet.
                  </p>
                ) : null}
              </label>
              <div className="flex items-end gap-3 sm:col-span-2">
                <button
                  type="submit"
                  disabled={isSaving || !canManage}
                  title={manageTitle}
                  className="rounded-md bg-slate-950 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-white dark:text-slate-950 dark:hover:bg-slate-200"
                >
                  {isSaving ? "Saving…" : config ? "Save changes" : "Create router config"}
                </button>
                {config ? (
                  <button
                    type="button"
                    disabled={isDeleting || !canManage}
                    title={manageTitle}
                    onClick={() => {
                      void handleDelete();
                    }}
                    className="text-sm font-medium text-red-600 hover:underline disabled:cursor-not-allowed disabled:text-slate-400 disabled:no-underline dark:text-red-400 dark:disabled:text-slate-600"
                  >
                    {isDeleting ? "Deleting…" : "Delete"}
                  </button>
                ) : null}
              </div>
            </form>
            {rowError ? (
              <p className="px-4 pb-4 text-sm text-red-600 dark:text-red-400">{rowError}</p>
            ) : null}
          </Card>

          {config ? (
            <Card>
              <CardHeader
                title="Current router config"
                description="Resolves for this workspace's LLM-assisted routing decisions."
              />
              <dl className="grid grid-cols-2 gap-4 px-4 py-4 text-sm sm:grid-cols-4">
                <div>
                  <dt className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
                    Provider
                  </dt>
                  <dd className="mt-1 text-slate-950 dark:text-white">{config.provider}</dd>
                </div>
                <div>
                  <dt className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
                    Model
                  </dt>
                  <dd className="mt-1 text-slate-950 dark:text-white">{config.model}</dd>
                </div>
                <div>
                  <dt className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
                    Fallback model
                  </dt>
                  <dd className="mt-1 text-slate-950 dark:text-white">
                    {config.fallbackModel ?? "—"}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
                    Credential
                  </dt>
                  <dd className="mt-1 text-slate-950 dark:text-white">
                    {config.credentialId
                      ? `${config.credentialId.slice(0, 8)}…`
                      : "Platform default"}
                  </dd>
                </div>
              </dl>
            </Card>
          ) : null}
        </div>
      )}
    </AppShell>
  );
}

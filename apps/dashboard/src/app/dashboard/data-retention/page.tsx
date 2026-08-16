"use client";

import { useCallback, useEffect, useState } from "react";

import { AppShell, PageBanner } from "../../../components/app-shell";
import { Card, CardHeader, EmptyState, LoadingPanel } from "../../../components/ui";
import { permissionRequirementLabel, usePermissions } from "../../../lib/permissions-context";
import {
  getActiveWorkspace,
  getPromptLoggingSetting,
  updatePromptLoggingSetting,
  type ActiveWorkspace,
} from "../../../lib/workspace-client";

const apiBaseUrl =
  process.env.NEXT_PUBLIC_ROUTEMIND_API_URL?.replace(/\/$/, "") ?? "http://localhost:3000";

export default function DataRetentionPage() {
  const { permissions, isLoading: permissionsLoading } = usePermissions();
  const canManage = permissionsLoading || permissions.has("dataRetention.manage");
  const manageTitle = canManage ? undefined : permissionRequirementLabel("dataRetention.manage");

  const [workspace, setWorkspace] = useState<ActiveWorkspace | undefined>();
  const [promptLoggingEnabled, setPromptLoggingEnabled] = useState(true);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();
  const [isSaving, setIsSaving] = useState(false);

  const reload = useCallback((workspaceId: string) => {
    setIsLoading(true);
    setError(undefined);
    getPromptLoggingSetting(workspaceId)
      .then((setting) => setPromptLoggingEnabled(setting.promptLoggingEnabled))
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "Failed to load the data-retention setting.");
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

  async function handleToggle(nextEnabled: boolean) {
    if (!workspace) return;
    setIsSaving(true);
    setError(undefined);
    const previous = promptLoggingEnabled;
    setPromptLoggingEnabled(nextEnabled);
    try {
      const result = await updatePromptLoggingSetting(workspace.id, nextEnabled);
      setPromptLoggingEnabled(result.promptLoggingEnabled);
    } catch (err) {
      setPromptLoggingEnabled(previous);
      setError(err instanceof Error ? err.message : "Failed to save the data-retention setting.");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <AppShell
      title="Data Retention"
      description={
        workspace ? `Prompt-logging controls for ${workspace.name}` : "Prompt-logging controls"
      }
      isDemo={false}
      apiBaseUrl={apiBaseUrl}
    >
      <PageBanner message={error} />
      {!workspace ? (
        <EmptyState label="No active workspace. Accept a workspace invite to get started." />
      ) : isLoading ? (
        <LoadingPanel />
      ) : (
        <Card>
          <CardHeader
            title="Prompt & response logging"
            description="Controls whether this workspace's request/response cache retains prompt text and responses. Disabling this also disables response caching entirely for this workspace, since a cache hit reuses the stored response verbatim."
          />
          <div className="flex items-center justify-between gap-4 px-4 py-4">
            <div>
              <p className="text-sm font-medium text-slate-950 dark:text-white">
                {promptLoggingEnabled ? "Enabled" : "Disabled"}
              </p>
              <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                {promptLoggingEnabled
                  ? "Prompts and responses may be cached and retained for this workspace."
                  : "No prompt text or response body is retained; response caching is skipped for this workspace's requests."}
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={promptLoggingEnabled}
              disabled={isSaving || !canManage}
              title={manageTitle}
              onClick={() => {
                void handleToggle(!promptLoggingEnabled);
              }}
              className={`relative h-6 w-11 shrink-0 rounded-full transition disabled:cursor-not-allowed disabled:opacity-60 ${
                promptLoggingEnabled
                  ? "bg-slate-950 dark:bg-white"
                  : "bg-slate-300 dark:bg-slate-700"
              }`}
            >
              <span
                className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition dark:bg-slate-950 ${
                  promptLoggingEnabled ? "left-5" : "left-0.5"
                }`}
              />
            </button>
          </div>
        </Card>
      )}
    </AppShell>
  );
}

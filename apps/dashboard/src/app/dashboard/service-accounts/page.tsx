"use client";

import { useCallback, useEffect, useState } from "react";

import { AppShell, PageBanner } from "../../../components/app-shell";
import { Card, CardHeader, EmptyState, LoadingPanel } from "../../../components/ui";
import { permissionRequirementLabel, usePermissions } from "../../../lib/permissions-context";
import {
  createServiceAccount,
  getActiveWorkspace,
  issueServiceAccountKey,
  listServiceAccounts,
  revokeServiceAccountKey,
  type ActiveWorkspace,
  type ServiceAccount,
  type ServiceAccountRole,
} from "../../../lib/workspace-client";

const apiBaseUrl =
  process.env.NEXT_PUBLIC_ROUTEMIND_API_URL?.replace(/\/$/, "") ?? "http://localhost:3000";

const ROLE_OPTIONS: readonly ServiceAccountRole[] = ["Owner", "Admin", "Developer", "Viewer"];

interface IssuedKey {
  readonly serviceAccountId: string;
  readonly serviceAccountName: string;
  readonly keyName: string;
  readonly apiKey: string;
}

export default function ServiceAccountsPage() {
  const { permissions, isLoading: permissionsLoading } = usePermissions();
  const canManage = permissionsLoading || permissions.has("workspace.manage");
  const canIssueKeys = permissionsLoading || permissions.has("apikey.create");
  const canRevokeKeys = permissionsLoading || permissions.has("apikey.delete");
  const manageTitle = canManage ? undefined : permissionRequirementLabel("workspace.manage");
  const issueTitle = canIssueKeys ? undefined : permissionRequirementLabel("apikey.create");
  const revokeTitle = canRevokeKeys ? undefined : permissionRequirementLabel("apikey.delete");

  const [workspace, setWorkspace] = useState<ActiveWorkspace | undefined>();
  const [serviceAccounts, setServiceAccounts] = useState<readonly ServiceAccount[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();
  const [rowError, setRowError] = useState<string | undefined>();

  const [newDisplayName, setNewDisplayName] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [newRole, setNewRole] = useState<ServiceAccountRole>("Developer");
  const [isCreating, setIsCreating] = useState(false);

  const [issuingForId, setIssuingForId] = useState<string | undefined>();
  const [newKeyName, setNewKeyName] = useState("");
  const [isIssuing, setIsIssuing] = useState(false);
  const [issuedKey, setIssuedKey] = useState<IssuedKey | undefined>();

  const reload = useCallback((workspaceId: string) => {
    setIsLoading(true);
    setError(undefined);
    listServiceAccounts(workspaceId)
      .then((result) => setServiceAccounts(result.serviceAccounts))
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "Failed to load service accounts.");
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

  async function handleCreate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!workspace) return;
    setIsCreating(true);
    setRowError(undefined);
    try {
      await createServiceAccount(workspace.id, newDisplayName, newRole, newDescription);
      setNewDisplayName("");
      setNewDescription("");
      reload(workspace.id);
    } catch (err) {
      setRowError(err instanceof Error ? err.message : "Failed to create service account.");
    } finally {
      setIsCreating(false);
    }
  }

  async function handleIssueKey(serviceAccount: ServiceAccount) {
    if (!workspace || !newKeyName.trim()) return;
    setIsIssuing(true);
    setRowError(undefined);
    try {
      const result = await issueServiceAccountKey(workspace.id, serviceAccount.id, newKeyName);
      setIssuedKey({
        serviceAccountId: serviceAccount.id,
        serviceAccountName: serviceAccount.displayName,
        keyName: result.name,
        apiKey: result.apiKey,
      });
      setNewKeyName("");
      setIssuingForId(undefined);
      reload(workspace.id);
    } catch (err) {
      setRowError(err instanceof Error ? err.message : "Failed to issue key.");
    } finally {
      setIsIssuing(false);
    }
  }

  async function handleRevokeKey(serviceAccountId: string, keyId: string) {
    if (!workspace) return;
    setRowError(undefined);
    try {
      await revokeServiceAccountKey(workspace.id, serviceAccountId, keyId);
      reload(workspace.id);
    } catch (err) {
      setRowError(err instanceof Error ? err.message : "Failed to revoke key.");
    }
  }

  return (
    <AppShell
      title="Service Accounts"
      description={
        workspace ? `Non-human API access for ${workspace.name}` : "Non-human API access"
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
        <div className="space-y-4">
          {issuedKey ? (
            <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
              <p className="font-semibold">
                Key &ldquo;{issuedKey.keyName}&rdquo; issued for {issuedKey.serviceAccountName}
              </p>
              <p className="mt-1">Copy it now — we won&apos;t show this key again.</p>
              <code className="mt-2 block overflow-x-auto rounded-md border border-amber-300 bg-white px-3 py-2 text-xs text-slate-950 dark:border-amber-800 dark:bg-slate-950 dark:text-white">
                {issuedKey.apiKey}
              </code>
              <button
                type="button"
                onClick={() => setIssuedKey(undefined)}
                className="mt-2 text-xs font-medium text-amber-800 hover:underline dark:text-amber-300"
              >
                Dismiss
              </button>
            </div>
          ) : null}

          <Card>
            <CardHeader
              title="New service account"
              description="For CI/CD, cron jobs, and other non-human callers -- not for people. Invite people from the Members screen instead."
            />
            <form
              onSubmit={(event) => {
                void handleCreate(event);
              }}
              className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-end sm:flex-wrap"
            >
              <label className="flex-1 text-sm font-medium text-slate-700 dark:text-slate-300">
                Name
                <input
                  type="text"
                  required
                  disabled={!canManage}
                  value={newDisplayName}
                  onChange={(event) => setNewDisplayName(event.target.value)}
                  placeholder="CI Deploy Bot"
                  title={manageTitle}
                  className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-950 outline-none focus:border-slate-500 disabled:cursor-not-allowed disabled:opacity-60 dark:border-slate-700 dark:bg-slate-950 dark:text-white"
                />
              </label>
              <label className="flex-1 text-sm font-medium text-slate-700 dark:text-slate-300">
                Description (optional)
                <input
                  type="text"
                  disabled={!canManage}
                  value={newDescription}
                  onChange={(event) => setNewDescription(event.target.value)}
                  placeholder="Deploys from GitHub Actions"
                  title={manageTitle}
                  className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-950 outline-none focus:border-slate-500 disabled:cursor-not-allowed disabled:opacity-60 dark:border-slate-700 dark:bg-slate-950 dark:text-white"
                />
              </label>
              <label className="text-sm font-medium text-slate-700 dark:text-slate-300">
                Role
                <select
                  value={newRole}
                  disabled={!canManage}
                  onChange={(event) => setNewRole(event.target.value as ServiceAccountRole)}
                  title={manageTitle}
                  className="mt-1 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-950 outline-none focus:border-slate-500 disabled:cursor-not-allowed disabled:opacity-60 dark:border-slate-700 dark:bg-slate-950 dark:text-white"
                >
                  {ROLE_OPTIONS.map((role) => (
                    <option key={role} value={role}>
                      {role}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="submit"
                disabled={isCreating || !canManage}
                title={manageTitle}
                className="rounded-md bg-slate-950 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-white dark:text-slate-950 dark:hover:bg-slate-200"
              >
                {isCreating ? "Creating…" : "Create"}
              </button>
            </form>
            {rowError ? (
              <p className="px-4 pb-4 text-sm text-red-600 dark:text-red-400">{rowError}</p>
            ) : null}
          </Card>

          <Card>
            <CardHeader
              title="Service accounts"
              description={`${serviceAccounts.length} account(s)`}
            />
            {serviceAccounts.length === 0 ? (
              <div className="px-4 py-4">
                <EmptyState label="No service accounts yet." />
              </div>
            ) : (
              <div className="divide-y divide-slate-100 dark:divide-slate-900">
                {serviceAccounts.map((account) => (
                  <div key={account.id} className="px-4 py-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <p className="text-sm font-semibold text-slate-950 dark:text-white">
                          {account.displayName}
                        </p>
                        <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                          {account.description ?? "No description"}
                        </p>
                        <p className="mt-1 text-xs text-slate-400 dark:text-slate-500">
                          {account.role} · created by {account.createdByUserId} ·{" "}
                          {new Date(account.createdAt).toLocaleDateString()}
                        </p>
                      </div>
                      <button
                        type="button"
                        disabled={!canIssueKeys}
                        title={issueTitle}
                        onClick={() =>
                          setIssuingForId(issuingForId === account.id ? undefined : account.id)
                        }
                        className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-900"
                      >
                        New key
                      </button>
                    </div>

                    {issuingForId === account.id ? (
                      <div className="mt-3 flex flex-wrap items-end gap-2 rounded-md border border-slate-200 bg-slate-50 p-3 dark:border-slate-800 dark:bg-slate-900">
                        <label className="flex-1 text-xs font-medium text-slate-700 dark:text-slate-300">
                          Key name
                          <input
                            type="text"
                            required
                            autoFocus
                            value={newKeyName}
                            onChange={(event) => setNewKeyName(event.target.value)}
                            placeholder="production deploy key"
                            className="mt-1 w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-950 outline-none focus:border-slate-500 dark:border-slate-700 dark:bg-slate-950 dark:text-white"
                          />
                        </label>
                        <button
                          type="button"
                          disabled={isIssuing || !newKeyName.trim()}
                          onClick={() => {
                            void handleIssueKey(account);
                          }}
                          className="rounded-md bg-slate-950 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-slate-800 disabled:opacity-60 dark:bg-white dark:text-slate-950 dark:hover:bg-slate-200"
                        >
                          {isIssuing ? "Issuing…" : "Issue"}
                        </button>
                      </div>
                    ) : null}

                    {account.keys.length === 0 ? (
                      <p className="mt-3 text-xs text-slate-400 dark:text-slate-500">
                        No keys issued yet.
                      </p>
                    ) : (
                      <table className="mt-3 w-full text-left text-xs">
                        <tbody>
                          {account.keys.map((key) => (
                            <tr
                              key={key.id}
                              className="border-t border-slate-100 dark:border-slate-900"
                            >
                              <td className="py-2 pr-3 text-slate-700 dark:text-slate-300">
                                {key.name}
                              </td>
                              <td className="py-2 pr-3 text-slate-400 dark:text-slate-500">
                                {new Date(key.createdAt).toLocaleDateString()}
                              </td>
                              <td className="py-2 pr-3">
                                {key.isActive ? (
                                  <span className="text-emerald-600 dark:text-emerald-400">
                                    Active
                                  </span>
                                ) : (
                                  <span className="text-slate-400 dark:text-slate-600">
                                    Revoked
                                  </span>
                                )}
                              </td>
                              <td className="py-2 text-right">
                                {key.isActive ? (
                                  <button
                                    type="button"
                                    disabled={!canRevokeKeys}
                                    title={revokeTitle}
                                    onClick={() => {
                                      void handleRevokeKey(account.id, key.id);
                                    }}
                                    className="font-medium text-red-600 hover:underline disabled:cursor-not-allowed disabled:text-slate-400 disabled:no-underline dark:text-red-400 dark:disabled:text-slate-600"
                                  >
                                    Revoke
                                  </button>
                                ) : null}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      )}
    </AppShell>
  );
}

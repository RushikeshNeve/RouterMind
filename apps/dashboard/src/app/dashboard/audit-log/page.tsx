"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { AppShell, PageBanner } from "../../../components/app-shell";
import { Card, CardHeader, EmptyState, LoadingPanel } from "../../../components/ui";
import { usePermissions } from "../../../lib/permissions-context";
import { getActiveWorkspace, listAuditLog, type AuditEvent } from "../../../lib/workspace-client";

const apiBaseUrl =
  process.env.NEXT_PUBLIC_ROUTEMIND_API_URL?.replace(/\/$/, "") ?? "http://localhost:3000";

const PAGE_SIZE = 25;

// Mirrors apps/api/src/infrastructure/audit.ts's AuditAction union -- kept
// as a plain list here since there's no introspection endpoint for it.
const ACTION_OPTIONS = [
  "workspace.update",
  "member.add",
  "member.update",
  "member.remove",
  "apikey.create",
  "service_account.create",
  "invite.create",
  "invite.revoke",
] as const;

export default function AuditLogPage() {
  const { permissions, isLoading: permissionsLoading } = usePermissions();
  const [events, setEvents] = useState<readonly AuditEvent[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [principalFilter, setPrincipalFilter] = useState("");
  const [actionFilter, setActionFilter] = useState("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const workspace = getActiveWorkspace();
  const canRead = permissionsLoading || permissions.has("audit.read");

  const query = useMemo(
    () => ({
      limit: PAGE_SIZE,
      principalId: principalFilter || undefined,
      action: actionFilter || undefined,
      from: fromDate ? new Date(fromDate).toISOString() : undefined,
      to: toDate ? new Date(`${toDate}T23:59:59.999`).toISOString() : undefined,
    }),
    [principalFilter, actionFilter, fromDate, toDate],
  );

  const load = useCallback(
    (workspaceId: string) => {
      setIsLoading(true);
      setError(undefined);
      listAuditLog(workspaceId, query)
        .then((result) => {
          setEvents(result.events);
          setNextCursor(result.nextCursor);
        })
        .catch((err: unknown) => {
          setError(err instanceof Error ? err.message : "Failed to load the audit log.");
        })
        .finally(() => setIsLoading(false));
    },
    [query],
  );

  useEffect(() => {
    if (!workspace || permissionsLoading || !permissions.has("audit.read")) {
      setIsLoading(false);
      return;
    }
    load(workspace.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace?.id, permissionsLoading, permissions, query]);

  async function handleLoadMore() {
    if (!workspace || !nextCursor) return;
    setIsLoadingMore(true);
    try {
      const result = await listAuditLog(workspace.id, { ...query, cursor: nextCursor });
      setEvents((current) => [...current, ...result.events]);
      setNextCursor(result.nextCursor);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load more events.");
    } finally {
      setIsLoadingMore(false);
    }
  }

  // Filter dropdown for "principal" is populated from what's already been
  // loaded -- there's no principal-listing endpoint, and building one just
  // for this filter would be its own slice.
  const knownPrincipals = useMemo(() => {
    const seen = new Map<string, string>();
    for (const event of events) {
      if (!seen.has(event.principalId)) {
        seen.set(event.principalId, event.principal?.displayName ?? event.principalId);
      }
    }
    return [...seen.entries()];
  }, [events]);

  return (
    <AppShell
      title="Audit Log"
      description={workspace ? `Recent changes in ${workspace.name}` : "Recent changes"}
      isDemo={false}
      apiBaseUrl={apiBaseUrl}
    >
      <PageBanner message={error} />
      {!workspace ? (
        <EmptyState label="No active workspace. Accept a workspace invite to get started." />
      ) : !canRead ? (
        <EmptyState label="Requires Admin. Ask a workspace Admin or Owner to grant you access." />
      ) : (
        <div className="space-y-4">
          <Card>
            <CardHeader title="Filters" />
            <div className="flex flex-wrap items-end gap-3 px-4 py-4">
              <label className="text-sm font-medium text-slate-700 dark:text-slate-300">
                Principal
                <select
                  value={principalFilter}
                  onChange={(event) => setPrincipalFilter(event.target.value)}
                  className="mt-1 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-950 outline-none focus:border-slate-500 dark:border-slate-700 dark:bg-slate-950 dark:text-white"
                >
                  <option value="">All</option>
                  {knownPrincipals.map(([id, label]) => (
                    <option key={id} value={id}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-sm font-medium text-slate-700 dark:text-slate-300">
                Action
                <select
                  value={actionFilter}
                  onChange={(event) => setActionFilter(event.target.value)}
                  className="mt-1 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-950 outline-none focus:border-slate-500 dark:border-slate-700 dark:bg-slate-950 dark:text-white"
                >
                  <option value="">All</option>
                  {ACTION_OPTIONS.map((action) => (
                    <option key={action} value={action}>
                      {action}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-sm font-medium text-slate-700 dark:text-slate-300">
                From
                <input
                  type="date"
                  value={fromDate}
                  onChange={(event) => setFromDate(event.target.value)}
                  className="mt-1 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-950 outline-none focus:border-slate-500 dark:border-slate-700 dark:bg-slate-950 dark:text-white"
                />
              </label>
              <label className="text-sm font-medium text-slate-700 dark:text-slate-300">
                To
                <input
                  type="date"
                  value={toDate}
                  onChange={(event) => setToDate(event.target.value)}
                  className="mt-1 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-950 outline-none focus:border-slate-500 dark:border-slate-700 dark:bg-slate-950 dark:text-white"
                />
              </label>
              {principalFilter || actionFilter || fromDate || toDate ? (
                <button
                  type="button"
                  onClick={() => {
                    setPrincipalFilter("");
                    setActionFilter("");
                    setFromDate("");
                    setToDate("");
                  }}
                  className="text-sm font-medium text-slate-500 hover:underline dark:text-slate-400"
                >
                  Clear filters
                </button>
              ) : null}
            </div>
          </Card>

          <Card>
            <CardHeader title="Events" description={`${events.length} loaded event(s)`} />
            {isLoading ? (
              <div className="px-4 py-4">
                <LoadingPanel />
              </div>
            ) : events.length === 0 ? (
              <div className="px-4 py-4">
                <EmptyState label="No audit events match these filters." />
              </div>
            ) : (
              <>
                <table className="w-full text-left text-sm">
                  <thead className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800 dark:text-slate-400">
                    <tr>
                      <th className="px-4 py-2 font-medium">When</th>
                      <th className="px-4 py-2 font-medium">Principal</th>
                      <th className="px-4 py-2 font-medium">Action</th>
                      <th className="px-4 py-2 font-medium">Target</th>
                    </tr>
                  </thead>
                  <tbody>
                    {events.map((event) => (
                      <tr
                        key={event.id}
                        className="border-b border-slate-100 last:border-0 dark:border-slate-900"
                      >
                        <td className="px-4 py-3 text-slate-500 dark:text-slate-400">
                          {new Date(event.createdAt).toLocaleString()}
                        </td>
                        <td
                          className="px-4 py-3 text-slate-700 dark:text-slate-300"
                          title={event.principalId}
                        >
                          {event.principal?.displayName ?? event.principalId}
                        </td>
                        <td className="px-4 py-3 text-slate-950 dark:text-white">{event.action}</td>
                        <td className="px-4 py-3 text-slate-700 dark:text-slate-300">
                          {event.targetType} · {event.targetId}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {nextCursor ? (
                  <div className="px-4 py-4">
                    <button
                      type="button"
                      disabled={isLoadingMore}
                      onClick={() => {
                        void handleLoadMore();
                      }}
                      className="rounded-md border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:opacity-60 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-900"
                    >
                      {isLoadingMore ? "Loading…" : "Load more"}
                    </button>
                  </div>
                ) : null}
              </>
            )}
          </Card>
        </div>
      )}
    </AppShell>
  );
}

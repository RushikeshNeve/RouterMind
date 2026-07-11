"use client";

import { useEffect, useState } from "react";

import { AppShell, PageBanner } from "../../../components/app-shell";
import { Card, CardHeader, EmptyState, LoadingPanel } from "../../../components/ui";
import { usePermissions } from "../../../lib/permissions-context";
import { getActiveWorkspace, listAuditLog, type AuditEvent } from "../../../lib/workspace-client";

const apiBaseUrl =
  process.env.NEXT_PUBLIC_ROUTEMIND_API_URL?.replace(/\/$/, "") ?? "http://localhost:3000";

export default function AuditLogPage() {
  const { permissions, isLoading: permissionsLoading } = usePermissions();
  const [events, setEvents] = useState<readonly AuditEvent[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();
  const workspace = getActiveWorkspace();
  const canRead = permissionsLoading || permissions.has("audit.read");

  useEffect(() => {
    if (!workspace || permissionsLoading || !permissions.has("audit.read")) {
      setIsLoading(false);
      return;
    }
    let cancelled = false;
    listAuditLog(workspace.id)
      .then((result) => {
        if (cancelled) return;
        setEvents(result.events);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load the audit log.");
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace?.id, permissionsLoading, permissions]);

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
      ) : isLoading ? (
        <LoadingPanel />
      ) : (
        <Card>
          <CardHeader title="Events" description={`${events.length} recorded event(s)`} />
          {events.length === 0 ? (
            <div className="px-4 py-4">
              <EmptyState label="No audit events yet." />
            </div>
          ) : (
            <table className="w-full text-left text-sm">
              <thead className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800 dark:text-slate-400">
                <tr>
                  <th className="px-4 py-2 font-medium">When</th>
                  <th className="px-4 py-2 font-medium">Action</th>
                  <th className="px-4 py-2 font-medium">Target</th>
                  <th className="px-4 py-2 font-medium">Principal</th>
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
                    <td className="px-4 py-3 text-slate-950 dark:text-white">{event.action}</td>
                    <td className="px-4 py-3 text-slate-700 dark:text-slate-300">
                      {event.targetType} · {event.targetId}
                    </td>
                    <td className="px-4 py-3 text-slate-500 dark:text-slate-400">
                      {event.principalId}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      )}
    </AppShell>
  );
}

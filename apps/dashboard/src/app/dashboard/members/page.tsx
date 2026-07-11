"use client";

import { useCallback, useEffect, useState } from "react";

import { AppShell, PageBanner } from "../../../components/app-shell";
import { Card, CardHeader, EmptyState, LoadingPanel } from "../../../components/ui";
import {
  createInvite,
  getActiveWorkspace,
  listInvites,
  listMembers,
  removeMember,
  revokeInvite,
  updateMemberRole,
  type ActiveWorkspace,
  type MemberRole,
  type WorkspaceInvite,
  type WorkspaceMember,
} from "../../../lib/workspace-client";

const apiBaseUrl =
  process.env.NEXT_PUBLIC_ROUTEMIND_API_URL?.replace(/\/$/, "") ?? "http://localhost:3000";

const ROLE_OPTIONS: readonly MemberRole[] = ["owner", "admin", "developer", "viewer"];

export default function MembersPage() {
  const [workspace, setWorkspace] = useState<ActiveWorkspace | undefined>();
  const [members, setMembers] = useState<readonly WorkspaceMember[]>([]);
  const [invites, setInvites] = useState<readonly WorkspaceInvite[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<MemberRole>("developer");
  const [isInviting, setIsInviting] = useState(false);
  const [rowError, setRowError] = useState<string | undefined>();

  const reload = useCallback((workspaceId: string) => {
    setIsLoading(true);
    setError(undefined);
    Promise.all([listMembers(workspaceId), listInvites(workspaceId)])
      .then(([membersResult, invitesResult]) => {
        setMembers(membersResult.members);
        setInvites(invitesResult.invites);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "Failed to load workspace members.");
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

  async function handleInvite(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!workspace) return;
    setIsInviting(true);
    setRowError(undefined);
    try {
      await createInvite(workspace.id, inviteEmail, inviteRole);
      setInviteEmail("");
      reload(workspace.id);
    } catch (err) {
      setRowError(err instanceof Error ? err.message : "Failed to send invite.");
    } finally {
      setIsInviting(false);
    }
  }

  async function handleRoleChange(memberId: string, role: MemberRole) {
    if (!workspace) return;
    setRowError(undefined);
    try {
      await updateMemberRole(workspace.id, memberId, role);
      reload(workspace.id);
    } catch (err) {
      setRowError(err instanceof Error ? err.message : "Failed to update role.");
    }
  }

  async function handleRemoveMember(memberId: string) {
    if (!workspace) return;
    setRowError(undefined);
    try {
      await removeMember(workspace.id, memberId);
      reload(workspace.id);
    } catch (err) {
      setRowError(err instanceof Error ? err.message : "Failed to remove member.");
    }
  }

  async function handleRevokeInvite(inviteId: string) {
    if (!workspace) return;
    setRowError(undefined);
    try {
      await revokeInvite(workspace.id, inviteId);
      reload(workspace.id);
    } catch (err) {
      setRowError(err instanceof Error ? err.message : "Failed to revoke invite.");
    }
  }

  return (
    <AppShell
      title="Members"
      description={workspace ? `Team access for ${workspace.name}` : "Team access"}
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
              title="Invite a member"
              description="Sends a magic-link invite email. They'll be added to this workspace the first time they use it."
            />
            <form
              onSubmit={(event) => {
                void handleInvite(event);
              }}
              className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-end"
            >
              <label className="flex-1 text-sm font-medium text-slate-700 dark:text-slate-300">
                Email address
                <input
                  type="email"
                  required
                  value={inviteEmail}
                  onChange={(event) => setInviteEmail(event.target.value)}
                  placeholder="teammate@company.com"
                  className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-950 outline-none focus:border-slate-500 dark:border-slate-700 dark:bg-slate-950 dark:text-white"
                />
              </label>
              <label className="text-sm font-medium text-slate-700 dark:text-slate-300">
                Role
                <select
                  value={inviteRole}
                  onChange={(event) => setInviteRole(event.target.value as MemberRole)}
                  className="mt-1 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-950 outline-none focus:border-slate-500 dark:border-slate-700 dark:bg-slate-950 dark:text-white"
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
                disabled={isInviting}
                className="rounded-md bg-slate-950 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-800 disabled:opacity-60 dark:bg-white dark:text-slate-950 dark:hover:bg-slate-200"
              >
                {isInviting ? "Sending…" : "Send invite"}
              </button>
            </form>
            {rowError ? (
              <p className="px-4 pb-4 text-sm text-red-600 dark:text-red-400">{rowError}</p>
            ) : null}
          </Card>

          <Card>
            <CardHeader title="Active members" description={`${members.length} member(s)`} />
            {members.length === 0 ? (
              <div className="px-4 py-4">
                <EmptyState label="No active members yet." />
              </div>
            ) : (
              <table className="w-full text-left text-sm">
                <thead className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800 dark:text-slate-400">
                  <tr>
                    <th className="px-4 py-2 font-medium">Member</th>
                    <th className="px-4 py-2 font-medium">Role</th>
                    <th className="px-4 py-2 font-medium" />
                  </tr>
                </thead>
                <tbody>
                  {members.map((member) => (
                    <tr
                      key={member.id}
                      className="border-b border-slate-100 last:border-0 dark:border-slate-900"
                    >
                      <td className="px-4 py-3 text-slate-950 dark:text-white">
                        {member.email ?? member.userId}
                      </td>
                      <td className="px-4 py-3">
                        <select
                          value={member.role}
                          onChange={(event) => {
                            void handleRoleChange(member.id, event.target.value as MemberRole);
                          }}
                          className="rounded-md border border-slate-300 bg-white px-2 py-1 text-sm text-slate-950 outline-none focus:border-slate-500 dark:border-slate-700 dark:bg-slate-950 dark:text-white"
                        >
                          {ROLE_OPTIONS.map((role) => (
                            <option key={role} value={role}>
                              {role}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <button
                          type="button"
                          onClick={() => {
                            void handleRemoveMember(member.id);
                          }}
                          className="text-sm font-medium text-red-600 hover:underline dark:text-red-400"
                        >
                          Remove
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>

          <Card>
            <CardHeader title="Pending invites" description={`${invites.length} pending`} />
            {invites.length === 0 ? (
              <div className="px-4 py-4">
                <EmptyState label="No pending invites." />
              </div>
            ) : (
              <table className="w-full text-left text-sm">
                <thead className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800 dark:text-slate-400">
                  <tr>
                    <th className="px-4 py-2 font-medium">Email</th>
                    <th className="px-4 py-2 font-medium">Role</th>
                    <th className="px-4 py-2 font-medium">Expires</th>
                    <th className="px-4 py-2 font-medium" />
                  </tr>
                </thead>
                <tbody>
                  {invites.map((invite) => (
                    <tr
                      key={invite.id}
                      className="border-b border-slate-100 last:border-0 dark:border-slate-900"
                    >
                      <td className="px-4 py-3 text-slate-950 dark:text-white">{invite.email}</td>
                      <td className="px-4 py-3 capitalize text-slate-700 dark:text-slate-300">
                        {invite.role}
                      </td>
                      <td className="px-4 py-3 text-slate-500 dark:text-slate-400">
                        {new Date(invite.expiresAt).toLocaleDateString()}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <button
                          type="button"
                          onClick={() => {
                            void handleRevokeInvite(invite.id);
                          }}
                          className="text-sm font-medium text-red-600 hover:underline dark:text-red-400"
                        >
                          Revoke
                        </button>
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

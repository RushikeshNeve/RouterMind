const ACTIVE_WORKSPACE_KEY = "routemind_active_workspace";

const apiBaseUrl =
  process.env.NEXT_PUBLIC_ROUTEMIND_API_URL?.replace(/\/$/, "") ?? "http://localhost:3000";

export interface ActiveWorkspace {
  readonly id: string;
  readonly name: string;
}

export type MemberRole = "owner" | "admin" | "developer" | "viewer";

export interface WorkspaceMember {
  readonly id: string;
  readonly workspaceId: string;
  readonly userId: string;
  readonly role: MemberRole;
  readonly email?: string;
  readonly name?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface WorkspaceInvite {
  readonly id: string;
  readonly workspaceId: string;
  readonly email: string;
  readonly role: MemberRole;
  readonly expiresAt: string;
  readonly acceptedAt: string | null;
  readonly revokedAt: string | null;
  readonly createdAt: string;
}

export interface MyWorkspacePermissions {
  readonly userId: string;
  readonly principalId: string;
  readonly workspaceId: string;
  readonly role: { readonly id: string; readonly name: string } | null;
  readonly permissions: readonly string[];
}

export interface AuditEvent {
  readonly id: string;
  readonly principalId: string;
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly metadata: unknown;
  readonly createdAt: string;
}

// No org/workspace switcher exists yet -- this is the minimal storage this
// invite flow needs so the Members screen knows which workspace to query.
// Set on invite acceptance (see auth/callback). Building the full switcher
// (multi-membership picker) is separate, deferred work.
export function getActiveWorkspace(): ActiveWorkspace | undefined {
  if (typeof window === "undefined") return undefined;
  const raw = window.localStorage.getItem(ACTIVE_WORKSPACE_KEY);
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as ActiveWorkspace;
  } catch {
    return undefined;
  }
}

export function setActiveWorkspace(workspace: ActiveWorkspace): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(ACTIVE_WORKSPACE_KEY, JSON.stringify(workspace));
}

async function requestJson<TValue>(
  path: string,
  init?: { readonly method?: string; readonly body?: unknown },
): Promise<TValue> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    method: init?.method ?? "GET",
    headers: {
      accept: "application/json",
      ...(init?.body ? { "content-type": "application/json" } : {}),
    },
    credentials: "include",
    body: init?.body ? JSON.stringify(init.body) : undefined,
  });

  const payload: unknown = await response.json().catch(() => undefined);

  if (!response.ok) {
    const message =
      payload &&
      typeof payload === "object" &&
      "error" in payload &&
      payload.error &&
      typeof payload.error === "object" &&
      "message" in payload.error &&
      typeof payload.error.message === "string"
        ? payload.error.message
        : `Request to ${path} failed with status ${response.status}.`;
    throw new Error(message);
  }

  return payload as TValue;
}

export function listMembers(workspaceId: string): Promise<{ members: readonly WorkspaceMember[] }> {
  return requestJson(`/v1/workspaces/${workspaceId}/members`);
}

export function updateMemberRole(
  workspaceId: string,
  memberId: string,
  role: MemberRole,
): Promise<{ member: WorkspaceMember }> {
  return requestJson(`/v1/workspaces/${workspaceId}/members/${memberId}`, {
    method: "PATCH",
    body: { role },
  });
}

export function removeMember(workspaceId: string, memberId: string): Promise<{ deleted: true }> {
  return requestJson(`/v1/workspaces/${workspaceId}/members/${memberId}`, { method: "DELETE" });
}

export function listInvites(workspaceId: string): Promise<{ invites: readonly WorkspaceInvite[] }> {
  return requestJson(`/v1/workspaces/${workspaceId}/invites`);
}

export function createInvite(
  workspaceId: string,
  email: string,
  role: MemberRole,
): Promise<{ invite: WorkspaceInvite }> {
  return requestJson(`/v1/workspaces/${workspaceId}/invites`, {
    method: "POST",
    body: { email, role },
  });
}

export function revokeInvite(workspaceId: string, inviteId: string): Promise<{ revoked: true }> {
  return requestJson(`/v1/workspaces/${workspaceId}/invites/${inviteId}`, { method: "DELETE" });
}

export function getMyPermissions(workspaceId: string): Promise<MyWorkspacePermissions> {
  return requestJson(`/v1/workspaces/${workspaceId}/me`);
}

export function listAuditLog(workspaceId: string): Promise<{ events: readonly AuditEvent[] }> {
  return requestJson(`/v1/workspaces/${workspaceId}/audit-log`);
}

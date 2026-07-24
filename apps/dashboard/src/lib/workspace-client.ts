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

// Capitalized, matching apps/api/src/routes/service-accounts.ts's roleSchema
// -- distinct from MemberRole's lowercase casing used by the invite/member
// routes (a pre-existing inconsistency in the backend, not introduced here).
export type ServiceAccountRole = "Owner" | "Admin" | "Developer" | "Viewer";

export interface ServiceAccountKey {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
  readonly isActive: boolean;
}

export interface ServiceAccount {
  readonly id: string;
  readonly principalId: string;
  readonly displayName: string;
  readonly description: string | null;
  readonly role: string;
  readonly createdByUserId: string;
  readonly createdAt: string;
  readonly keys: readonly ServiceAccountKey[];
}

export interface MyWorkspacePermissions {
  readonly userId: string;
  readonly principalId: string;
  readonly workspaceId: string;
  readonly organizationId: string | null;
  readonly role: { readonly id: string; readonly name: string } | null;
  readonly permissions: readonly string[];
}

export interface AuditEvent {
  readonly id: string;
  readonly principalId: string;
  readonly principal: { readonly displayName: string; readonly type: string } | null;
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly metadata: unknown;
  readonly createdAt: string;
}

export interface AuditLogQuery {
  readonly limit?: number;
  readonly cursor?: string;
  readonly principalId?: string;
  readonly action?: string;
  readonly from?: string; // ISO datetime
  readonly to?: string; // ISO datetime
}

export interface AuditLogPage {
  readonly events: readonly AuditEvent[];
  readonly nextCursor: string | null;
}

export type RouterProvider = "openai" | "anthropic" | "gemini" | "groq";

export interface RouterConfig {
  readonly id: string;
  readonly scopeType: "workspace" | "org" | "api_key";
  readonly scopeId: string;
  readonly provider: RouterProvider;
  readonly model: string;
  readonly fallbackModel: string | null;
  readonly credentialId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RouterConfigInput {
  readonly provider: RouterProvider;
  readonly model: string;
  readonly fallbackModel?: string;
  readonly credentialId?: string;
}

export interface ProviderCredentialSummary {
  readonly id: string;
  readonly provider: RouterProvider;
  readonly isEnabled: boolean;
  readonly createdAt: string;
}

export interface ApiKeySummary {
  readonly id: string;
  readonly name: string;
  readonly principalId: string | null;
  readonly userId: string;
  readonly createdAt: string;
  readonly isActive: boolean;
}

export interface Role {
  readonly id: string;
  readonly name: string;
}

export type PolicySubjectType = "role" | "user" | "api_key";
export type PolicyRuleType = "model_restriction" | "cost_cap" | "budget";

export interface Policy {
  readonly id: string;
  readonly workspaceId: string;
  readonly subjectType: PolicySubjectType;
  readonly subjectId: string;
  readonly ruleType: PolicyRuleType;
  readonly ruleJson: Record<string, unknown>;
  readonly priority: number;
  readonly createdAt: string;
}

export interface CreatePolicyInput {
  readonly subjectType: PolicySubjectType;
  readonly subjectId: string;
  readonly ruleType: PolicyRuleType;
  readonly ruleJson: Record<string, unknown>;
  readonly priority?: number;
}

export interface UpdatePolicyInput {
  readonly ruleJson?: Record<string, unknown>;
  readonly priority?: number;
}

// No org/workspace switcher exists yet -- this is the minimal storage the
// workspace-scoped pages need to know which workspace to query. Set on every
// successful /v1/auth/verify that returns a workspace (signup, ordinary
// login, and invite acceptance alike -- see auth/callback). Building the
// full switcher (multi-membership picker) is separate, deferred work.
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

export function listServiceAccounts(
  workspaceId: string,
): Promise<{ serviceAccounts: readonly ServiceAccount[] }> {
  return requestJson(`/v1/workspaces/${workspaceId}/service-accounts`);
}

export function createServiceAccount(
  workspaceId: string,
  displayName: string,
  role: ServiceAccountRole,
  description?: string,
): Promise<{ serviceAccount: ServiceAccount }> {
  return requestJson(`/v1/workspaces/${workspaceId}/service-accounts`, {
    method: "POST",
    body: { displayName, role, description: description || undefined },
  });
}

export function issueServiceAccountKey(
  workspaceId: string,
  serviceAccountId: string,
  name: string,
): Promise<{ id: string; apiKey: string; workspaceId: string; name: string; createdAt: string }> {
  return requestJson(`/v1/workspaces/${workspaceId}/service-accounts/${serviceAccountId}/keys`, {
    method: "POST",
    body: { name },
  });
}

export function revokeServiceAccountKey(
  workspaceId: string,
  serviceAccountId: string,
  keyId: string,
): Promise<{ revoked: true }> {
  return requestJson(
    `/v1/workspaces/${workspaceId}/service-accounts/${serviceAccountId}/keys/${keyId}`,
    { method: "DELETE" },
  );
}

export function listAuditLog(
  workspaceId: string,
  query: AuditLogQuery = {},
): Promise<AuditLogPage> {
  const params = new URLSearchParams();
  if (query.limit) params.set("limit", String(query.limit));
  if (query.cursor) params.set("cursor", query.cursor);
  if (query.principalId) params.set("principalId", query.principalId);
  if (query.action) params.set("action", query.action);
  if (query.from) params.set("from", query.from);
  if (query.to) params.set("to", query.to);
  const queryString = params.toString();
  return requestJson(
    `/v1/workspaces/${workspaceId}/audit-log${queryString ? `?${queryString}` : ""}`,
  );
}

export function listWorkspaceProviderCredentials(
  workspaceId: string,
): Promise<{ credentials: readonly ProviderCredentialSummary[] }> {
  return requestJson(`/v1/workspaces/${workspaceId}/provider-credentials`);
}

// A workspace has at most one RouterConfig row (it's a singleton per scope
// server-side) -- undefined means "none configured yet", not an error, so
// this deliberately doesn't throw on 404 the way requestJson normally would.
export async function getRouterConfig(workspaceId: string): Promise<RouterConfig | undefined> {
  const response = await fetch(`${apiBaseUrl}/v1/workspaces/${workspaceId}/router-config`, {
    headers: { accept: "application/json" },
    credentials: "include",
  });
  if (response.status === 404) {
    return undefined;
  }
  if (!response.ok) {
    const payload: unknown = await response.json().catch(() => undefined);
    const message =
      payload &&
      typeof payload === "object" &&
      "error" in payload &&
      payload.error &&
      typeof payload.error === "object" &&
      "message" in payload.error &&
      typeof payload.error.message === "string"
        ? payload.error.message
        : `Request to load the router config failed with status ${response.status}.`;
    throw new Error(message);
  }
  return (await response.json()) as RouterConfig;
}

export function createRouterConfig(
  workspaceId: string,
  input: RouterConfigInput,
): Promise<RouterConfig> {
  return requestJson(`/v1/workspaces/${workspaceId}/router-config`, {
    method: "POST",
    body: input,
  });
}

export function updateRouterConfig(
  workspaceId: string,
  input: Partial<RouterConfigInput>,
): Promise<RouterConfig> {
  return requestJson(`/v1/workspaces/${workspaceId}/router-config`, {
    method: "PATCH",
    body: input,
  });
}

export function deleteRouterConfig(workspaceId: string): Promise<{ deleted: true }> {
  return requestJson(`/v1/workspaces/${workspaceId}/router-config`, { method: "DELETE" });
}

export function listWorkspaceRoles(workspaceId: string): Promise<{ roles: readonly Role[] }> {
  return requestJson(`/v1/workspaces/${workspaceId}/roles`);
}

export function listWorkspaceApiKeys(
  workspaceId: string,
): Promise<{ apiKeys: readonly ApiKeySummary[] }> {
  return requestJson(`/v1/workspaces/${workspaceId}/api-keys`);
}

export function listPolicies(workspaceId: string): Promise<{ policies: readonly Policy[] }> {
  return requestJson(`/v1/workspaces/${workspaceId}/policies`);
}

export function createPolicy(workspaceId: string, input: CreatePolicyInput): Promise<Policy> {
  return requestJson(`/v1/workspaces/${workspaceId}/policies`, { method: "POST", body: input });
}

export function updatePolicy(
  workspaceId: string,
  policyId: string,
  input: UpdatePolicyInput,
): Promise<Policy> {
  return requestJson(`/v1/workspaces/${workspaceId}/policies/${policyId}`, {
    method: "PATCH",
    body: input,
  });
}

export function deletePolicy(workspaceId: string, policyId: string): Promise<{ deleted: true }> {
  return requestJson(`/v1/workspaces/${workspaceId}/policies/${policyId}`, { method: "DELETE" });
}

export interface Plan {
  readonly id: string;
  readonly name: string;
  readonly priceCents: number;
  readonly includedRequests: number | null;
  readonly featuresJson: Record<string, unknown>;
  readonly selfServe: boolean;
}

export interface BillingOverview {
  readonly plan: {
    readonly name: string;
    readonly priceCents: number;
    readonly includedRequests: number | null;
    readonly featuresJson: Record<string, unknown>;
    readonly selfServe: boolean;
  };
  readonly subscription: { readonly status: string } | null;
  readonly usage: {
    readonly periodStart: string;
    readonly periodEnd: string;
    readonly requestCount: number;
    readonly tokenCount: number;
  };
}

export interface CheckoutResult {
  readonly transactionId: string;
  readonly clientToken: string | undefined;
  readonly environment: "sandbox" | "production";
}

// Public, unauthenticated -- no workspace/organization context needed.
export function listPlans(): Promise<{ plans: readonly Plan[] }> {
  return requestJson(`/v1/plans`);
}

export function getBillingOverview(organizationId: string): Promise<BillingOverview> {
  return requestJson(`/v1/organizations/${organizationId}/billing/overview`);
}

export function createBillingCheckout(
  organizationId: string,
  planName: string,
): Promise<CheckoutResult> {
  return requestJson(`/v1/organizations/${organizationId}/billing/checkout`, {
    method: "POST",
    body: { planName },
  });
}

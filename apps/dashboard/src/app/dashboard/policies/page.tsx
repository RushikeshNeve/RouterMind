"use client";

import { useCallback, useEffect, useState } from "react";

import { AppShell, PageBanner } from "../../../components/app-shell";
import { Card, CardHeader, EmptyState, LoadingPanel } from "../../../components/ui";
import { permissionRequirementLabel, usePermissions } from "../../../lib/permissions-context";
import {
  createPolicy,
  deletePolicy,
  getActiveWorkspace,
  listMembers,
  listPolicies,
  listWorkspaceApiKeys,
  listWorkspaceRoles,
  updatePolicy,
  type ActiveWorkspace,
  type ApiKeySummary,
  type Policy,
  type PolicyRuleType,
  type PolicySubjectType,
  type Role,
  type WorkspaceMember,
} from "../../../lib/workspace-client";

const apiBaseUrl =
  process.env.NEXT_PUBLIC_ROUTEMIND_API_URL?.replace(/\/$/, "") ?? "http://localhost:3000";

const SUBJECT_TYPE_OPTIONS: readonly PolicySubjectType[] = ["role", "user", "api_key"];
const RULE_TYPE_OPTIONS: readonly PolicyRuleType[] = ["model_restriction", "cost_cap", "budget"];

export default function PoliciesPage() {
  const { permissions, isLoading: permissionsLoading } = usePermissions();
  const canManage = permissionsLoading || permissions.has("policy.manage");
  const manageTitle = canManage ? undefined : permissionRequirementLabel("policy.manage");

  const [workspace, setWorkspace] = useState<ActiveWorkspace | undefined>();
  const [policies, setPolicies] = useState<readonly Policy[]>([]);
  const [roles, setRoles] = useState<readonly Role[]>([]);
  const [members, setMembers] = useState<readonly WorkspaceMember[]>([]);
  const [apiKeys, setApiKeys] = useState<readonly ApiKeySummary[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();
  const [rowError, setRowError] = useState<string | undefined>();
  const [isSaving, setIsSaving] = useState(false);

  const [subjectType, setSubjectType] = useState<PolicySubjectType>("role");
  const [subjectId, setSubjectId] = useState("");
  const [ruleType, setRuleType] = useState<PolicyRuleType>("budget");
  const [blockedModels, setBlockedModels] = useState("");
  const [maxCostUsd, setMaxCostUsd] = useState("");
  const [maxSpendUsd, setMaxSpendUsd] = useState("");
  const [priority, setPriority] = useState("0");

  const reload = useCallback((workspaceId: string) => {
    setIsLoading(true);
    setError(undefined);
    Promise.all([
      listPolicies(workspaceId),
      listWorkspaceRoles(workspaceId),
      listMembers(workspaceId),
      listWorkspaceApiKeys(workspaceId),
    ])
      .then(([policiesResult, rolesResult, membersResult, apiKeysResult]) => {
        setPolicies(policiesResult.policies);
        setRoles(rolesResult.roles);
        setMembers(membersResult.members);
        setApiKeys(apiKeysResult.apiKeys);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "Failed to load policies.");
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

  function subjectOptionsFor(type: PolicySubjectType): readonly { value: string; label: string }[] {
    if (type === "role") {
      return roles.map((role) => ({ value: role.id, label: role.name }));
    }
    if (type === "user") {
      return members.map((member) => ({
        value: member.userId,
        label: member.email ?? member.name ?? member.userId,
      }));
    }
    return apiKeys.map((key) => ({ value: key.id, label: key.name }));
  }

  function subjectLabel(policy: Policy): string {
    if (policy.subjectType === "role") {
      return roles.find((role) => role.id === policy.subjectId)?.name ?? policy.subjectId;
    }
    if (policy.subjectType === "user") {
      const member = members.find((m) => m.userId === policy.subjectId);
      return member?.email ?? member?.name ?? policy.subjectId;
    }
    const key = apiKeys.find((k) => k.id === policy.subjectId);
    return key?.name ?? policy.subjectId;
  }

  function ruleJsonSummary(policy: Policy): string {
    if (policy.ruleType === "model_restriction") {
      const blocked = policy.ruleJson.blockedModels;
      return Array.isArray(blocked) ? `blocks: ${blocked.join(", ")}` : "—";
    }
    if (policy.ruleType === "cost_cap") {
      return `max $${policy.ruleJson.maxCostUsd}/request`;
    }
    return `max $${policy.ruleJson.maxSpendUsd} budget`;
  }

  function buildRuleJson(): Record<string, unknown> | undefined {
    if (ruleType === "model_restriction") {
      const models = blockedModels
        .split(",")
        .map((model) => model.trim())
        .filter((model) => model.length > 0);
      return models.length > 0 ? { blockedModels: models } : undefined;
    }
    if (ruleType === "cost_cap") {
      const value = Number(maxCostUsd);
      return Number.isFinite(value) && value > 0 ? { maxCostUsd: value } : undefined;
    }
    const value = Number(maxSpendUsd);
    return Number.isFinite(value) && value > 0 ? { maxSpendUsd: value } : undefined;
  }

  async function handleCreate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!workspace || !subjectId) return;
    const ruleJson = buildRuleJson();
    if (!ruleJson) {
      setRowError("Enter a valid value for this rule type before saving.");
      return;
    }
    setIsSaving(true);
    setRowError(undefined);
    try {
      await createPolicy(workspace.id, {
        subjectType,
        subjectId,
        ruleType,
        ruleJson,
        priority: Number(priority) || 0,
      });
      setSubjectId("");
      setBlockedModels("");
      setMaxCostUsd("");
      setMaxSpendUsd("");
      setPriority("0");
      reload(workspace.id);
    } catch (err) {
      setRowError(err instanceof Error ? err.message : "Failed to create policy.");
    } finally {
      setIsSaving(false);
    }
  }

  async function handlePriorityChange(policy: Policy, nextPriority: number) {
    if (!workspace) return;
    setRowError(undefined);
    try {
      await updatePolicy(workspace.id, policy.id, { priority: nextPriority });
      reload(workspace.id);
    } catch (err) {
      setRowError(err instanceof Error ? err.message : "Failed to update priority.");
    }
  }

  async function handleDelete(policyId: string) {
    if (!workspace) return;
    setRowError(undefined);
    try {
      await deletePolicy(workspace.id, policyId);
      reload(workspace.id);
    } catch (err) {
      setRowError(err instanceof Error ? err.message : "Failed to delete policy.");
    }
  }

  const subjectOptions = subjectOptionsFor(subjectType);

  return (
    <AppShell
      title="Policies"
      description={
        workspace
          ? `Budget, cost, and model-restriction rules for ${workspace.name}`
          : "Budget, cost, and model-restriction rules"
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
          <Card>
            <CardHeader
              title="Add a policy"
              description="Rules are evaluated in priority order (highest first); the first one that denies wins. To change a rule's type or subject, delete it and create a new one."
            />
            <form
              onSubmit={(event) => {
                void handleCreate(event);
              }}
              className="grid grid-cols-1 gap-4 px-4 py-4 sm:grid-cols-2 lg:grid-cols-4"
            >
              <label className="text-sm font-medium text-slate-700 dark:text-slate-300">
                Subject type
                <select
                  value={subjectType}
                  disabled={!canManage}
                  title={manageTitle}
                  onChange={(event) => {
                    setSubjectType(event.target.value as PolicySubjectType);
                    setSubjectId("");
                  }}
                  className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-950 outline-none focus:border-slate-500 disabled:cursor-not-allowed disabled:opacity-60 dark:border-slate-700 dark:bg-slate-950 dark:text-white"
                >
                  {SUBJECT_TYPE_OPTIONS.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-sm font-medium text-slate-700 dark:text-slate-300">
                Subject
                <select
                  value={subjectId}
                  disabled={!canManage}
                  title={manageTitle}
                  onChange={(event) => setSubjectId(event.target.value)}
                  className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-950 outline-none focus:border-slate-500 disabled:cursor-not-allowed disabled:opacity-60 dark:border-slate-700 dark:bg-slate-950 dark:text-white"
                >
                  <option value="">Select…</option>
                  {subjectOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-sm font-medium text-slate-700 dark:text-slate-300">
                Rule type
                <select
                  value={ruleType}
                  disabled={!canManage}
                  title={manageTitle}
                  onChange={(event) => setRuleType(event.target.value as PolicyRuleType)}
                  className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-950 outline-none focus:border-slate-500 disabled:cursor-not-allowed disabled:opacity-60 dark:border-slate-700 dark:bg-slate-950 dark:text-white"
                >
                  {RULE_TYPE_OPTIONS.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-sm font-medium text-slate-700 dark:text-slate-300">
                Priority
                <input
                  type="number"
                  disabled={!canManage}
                  title={manageTitle}
                  value={priority}
                  onChange={(event) => setPriority(event.target.value)}
                  className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-950 outline-none focus:border-slate-500 disabled:cursor-not-allowed disabled:opacity-60 dark:border-slate-700 dark:bg-slate-950 dark:text-white"
                />
              </label>

              {ruleType === "model_restriction" ? (
                <label className="text-sm font-medium text-slate-700 dark:text-slate-300 sm:col-span-2 lg:col-span-4">
                  Blocked models (comma-separated)
                  <input
                    type="text"
                    disabled={!canManage}
                    title={manageTitle}
                    value={blockedModels}
                    onChange={(event) => setBlockedModels(event.target.value)}
                    placeholder="gpt-4o, claude-3-opus"
                    className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-950 outline-none focus:border-slate-500 disabled:cursor-not-allowed disabled:opacity-60 dark:border-slate-700 dark:bg-slate-950 dark:text-white"
                  />
                </label>
              ) : null}
              {ruleType === "cost_cap" ? (
                <label className="text-sm font-medium text-slate-700 dark:text-slate-300">
                  Max cost per request (USD)
                  <input
                    type="number"
                    step="0.01"
                    disabled={!canManage}
                    title={manageTitle}
                    value={maxCostUsd}
                    onChange={(event) => setMaxCostUsd(event.target.value)}
                    placeholder="0.50"
                    className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-950 outline-none focus:border-slate-500 disabled:cursor-not-allowed disabled:opacity-60 dark:border-slate-700 dark:bg-slate-950 dark:text-white"
                  />
                </label>
              ) : null}
              {ruleType === "budget" ? (
                <label className="text-sm font-medium text-slate-700 dark:text-slate-300">
                  Max spend (USD)
                  <input
                    type="number"
                    step="0.01"
                    disabled={!canManage}
                    title={manageTitle}
                    value={maxSpendUsd}
                    onChange={(event) => setMaxSpendUsd(event.target.value)}
                    placeholder="100"
                    className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-950 outline-none focus:border-slate-500 disabled:cursor-not-allowed disabled:opacity-60 dark:border-slate-700 dark:bg-slate-950 dark:text-white"
                  />
                </label>
              ) : null}

              <div className="flex items-end sm:col-span-2 lg:col-span-4">
                <button
                  type="submit"
                  disabled={isSaving || !canManage || !subjectId}
                  title={manageTitle}
                  className="rounded-md bg-slate-950 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-white dark:text-slate-950 dark:hover:bg-slate-200"
                >
                  {isSaving ? "Saving…" : "Add policy"}
                </button>
              </div>
            </form>
            {rowError ? (
              <p className="px-4 pb-4 text-sm text-red-600 dark:text-red-400">{rowError}</p>
            ) : null}
          </Card>

          <Card>
            <CardHeader title="Policies" description={`${policies.length} rule(s)`} />
            {policies.length === 0 ? (
              <div className="px-4 py-4">
                <EmptyState label="No policies yet. Requests are allowed by default until one is added." />
              </div>
            ) : (
              <table className="w-full text-left text-sm">
                <thead className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800 dark:text-slate-400">
                  <tr>
                    <th className="px-4 py-2 font-medium">Subject</th>
                    <th className="px-4 py-2 font-medium">Rule</th>
                    <th className="px-4 py-2 font-medium">Priority</th>
                    <th className="px-4 py-2 font-medium" />
                  </tr>
                </thead>
                <tbody>
                  {policies.map((policy) => (
                    <tr
                      key={policy.id}
                      className="border-b border-slate-100 last:border-0 dark:border-slate-900"
                    >
                      <td className="px-4 py-3 text-slate-950 dark:text-white">
                        <span className="capitalize">{policy.subjectType}</span>:{" "}
                        {subjectLabel(policy)}
                      </td>
                      <td className="px-4 py-3 text-slate-700 dark:text-slate-300">
                        <span className="capitalize">{policy.ruleType.replace("_", " ")}</span> —{" "}
                        {ruleJsonSummary(policy)}
                      </td>
                      <td className="px-4 py-3">
                        <input
                          type="number"
                          disabled={!canManage}
                          title={manageTitle}
                          defaultValue={policy.priority}
                          onBlur={(event) => {
                            const next = Number(event.target.value);
                            if (Number.isFinite(next) && next !== policy.priority) {
                              void handlePriorityChange(policy, next);
                            }
                          }}
                          className="w-20 rounded-md border border-slate-300 bg-white px-2 py-1 text-sm text-slate-950 outline-none focus:border-slate-500 disabled:cursor-not-allowed disabled:opacity-60 dark:border-slate-700 dark:bg-slate-950 dark:text-white"
                        />
                      </td>
                      <td className="px-4 py-3 text-right">
                        <button
                          type="button"
                          disabled={!canManage}
                          title={manageTitle}
                          onClick={() => {
                            void handleDelete(policy.id);
                          }}
                          className="text-sm font-medium text-red-600 hover:underline disabled:cursor-not-allowed disabled:text-slate-400 disabled:no-underline dark:text-red-400 dark:disabled:text-slate-600"
                        >
                          Delete
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

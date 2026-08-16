"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

import { getActiveWorkspace, getMyPermissions } from "./workspace-client";

// Mirrors apps/api/src/scripts/seed-rbac.ts's ROLE_PERMISSIONS -- the
// minimum role that grants each permission, purely for tooltip copy. This
// is UI labeling only; the server is still the sole enforcer of any of it.
const PERMISSION_MIN_ROLE: Record<string, string> = {
  "analytics.read": "Viewer",
  "models.use": "Developer",
  "models.manage": "Admin",
  "provider.manage": "Admin",
  "apikey.read": "Admin",
  "apikey.create": "Admin",
  "apikey.delete": "Admin",
  "audit.read": "Admin",
  "router.read": "Admin",
  "router.manage": "Admin",
  "policy.read": "Admin",
  "policy.manage": "Admin",
  "billing.read": "Admin",
  "billing.manage": "Owner",
  "dataRetention.read": "Admin",
  "dataRetention.manage": "Admin",
  "budget.manage": "Owner",
  "workspace.manage": "Owner",
};

export function permissionRequirementLabel(permission: string): string {
  const role = PERMISSION_MIN_ROLE[permission];
  return role ? `Requires ${role}` : `Requires the "${permission}" permission`;
}

interface PermissionsState {
  readonly permissions: ReadonlySet<string>;
  readonly roleName: string | undefined;
  readonly organizationId: string | undefined;
  readonly isLoading: boolean;
}

const defaultState: PermissionsState = {
  permissions: new Set(),
  roleName: undefined,
  organizationId: undefined,
  isLoading: true,
};

const PermissionsContext = createContext<PermissionsState>(defaultState);

export function PermissionsProvider({ children }: { readonly children: ReactNode }) {
  const [state, setState] = useState<PermissionsState>(defaultState);

  useEffect(() => {
    const workspace = getActiveWorkspace();
    if (!workspace) {
      setState({
        permissions: new Set(),
        roleName: undefined,
        organizationId: undefined,
        isLoading: false,
      });
      return;
    }

    let cancelled = false;
    getMyPermissions(workspace.id)
      .then((result) => {
        if (cancelled) return;
        setState({
          permissions: new Set(result.permissions),
          roleName: result.role?.name,
          organizationId: result.organizationId ?? undefined,
          isLoading: false,
        });
      })
      .catch(() => {
        // Treat "can't determine permissions" as "no permissions" rather
        // than blocking the dashboard -- the server still enforces every
        // action regardless of what the UI thinks it can show.
        if (cancelled) return;
        setState({
          permissions: new Set(),
          roleName: undefined,
          organizationId: undefined,
          isLoading: false,
        });
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return <PermissionsContext.Provider value={state}>{children}</PermissionsContext.Provider>;
}

export function usePermissions(): PermissionsState {
  return useContext(PermissionsContext);
}

export function useCan(permission: string): boolean {
  const { permissions } = usePermissions();
  return permissions.has(permission);
}

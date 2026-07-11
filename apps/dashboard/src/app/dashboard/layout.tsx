import type { ReactNode } from "react";

import { PermissionsProvider } from "../../lib/permissions-context";

export default function DashboardLayout({ children }: { readonly children: ReactNode }) {
  return <PermissionsProvider>{children}</PermissionsProvider>;
}

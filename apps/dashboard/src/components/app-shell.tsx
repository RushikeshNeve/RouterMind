"use client";

import clsx from "clsx";
import {
  Activity,
  BarChart3,
  Bot,
  Boxes,
  BrainCircuit,
  CircleDollarSign,
  GitBranch,
  HeartPulse,
  LayoutDashboard,
  ListChecks,
  Lock,
  Route,
  ScrollText,
  ShieldCheck,
  Users,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

import { permissionRequirementLabel, usePermissions } from "../lib/permissions-context";

const navItems = [
  { href: "/dashboard", label: "Overview", icon: LayoutDashboard },
  { href: "/dashboard/analytics", label: "Analytics", icon: BarChart3 },
  { href: "/dashboard/models", label: "Models", icon: Boxes },
  { href: "/dashboard/providers", label: "Providers", icon: HeartPulse },
  { href: "/dashboard/costs", label: "Costs", icon: CircleDollarSign },
  { href: "/dashboard/resilience", label: "Resilience", icon: ShieldCheck },
  { href: "/dashboard/evaluations", label: "Evaluations", icon: BrainCircuit },
  { href: "/dashboard/requests", label: "Requests", icon: ListChecks },
  { href: "/dashboard/members", label: "Members", icon: Users },
  // These are the nav items whose entire page requires a permission
  // end-to-end (their list routes are gated server-side) -- the other pages
  // hit ungated analytics endpoints, so they stay visible to everyone
  // rather than carrying a fake requirement.
  {
    href: "/dashboard/service-accounts",
    label: "Service Accounts",
    icon: Bot,
    requiredPermission: "apikey.read",
  },
  {
    href: "/dashboard/router-config",
    label: "Router Config",
    icon: Route,
    requiredPermission: "router.read",
  },
  {
    href: "/dashboard/audit-log",
    label: "Audit Log",
    icon: ScrollText,
    requiredPermission: "audit.read",
  },
];

export function AppShell({
  children,
  title,
  description,
  isDemo,
  apiBaseUrl,
}: {
  readonly children: ReactNode;
  readonly title: string;
  readonly description: string;
  readonly isDemo: boolean;
  readonly apiBaseUrl: string;
}) {
  const pathname = usePathname();
  const { permissions, isLoading: permissionsLoading } = usePermissions();

  return (
    <div className="min-h-screen bg-paper text-slate-950 dark:bg-[#0d121c] dark:text-white">
      <aside className="fixed inset-y-0 left-0 hidden w-64 border-r border-slate-200 bg-[#111827] px-4 py-5 text-white lg:block">
        <div className="flex items-center gap-3 px-2">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-routemind-teal text-white">
            <GitBranch className="h-5 w-5" />
          </div>
          <div>
            <p className="text-sm font-semibold">RouteMind</p>
            <p className="text-xs text-slate-400">AI Gateway Control</p>
          </div>
        </div>

        <nav className="mt-8 space-y-1">
          {navItems.map((item) => {
            const Icon = item.icon;
            const active =
              pathname === item.href ||
              (item.href !== "/dashboard" && pathname.startsWith(item.href));
            const allowed =
              permissionsLoading ||
              !item.requiredPermission ||
              permissions.has(item.requiredPermission);

            if (!allowed) {
              return (
                <span
                  key={item.href}
                  title={permissionRequirementLabel(item.requiredPermission!)}
                  className="flex cursor-not-allowed items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-slate-500 opacity-60"
                >
                  <Icon className="h-4 w-4" />
                  {item.label}
                  <Lock className="ml-auto h-3.5 w-3.5" />
                </span>
              );
            }

            return (
              <Link
                key={item.href}
                href={item.href}
                className={clsx(
                  "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition",
                  active
                    ? "bg-white text-slate-950"
                    : "text-slate-300 hover:bg-white/10 hover:text-white",
                )}
              >
                <Icon className="h-4 w-4" />
                {item.label}
              </Link>
            );
          })}
        </nav>
      </aside>

      <div className="lg:pl-64">
        <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/85 px-4 py-3 backdrop-blur dark:border-slate-800 dark:bg-slate-950/85 sm:px-6">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <h1 className="text-xl font-semibold tracking-normal text-slate-950 dark:text-white">
                {title}
              </h1>
              <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{description}</p>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="inline-flex items-center gap-2 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-slate-600 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300">
                <Activity className="h-3.5 w-3.5 text-routemind-teal" />
                {isDemo ? "Demo data" : "Live API"}
              </span>
              <span className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-slate-600 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300">
                Workspace: Default
              </span>
              <span className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-slate-600 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300">
                API {apiBaseUrl}
              </span>
              <span className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-slate-600 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300">
                Last 7 days
              </span>
            </div>
          </div>
          <nav className="mt-3 flex gap-2 overflow-x-auto pb-1 lg:hidden">
            {navItems.map((item) => {
              const active =
                pathname === item.href ||
                (item.href !== "/dashboard" && pathname.startsWith(item.href));
              const allowed =
                permissionsLoading ||
                !item.requiredPermission ||
                permissions.has(item.requiredPermission);

              if (!allowed) {
                return (
                  <span
                    key={item.href}
                    title={permissionRequirementLabel(item.requiredPermission!)}
                    className="flex shrink-0 cursor-not-allowed items-center gap-1 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-medium text-slate-400 opacity-60 dark:border-slate-800 dark:bg-slate-900"
                  >
                    {item.label}
                    <Lock className="h-3 w-3" />
                  </span>
                );
              }

              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={clsx(
                    "shrink-0 rounded-md border px-3 py-2 text-xs font-medium",
                    active
                      ? "border-routemind-teal bg-routemind-mint text-slate-950"
                      : "border-slate-200 bg-slate-50 text-slate-600 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300",
                  )}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>
        </header>

        <main className="px-4 py-5 sm:px-6">{children}</main>
      </div>
    </div>
  );
}

export function PageBanner({ message }: { readonly message?: string }) {
  if (!message) return null;

  return (
    <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
      {message}
    </div>
  );
}

"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { verifyLoginToken } from "../../../lib/auth-client";
import { setActiveWorkspace } from "../../../lib/workspace-client";

export default function AuthCallbackPage() {
  return (
    <Suspense fallback={null}>
      <AuthCallbackContent />
    </Suspense>
  );
}

function AuthCallbackContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [errorMessage, setErrorMessage] = useState<string | undefined>();

  useEffect(() => {
    const token = searchParams.get("token");
    if (!token) {
      setErrorMessage("This login link is missing a token.");
      return;
    }

    let cancelled = false;
    void verifyLoginToken(token)
      .then((result) => {
        if (cancelled) return;
        if (result.workspace) {
          // Signup, an ordinary returning-user login, and invite acceptance
          // all resolve to a workspace now -- set it as active and land
          // directly in its member list instead of the generic dashboard
          // root, which would otherwise show every workspace-scoped page's
          // "no active workspace" empty state. No org/workspace switcher
          // exists yet to pick a different one.
          setActiveWorkspace(result.workspace);
          router.replace("/dashboard/members");
          return;
        }
        // Only reachable for the rare signup race noted in auth-client.ts --
        // a genuine login/signup always returns a workspace or a thrown error.
        router.replace("/dashboard");
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setErrorMessage(error instanceof Error ? error.message : "This login link is invalid.");
      });

    return () => {
      cancelled = true;
    };
  }, [router, searchParams]);

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 px-4 dark:bg-slate-950">
      <div className="w-full max-w-sm rounded-lg border border-slate-200 bg-white p-6 text-center shadow-sm dark:border-slate-800 dark:bg-slate-900">
        {errorMessage ? (
          <>
            <p className="text-sm font-medium text-red-600 dark:text-red-400">{errorMessage}</p>
            <a
              href="/auth/login"
              className="mt-4 inline-block text-sm text-slate-600 underline dark:text-slate-400"
            >
              Back to login
            </a>
          </>
        ) : (
          <p className="text-sm text-slate-500 dark:text-slate-400">Signing you in…</p>
        )}
      </div>
    </main>
  );
}

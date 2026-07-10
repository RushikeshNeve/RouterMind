"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { verifyLoginToken } from "../../../lib/auth-client";

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
      .then(() => {
        if (cancelled) return;
        // No workspace switcher exists yet -- lands on the existing
        // dashboard root. Replacing this with the switcher is the next
        // slice, not this one.
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

"use client";

import { useState, type ChangeEvent, type FormEvent } from "react";
import { Mail } from "lucide-react";

import { requestLoginLink } from "../../../lib/auth-client";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "submitting" | "sent" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState<string | undefined>();

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatus("submitting");
    setErrorMessage(undefined);
    try {
      await requestLoginLink(email);
      setStatus("sent");
    } catch (error) {
      setStatus("error");
      setErrorMessage(error instanceof Error ? error.message : "Something went wrong.");
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 px-4 dark:bg-slate-950">
      <div className="w-full max-w-sm rounded-lg border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <h1 className="text-lg font-semibold text-slate-950 dark:text-white">
          Sign in to RouteMind
        </h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          We&apos;ll email you a link to sign in. No password needed.
        </p>

        {status === "sent" ? (
          <div className="mt-6 flex items-start gap-3 rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300">
            <Mail className="mt-0.5 h-4 w-4 flex-shrink-0" />
            <span>Check your email for a login link. It expires in 15 minutes.</span>
          </div>
        ) : (
          <form className="mt-6 space-y-3" onSubmit={handleSubmit}>
            <label className="block text-sm font-medium text-slate-700 dark:text-slate-300">
              Email address
              <input
                type="email"
                required
                value={email}
                onChange={(event: ChangeEvent<HTMLInputElement>) => setEmail(event.target.value)}
                placeholder="you@company.com"
                className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-950 outline-none focus:border-slate-500 dark:border-slate-700 dark:bg-slate-950 dark:text-white"
              />
            </label>

            {status === "error" ? (
              <p className="text-sm text-red-600 dark:text-red-400">{errorMessage}</p>
            ) : null}

            <button
              type="submit"
              disabled={status === "submitting"}
              className="w-full rounded-md bg-slate-950 px-3 py-2 text-sm font-medium text-white transition hover:bg-slate-800 disabled:opacity-60 dark:bg-white dark:text-slate-950 dark:hover:bg-slate-200"
            >
              {status === "submitting" ? "Sending link…" : "Send login link"}
            </button>
          </form>
        )}
      </div>
    </main>
  );
}

const apiBaseUrl =
  process.env.NEXT_PUBLIC_ROUTEMIND_API_URL?.replace(/\/$/, "") ?? "http://localhost:3000";

async function postJson<TValue>(path: string, body: unknown): Promise<TValue> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    // Required so the session cookie set by /v1/auth/verify is actually
    // stored by the browser -- dashboard and API are different origins.
    credentials: "include",
    body: JSON.stringify(body),
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

export function requestLoginLink(email: string): Promise<{ message: string }> {
  return postJson<{ message: string }>("/v1/auth/request-link", { email });
}

export interface VerifyLoginTokenResult {
  readonly user: { readonly id: string; readonly email: string; readonly name: string };
  // Present only when the token was a workspace invite accepted for the
  // first time -- tells the callback page which workspace to land in
  // instead of a generic dashboard landing.
  readonly workspace?: { readonly id: string; readonly name: string };
}

export function verifyLoginToken(token: string): Promise<VerifyLoginTokenResult> {
  return postJson<VerifyLoginTokenResult>("/v1/auth/verify", { token });
}

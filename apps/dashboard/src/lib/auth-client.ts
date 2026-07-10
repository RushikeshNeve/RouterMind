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

export function verifyLoginToken(
  token: string,
): Promise<{ user: { id: string; email: string; name: string } }> {
  return postJson<{ user: { id: string; email: string; name: string } }>("/v1/auth/verify", {
    token,
  });
}

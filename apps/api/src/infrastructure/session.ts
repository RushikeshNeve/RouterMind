import { createHmac, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE_NAME = "routemind_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export interface SessionPayload {
  readonly userId: string;
  readonly principalId: string;
}

interface SignedSessionPayload extends SessionPayload {
  readonly issuedAt: number;
}

function sign(payloadB64: string, secret: string): string {
  return createHmac("sha256", secret).update(payloadB64).digest("base64url");
}

/**
 * Not a workspace-scoped credential — this identifies a logged-in human
 * (userId + principalId) only. Deliberately carries no workspaceId: a
 * human can belong to multiple workspaces, and picking one is the
 * workspace switcher's job (a later slice), not login's.
 */
export function createSessionToken(payload: SessionPayload, secret: string): string {
  const signed: SignedSessionPayload = { ...payload, issuedAt: Date.now() };
  const payloadB64 = Buffer.from(JSON.stringify(signed)).toString("base64url");
  const signature = sign(payloadB64, secret);
  return `${payloadB64}.${signature}`;
}

export function verifySessionToken(token: string, secret: string): SessionPayload | undefined {
  const [payloadB64, signature] = token.split(".");
  if (!payloadB64 || !signature) {
    return undefined;
  }

  const expectedSignature = sign(payloadB64, secret);
  const signatureBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expectedSignature);
  if (
    signatureBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(signatureBuffer, expectedBuffer)
  ) {
    return undefined;
  }

  let parsed: SignedSessionPayload;
  try {
    parsed = JSON.parse(
      Buffer.from(payloadB64, "base64url").toString("utf8"),
    ) as SignedSessionPayload;
  } catch {
    return undefined;
  }

  if (Date.now() - parsed.issuedAt > SESSION_TTL_MS) {
    return undefined;
  }

  return { userId: parsed.userId, principalId: parsed.principalId };
}

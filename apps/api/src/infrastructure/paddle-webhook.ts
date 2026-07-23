import { createHmac, timingSafeEqual } from "node:crypto";

const SIGNATURE_TOLERANCE_SECONDS = 300; // 5 minutes, same order as Stripe's default tolerance

/**
 * Verifies a Paddle-Signature header (`ts=<unix_seconds>;h1=<hex_hmac>`)
 * against the raw request body, mirroring this codebase's existing
 * hand-rolled HMAC-SHA256 + timingSafeEqual convention (session.ts,
 * security/api-key.ts) rather than pulling in Paddle's SDK. The signed
 * payload is `${ts}:${rawBody}`, matching Paddle's documented scheme.
 */
export function verifyPaddleWebhookSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  secret: string,
): boolean {
  if (!signatureHeader) return false;

  const parts = new Map<string, string>();
  for (const segment of signatureHeader.split(";")) {
    const [key, value] = segment.split("=");
    if (key && value) parts.set(key.trim(), value.trim());
  }
  const timestamp = parts.get("ts");
  const providedSignature = parts.get("h1");
  if (!timestamp || !providedSignature) return false;

  const timestampSeconds = Number(timestamp);
  if (!Number.isFinite(timestampSeconds)) return false;
  if (Math.abs(Date.now() / 1000 - timestampSeconds) > SIGNATURE_TOLERANCE_SECONDS) {
    return false;
  }

  const expectedSignature = createHmac("sha256", secret)
    .update(`${timestamp}:${rawBody.toString("utf8")}`)
    .digest("hex");

  const providedBuffer = Buffer.from(providedSignature, "utf8");
  const expectedBuffer = Buffer.from(expectedSignature, "utf8");
  return (
    providedBuffer.length === expectedBuffer.length &&
    timingSafeEqual(providedBuffer, expectedBuffer)
  );
}

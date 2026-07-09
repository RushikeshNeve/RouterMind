import { createHash } from "node:crypto";

export function hashApiKey(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex");
}

export function maskApiKey(apiKey: string | undefined): string {
  if (!apiKey) {
    return "missing";
  }

  if (apiKey.length <= 8) {
    return `${apiKey.slice(0, 2)}...${apiKey.slice(-2)}`;
  }

  return `${apiKey.slice(0, 7)}...${apiKey.slice(-4)}`;
}

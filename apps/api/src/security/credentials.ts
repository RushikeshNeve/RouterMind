import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const algorithm = "aes-256-gcm";

export function encryptCredential(rawValue: string, encryptionKey: string): string {
  const key = deriveKey(encryptionKey);
  const iv = randomBytes(12);
  const cipher = createCipheriv(algorithm, key, iv);
  const encrypted = Buffer.concat([cipher.update(rawValue, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [iv, authTag, encrypted].map((part) => part.toString("base64url")).join(".");
}

export function decryptCredential(encryptedValue: string, encryptionKey: string): string {
  const [iv, authTag, encrypted] = encryptedValue
    .split(".")
    .map((part) => Buffer.from(part ?? "", "base64url"));

  if (!iv || !authTag || !encrypted) {
    throw new Error("Invalid encrypted credential format.");
  }

  const decipher = createDecipheriv(algorithm, deriveKey(encryptionKey), iv);
  decipher.setAuthTag(authTag);

  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}

function deriveKey(encryptionKey: string): Buffer {
  return createHash("sha256").update(encryptionKey).digest();
}

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const keyFor = secret => createHash("sha256").update(`portal-security-email:v1:${secret}`).digest();
// Recovery links are encrypted in the private outbox, never exposed by admin APIs.
export function protectEmailContent(content, secret) {
  if (!secret) throw new Error("Security email encryption is not configured.");
  const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", keyFor(secret), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(content), "utf8"), cipher.final()]);
  return { version: 1, iv: iv.toString("base64url"), tag: cipher.getAuthTag().toString("base64url"), data: data.toString("base64url") };
}
export function revealEmailContent(payload, secret) {
  if (!payload || payload.version !== 1 || !secret) throw new Error("Security email content is unavailable.");
  const decipher = createDecipheriv("aes-256-gcm", keyFor(secret), Buffer.from(payload.iv, "base64url"));
  decipher.setAuthTag(Buffer.from(payload.tag, "base64url"));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(payload.data, "base64url")), decipher.final()]).toString("utf8"));
}

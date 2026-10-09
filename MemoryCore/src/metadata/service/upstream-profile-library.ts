import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
export type UpstreamConfigType = "conversation" | "extraction";

export interface UpstreamProfile {
  id: string;
  name: string;
  type: UpstreamConfigType;
  base_url: string;
  model_id: string;
  encrypted_key: string;
  local: boolean;
  ready_protocols: string[];
  probe_results: Array<{ protocol: string; status: string; httpStatus?: number }>;
  probe_failed: boolean;
  checked_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface LegacyUpstreamLibrary { profiles: UpstreamProfile[]; active_id: string | null }

function wrappingKey(): Buffer {
  const path = process.env.TDAI_LLM_CONFIG_ENCRYPTION_KEY_FILE;
  if (!path) throw new Error("TDAI_LLM_CONFIG_ENCRYPTION_KEY_FILE is required");
  const raw = readFileSync(path, "utf8").trim();
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32 || key.toString("base64") !== raw) {
    throw new Error("TDAI_LLM_CONFIG_ENCRYPTION_KEY must be a 32-byte base64 Docker Secret");
  }
  return key;
}

export function encryptUpstreamKey(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", wrappingKey(), iv);
  const payload = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return `v1:${iv.toString("base64")}:${cipher.getAuthTag().toString("base64")}:${payload.toString("base64")}`;
}

export function decryptUpstreamKey(value: string): string {
  const [version, ivText, tagText, payloadText] = value.split(":");
  if (version !== "v1" || !ivText || !tagText || !payloadText) throw new Error("invalid encrypted upstream key");
  const decipher = createDecipheriv("aes-256-gcm", wrappingKey(), Buffer.from(ivText, "base64"));
  decipher.setAuthTag(Buffer.from(tagText, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(payloadText, "base64")), decipher.final()]).toString("utf8");
}

import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { IMetadataStore } from "../store/interface.js";
import type { UpstreamConfigType } from "../types.js";

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

interface Library { profiles: UpstreamProfile[]; active_id: string | null }
const MODULE = "upstream_profiles";

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

export class UpstreamProfileLibrary {
  constructor(private readonly store: IMetadataStore) {}

  async read(type: UpstreamConfigType): Promise<Library> {
    const row = await this.store.getConfigParam("global", null, MODULE, type);
    if (row) return JSON.parse(row.param_value) as Library;
    // Existing Panel values become inactive drafts. Deployment credential references
    // never acquire a supplier key during migration.
    const legacy = await this.store.getInstanceUpstreamConfig("default", type);
    const now = new Date().toISOString();
    const profile: UpstreamProfile[] = legacy?.mode === "custom_unified" ? [{
      id: randomUUID(), name: legacy.description.startsWith("panel:local-model-endpoint:")
        ? "Imported local model" : legacy.description || "Imported Panel configuration", type,
      base_url: legacy.base_url, model_id: legacy.model_id,
      encrypted_key: legacy.api_key ? encryptUpstreamKey(legacy.api_key) : "",
      local: legacy.description.startsWith("panel:local-model-endpoint:") || legacy.base_url.startsWith("http:"),
      ready_protocols: [], probe_results: [], probe_failed: false, checked_at: null,
      created_at: now, updated_at: now,
    }] : [];
    const library = { profiles: profile, active_id: null };
    await this.write(type, library);
    if (legacy) await this.store.deleteInstanceUpstreamConfig("default", type);
    return library;
  }

  async write(type: UpstreamConfigType, library: Library): Promise<void> {
    await this.store.upsertConfigParam({ scope: "global", module: MODULE, param_name: type,
      param_value: JSON.stringify(library), description: "Panel model configuration library" });
  }

  async list(type: UpstreamConfigType): Promise<{ profiles: Record<string, unknown>[]; active_id: string | null }> {
    const library = await this.read(type);
    return { active_id: library.active_id, profiles: library.profiles.map(({ encrypted_key, ...profile }) => ({
      ...profile, has_api_key: !!encrypted_key,
    })) };
  }

  async get(type: UpstreamConfigType, id: string): Promise<{ library: Library; profile: UpstreamProfile }> {
    const library = await this.read(type);
    const profile = library.profiles.find((item) => item.id === id);
    if (!profile) throw new Error("upstream_profile_not_found");
    return { library, profile };
  }

  async save(input: { type: UpstreamConfigType; id?: string; name: string; base_url: string;
    model_id: string; api_key?: string; local: boolean }, probe: (profile: UpstreamProfile) => Promise<UpstreamProfile["probe_results"]>): Promise<void> {
    const library = await this.read(input.type);
    const old = input.id ? library.profiles.find((item) => item.id === input.id) : undefined;
    if (input.id && !old) throw new Error("upstream_profile_not_found");
    const now = new Date().toISOString();
    const sameOrigin = old && new URL(old.base_url).origin === new URL(input.base_url).origin;
    const encryptedKey = input.api_key ? encryptUpstreamKey(input.api_key) : sameOrigin ? old!.encrypted_key : "";
    const next: UpstreamProfile = { id: old?.id ?? randomUUID(), type: input.type,
      name: input.name.trim(), base_url: input.base_url.trim(), model_id: input.model_id.trim(),
      encrypted_key: encryptedKey, local: input.local, ready_protocols: [], probe_results: [], probe_failed: false, checked_at: null,
      created_at: old?.created_at ?? now, updated_at: now };
    if (!next.encrypted_key) throw new Error("upstream_api_key_required");
    if (old && library.active_id === old.id) {
      next.probe_results = await probe(next);
      next.ready_protocols = next.probe_results.filter((result) => result.status === "ready").map((result) => result.protocol);
      if (!next.ready_protocols.length) throw new Error("upstream_probe_failed");
      next.checked_at = now;
    }
    if (old) library.profiles = library.profiles.map((item) => item.id === old.id ? next : item);
    else library.profiles.push(next);
    await this.write(input.type, library);
  }

  async activate(type: UpstreamConfigType, id: string, probe: (profile: UpstreamProfile) => Promise<UpstreamProfile["probe_results"]>): Promise<void> {
    const { library, profile } = await this.get(type, id);
    let results: UpstreamProfile["probe_results"];
    try {
      results = await probe(profile);
    } catch (error) {
      if ((error as { code?: string })?.code === "proxy_probe_rate_limited") throw error;
      profile.probe_results = [{ protocol: "probe", status: "unavailable" }];
      profile.probe_failed = true;
      profile.checked_at = new Date().toISOString();
      await this.write(type, library);
      throw error;
    }
    const ready = results.filter((result) => result.status === "ready").map((result) => result.protocol);
    profile.probe_results = results;
    profile.probe_failed = ready.length === 0;
    profile.ready_protocols = ready;
    profile.checked_at = new Date().toISOString();
    if (ready.length) library.active_id = id;
    await this.write(type, library);
    if (!ready.length) throw new Error("upstream_probe_failed");
  }

  async remove(type: UpstreamConfigType, id: string): Promise<void> {
    const { library } = await this.get(type, id);
    library.profiles = library.profiles.filter((item) => item.id !== id);
    if (library.active_id === id) library.active_id = null;
    await this.write(type, library);
  }

  async active(type: UpstreamConfigType): Promise<UpstreamProfile | null> {
    const library = await this.read(type);
    return library.profiles.find((item) => item.id === library.active_id) ?? null;
  }
}

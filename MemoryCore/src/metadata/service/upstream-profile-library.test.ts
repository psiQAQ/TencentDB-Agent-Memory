import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { IMetadataStore } from "../store/interface.js";
import { SqliteMetadataStore } from "../store/sqlite-adapter.js";
import { UpstreamProfileLibrary, decryptUpstreamKey } from "./upstream-profile-library.js";

describe("Panel upstream profile library", () => {
  let temp: string;
  let rows: Map<string, string>;
  let library: UpstreamProfileLibrary;

  beforeEach(() => {
    temp = mkdtempSync(join(tmpdir(), "tdai-upstream-profile-"));
    const secret = join(temp, "key");
    writeFileSync(secret, randomBytes(32).toString("base64"));
    process.env.TDAI_LLM_CONFIG_ENCRYPTION_KEY_FILE = secret;
    rows = new Map();
    const store = {
      getConfigParam: (_scope: string, _user: null, _module: string, name: string) =>
        rows.has(name) ? { param_value: rows.get(name)! } : null,
      upsertConfigParam: (input: { param_name: string; param_value: string }) => {
        rows.set(input.param_name, input.param_value);
        return input;
      },
      getInstanceUpstreamConfig: () => null,
    } as unknown as IMetadataStore;
    library = new UpstreamProfileLibrary(store);
  });

  afterEach(() => { delete process.env.TDAI_LLM_CONFIG_ENCRYPTION_KEY_FILE; rmSync(temp, { recursive: true, force: true }); });

  it("keeps supplier keys encrypted and never lists them", async () => {
    await library.save({ type: "conversation", name: "Primary", base_url: "https://model.example/v1",
      model_id: "model-a", api_key: "secret-a", local: false }, async () => []);
    const listed = await library.list("conversation");
    expect(listed.profiles[0].has_api_key).toBe(true);
    expect(JSON.stringify(listed)).not.toContain("secret-a");
    expect(rows.get("conversation")).not.toContain("secret-a");
    const { profile } = await library.get("conversation", listed.profiles[0].id as string);
    expect(decryptUpstreamKey(profile.encrypted_key)).toBe("secret-a");
  });

  it("keeps the prior selection when another profile fails validation", async () => {
    const input = { type: "conversation" as const, base_url: "https://model.example/v1",
      model_id: "model-a", api_key: "secret-a", local: false };
    await library.save({ ...input, name: "Primary" }, async () => []);
    await library.save({ ...input, name: "Backup" }, async () => []);
    const listed = await library.list("conversation");
    const first = listed.profiles[0].id as string;
    const second = listed.profiles[1].id as string;
    await library.activate("conversation", first, async () => [{ protocol: "chat", status: "ready" }]);
    await expect(library.activate("conversation", second, async () => [{ protocol: "chat", status: "http_error", httpStatus: 401 }]))
      .rejects.toThrow("upstream_probe_failed");
    const after = await library.list("conversation");
    expect(after.active_id).toBe(first);
    expect(after.profiles[1].probe_failed).toBe(true);
    expect(after.profiles[1].probe_results).toEqual([{ protocol: "chat", status: "http_error", httpStatus: 401 }]);
  });

  it("requires a new key before changing supplier origin", async () => {
    await library.save({ type: "extraction", name: "Summary", base_url: "https://first.example/v1",
      model_id: "first", api_key: "first-key", local: false }, async () => []);
    const listed = await library.list("extraction");
    const id = listed.profiles[0].id as string;
    await expect(library.save({ type: "extraction", id, name: "Summary",
      base_url: "https://second.example/v1", model_id: "second", local: false }, async () => []))
      .rejects.toThrow("upstream_api_key_required");
    const { profile } = await library.get("extraction", id);
    expect(profile.base_url).toBe("https://first.example/v1");
    expect(decryptUpstreamKey(profile.encrypted_key)).toBe("first-key");
  });

  it("marks an unreachable candidate red without changing the active profile", async () => {
    const input = { type: "conversation" as const, base_url: "https://model.example/v1",
      model_id: "model-a", api_key: "secret-a", local: false };
    await library.save({ ...input, name: "Primary" }, async () => []);
    await library.save({ ...input, name: "Candidate" }, async () => []);
    const before = await library.list("conversation");
    const first = before.profiles[0].id as string;
    const second = before.profiles[1].id as string;
    await library.activate("conversation", first, async () => [{ protocol: "chat", status: "ready" }]);
    await expect(library.activate("conversation", second, async () => { throw new Error("network unavailable"); }))
      .rejects.toThrow("network unavailable");
    const after = await library.list("conversation");
    expect(after.active_id).toBe(first);
    expect(after.profiles[1].probe_failed).toBe(true);
  });

  it("replaces an active edit only after the new model passes", async () => {
    await library.save({ type: "conversation", name: "Primary", base_url: "https://model.example/v1",
      model_id: "old-model", api_key: "secret-a", local: false }, async () => []);
    const id = (await library.list("conversation")).profiles[0].id as string;
    await library.activate("conversation", id, async () => [{ protocol: "chat", status: "ready" }]);
    const edit = { type: "conversation" as const, id, name: "Primary", base_url: "https://model.example/v1",
      model_id: "new-model", local: false };
    await expect(library.save(edit, async () => [{ protocol: "chat", status: "http_error" }]))
      .rejects.toThrow("upstream_probe_failed");
    expect((await library.get("conversation", id)).profile.model_id).toBe("old-model");
    await library.save(edit, async () => [{ protocol: "chat", status: "ready" }]);
    expect((await library.get("conversation", id)).profile.model_id).toBe("new-model");
    expect((await library.list("conversation")).active_id).toBe(id);
  });

  it("does not mark a model invalid when probing is rate limited", async () => {
    await library.save({ type: "conversation", name: "Candidate", base_url: "https://model.example/v1",
      model_id: "model", api_key: "secret", local: false }, async () => []);
    const id = (await library.list("conversation")).profiles[0].id as string;
    await expect(library.activate("conversation", id, async () => {
      throw Object.assign(new Error("rate limited"), { code: "proxy_probe_rate_limited" });
    })).rejects.toThrow("rate limited");
    const listed = await library.list("conversation");
    expect(listed.active_id).toBeNull();
    expect(listed.profiles[0].probe_failed).toBe(false);
  });

  it("imports a legacy Panel key as an inactive encrypted SQLite profile", async () => {
    const store = new SqliteMetadataStore(":memory:");
    await store.init();
    try {
      store.upsertInstanceUpstreamConfig({ agent_source: "default", type: "conversation",
        mode: "custom_unified", base_url: "https://legacy.example/v1", model_id: "legacy",
        api_key: "legacy-secret" });
      const migrated = new UpstreamProfileLibrary(store);
      const listed = await migrated.list("conversation");
      expect(listed.active_id).toBeNull();
      expect(listed.profiles).toHaveLength(1);
      expect(listed.profiles[0].has_api_key).toBe(true);
      expect(await store.getInstanceUpstreamConfig("default", "conversation")).toBeNull();
      expect((await store.getConfigParam("global", null, "upstream_profiles", "conversation"))?.param_value)
        .not.toContain("legacy-secret");
    } finally { await store.close(); }
  });
});

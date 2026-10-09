import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { SqliteMetadataStore } from "../store/sqlite-adapter.js";
import { MetadataService } from "./metadata-service.js";
import { encryptUpstreamKey, decryptUpstreamKey } from "./upstream-profile-library.js";
import { supported, upstreamFixture } from "./upstream-group-test-fixture.js";

describe("encrypted model-group migration", () => {
  let f: ReturnType<typeof upstreamFixture>;
  beforeEach(() => { f = upstreamFixture(); });
  afterEach(() => f.cleanup());
  async function legacy(type: "conversation" | "extraction", active = true) {
    const now = new Date().toISOString();
    const library = { profiles: [{ id: type, name: `Imported ${type}`, type,
      base_url: "https://model.example/v1", model_id: `${type}-model`, encrypted_key: encryptUpstreamKey(`${type}-secret`),
      local: false, ready_protocols: ["chat"], probe_results: [], probe_failed: false, checked_at: now, created_at: now, updated_at: now }], active_id: active ? type : null };
    f.store.upsertConfigParam({ scope: "global", module: "upstream_profiles", param_name: type,
      param_value: JSON.stringify(library), description: "archived source" });
    return library;
  }
  it("authenticates ciphertext and never writes a supplier key in plaintext", () => {
    const sealed = encryptUpstreamKey("supplier-secret");
    expect(sealed).not.toContain("supplier-secret");
    expect(decryptUpstreamKey(sealed)).toBe("supplier-secret");
    const pieces = sealed.split(":"); pieces[2] = Buffer.alloc(16).toString("base64");
    expect(() => decryptUpstreamKey(pieces.join(":"))).toThrow();
  });
  it("imports active dialogue and summary profiles while retaining their encrypted archive", async () => {
    const old = await legacy("conversation"); await legacy("extraction");
    const publicRows = await f.service.listInstanceUpstreamGroups(supported);
    expect(JSON.stringify(publicRows)).not.toContain("conversation-secret");
    const rows = f.store.listInstanceUpstreamGroups();
    expect(rows.find((r) => r.group_type === "default")?.agents).toEqual([]);
    expect(rows.find((r) => r.group_type === "custom")?.agents.sort()).toEqual(["codex", "pi"]);
    expect(rows.find((r) => r.group_type === "extraction")?.agents).toEqual([]);
    const internal = await f.service.listInstanceUpstreamGroupsInternal(supported);
    expect(internal.items.find((r) => r.group_type === "custom")?.api_key).toBe("conversation-secret");
    expect(JSON.parse(f.store.getConfigParam("global", null, "upstream_profiles", "conversation")!.param_value)).toEqual(old);
    expect(readFileSync(f.dbPath).includes(Buffer.from("conversation-secret"))).toBe(false);
    expect(readFileSync(f.dbPath).includes(Buffer.from("extraction-secret"))).toBe(false);
  });
  it("is idempotent across repeated initialization and process restarts", async () => {
    await legacy("conversation");
    await f.service.listInstanceUpstreamGroups(supported);
    const before = f.store.listInstanceUpstreamGroups();
    f.store.close(); f.store.init();
    const service = new MetadataService(f.store);
    await service.listInstanceUpstreamGroups(supported);
    expect(f.store.listInstanceUpstreamGroups()).toEqual(before);
  });
  it("archives a v1 model table once instead of deleting it during initialization", () => {
    f.store.close();
    const db = new DatabaseSync(f.dbPath);
    db.exec("DROP TABLE meta_instance_upstream_config; CREATE TABLE meta_instance_upstream_config (agent_source TEXT, model_id TEXT, api_key TEXT); INSERT INTO meta_instance_upstream_config VALUES ('default','legacy-model','')");
    db.close();
    f.store.init(); f.store.close(); f.store.init();
    const reader = new DatabaseSync(f.dbPath, { readOnly: true });
    expect(reader.prepare("SELECT model_id FROM meta_instance_upstream_config_v1_archive").get()).toMatchObject({ model_id: "legacy-model" });
    reader.close();
    expect(f.store.listInstanceUpstreamGroups()).toEqual([]);
  });
  it("rolls back the whole profile import if a database write fails", async () => {
    await legacy("conversation"); await legacy("extraction");
    const db = new DatabaseSync(f.dbPath);
    db.exec("CREATE TRIGGER reject_summary BEFORE INSERT ON meta_instance_upstream_config WHEN NEW.group_type = 'extraction' BEGIN SELECT RAISE(ABORT,'injected write failure'); END");
    db.close();
    await expect(f.service.listInstanceUpstreamGroups(supported)).rejects.toThrow("injected write failure");
    expect(f.store.listInstanceUpstreamGroups()).toEqual([]);
    expect(f.store.getConfigParam("global", null, "upstream_group_migration", "profiles_v1")).toBeNull();
  });
  it("does not resurrect a deleted group from its archived profile", async () => {
    await legacy("conversation");
    await f.service.listInstanceUpstreamGroups(supported);
    const custom = f.store.listInstanceUpstreamGroups().find((r) => r.group_type === "custom")!;
    await f.service.deleteInstanceUpstreamGroup({ group_id: custom.group_id }, supported);
    f.store.close(); f.store.init();
    await new MetadataService(f.store).listInstanceUpstreamGroups(supported);
    expect(f.store.listInstanceUpstreamGroups().some((r) => r.group_type === "custom")).toBe(false);
  });
  it("leaves inactive profiles archived and seeds the official default", async () => {
    await legacy("conversation", false);
    await f.service.listInstanceUpstreamGroups(supported);
    expect(f.store.listInstanceUpstreamGroups()).toHaveLength(1);
    expect(f.store.listInstanceUpstreamGroups()[0].agents.sort()).toEqual(["codex", "pi"]);
  });
  it("fails before mutation when the wrapping Secret cannot decrypt the active key", async () => {
    await legacy("conversation");
    const original = process.env.TDAI_LLM_CONFIG_ENCRYPTION_KEY_FILE;
    process.env.TDAI_LLM_CONFIG_ENCRYPTION_KEY_FILE = `${f.directory}/missing`;
    await expect(f.service.listInstanceUpstreamGroups(supported)).rejects.toThrow();
    expect(f.store.listInstanceUpstreamGroups()).toEqual([]);
    expect(f.store.getConfigParam("global", null, "upstream_group_migration", "profiles_v1")).toBeNull();
    process.env.TDAI_LLM_CONFIG_ENCRYPTION_KEY_FILE = original;
  });
});

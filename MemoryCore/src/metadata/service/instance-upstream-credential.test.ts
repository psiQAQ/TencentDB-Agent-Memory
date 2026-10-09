import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { supported, upstreamFixture } from "./upstream-group-test-fixture.js";
import { decryptUpstreamKey } from "./upstream-profile-library.js";

describe("model-group credential isolation", () => {
  let f: ReturnType<typeof upstreamFixture>;
  beforeEach(() => { f = upstreamFixture(); });
  afterEach(() => f.cleanup());
  async function create() {
    await f.service.listInstanceUpstreamGroups(supported);
    const def = f.store.listInstanceUpstreamGroups()[0];
    await f.service.updateInstanceUpstreamGroup({ group_id: def.group_id, group_type: "default", agents: [] }, supported);
    return f.service.createInstanceUpstreamCustomGroup({ name: "Primary", agents: ["codex"], mode: "custom_unified",
      base_url: "https://provider.example/v1", model_id: "model-a", api_key: "supplier-secret" }, supported);
  }
  it("encrypts new credentials and returns only a mask through normal APIs", async () => {
    const result = await create();
    expect(JSON.stringify(result)).not.toContain("supplier-secret");
    expect(result.api_key_masked).toBeTruthy();
    const row = f.store.getInstanceUpstreamGroup(String(result.group_id))!;
    expect(row.api_key).toMatch(/^v1:/);
    expect(decryptUpstreamKey(row.api_key)).toBe("supplier-secret");
  });
  it("distinguishes the official model fallback from disabled and unassigned Agents", async () => {
    const before = await f.service.getConversationModelsInternal(supported);
    expect(before.official_agents.sort()).toEqual(["codex", "pi"]);
    await create();
    const custom = await f.service.getConversationModelsInternal(supported);
    expect(custom.model_ids).toEqual({ codex: "model-a", pi: null });
    expect(custom.official_agents).toEqual([]);
  });
  it("requires an independent key before changing supplier origin", async () => {
    const result = await create();
    await expect(f.service.updateInstanceUpstreamGroup({ group_id: String(result.group_id), group_type: "custom",
      base_url: "https://other.example/v1" }, supported)).rejects.toThrow("own api_key");
    expect(f.store.getInstanceUpstreamGroup(String(result.group_id))!.base_url).toBe("https://provider.example/v1");
  });
  it("retains the encrypted key for another path on the same supplier", async () => {
    const result = await create();
    const before = f.store.getInstanceUpstreamGroup(String(result.group_id))!.api_key;
    await f.service.updateInstanceUpstreamGroup({ group_id: String(result.group_id), group_type: "custom", base_url: "https://provider.example/v2" }, supported);
    expect(f.store.getInstanceUpstreamGroup(String(result.group_id))!.api_key).toBe(before);
  });
  it("rejects endpoint credentials and query secrets", async () => {
    await expect(f.service.createInstanceUpstreamCustomGroup({ name: "Unsafe", agents: ["codex"], mode: "custom_unified",
      base_url: "https://user:secret@provider.example/v1?key=secret", api_key: "key" }, supported)).rejects.toThrow("must not contain credentials");
  });
  it("encrypts extraction credentials and retains configuration after restart", async () => {
    await f.service.createInstanceUpstreamExtraction({ base_url: "https://provider.example/v1", api_key: "summary-secret", model_id: "summary-model" }, supported);
    const before = await f.service.getInstanceUpstreamExtraction(supported);
    expect(JSON.stringify(before)).not.toContain("summary-secret");
    f.store.close(); f.store.init();
    expect(await f.service.getInstanceUpstreamExtraction(supported)).toEqual(before);
  });
});

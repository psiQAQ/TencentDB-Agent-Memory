import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { supported, upstreamFixture } from "./upstream-group-test-fixture.js";
import { decryptUpstreamKey } from "./upstream-profile-library.js";
import { upstreamGroupsCreateSchema } from "../router/v3-meta-schemas.js";

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
  it("saves a model group before assigning clients without changing current routing", async () => {
    const before = await f.service.getConversationModelsInternal(supported);
    const input = upstreamGroupsCreateSchema.parse({ group_type: "custom", name: "Ready to assign", agents: [],
      mode: "custom_unified", base_url: "https://provider.example/v1", model_id: "model-a", api_key: "supplier-secret" });
    const result = await f.service.createInstanceUpstreamCustomGroup(input, supported);
    expect(result.agents).toEqual([]);
    expect(await f.service.getConversationModelsInternal(supported)).toEqual(before);
    f.store.close(); f.store.init();
    expect((await f.service.listInstanceUpstreamGroups(supported)).items).toContainEqual(result);
  });
  it("can release the last client from a custom group while retaining its model and encrypted credential", async () => {
    const result = await create();
    const groupId = String(result.group_id);
    const before = f.store.getInstanceUpstreamGroup(groupId)!;
    const updated = await f.service.updateInstanceUpstreamGroup({ group_id: groupId, group_type: "custom",
      agents: [], expected_version: before.version }, supported);
    expect(updated.agents).toEqual([]);
    expect(f.store.getInstanceUpstreamGroup(groupId)!.api_key).toBe(before.api_key);
    const def = f.store.listInstanceUpstreamGroups().find((row) => row.group_type === "default")!;
    await f.service.updateInstanceUpstreamGroup({ group_id: def.group_id, group_type: "default", agents: ["codex"] }, supported);
    expect((await f.service.getConversationModelsInternal(supported)).official_agents).toEqual(["codex"]);
  });
  it("removes a stored supplier credential when switching to client credential passthrough", async () => {
    const result = await create();
    const groupId = String(result.group_id);
    await f.service.updateInstanceUpstreamGroup({ group_id: groupId, group_type: "custom",
      mode: "custom_passthrough", base_url: "https://other.example/v1" }, supported);
    expect(f.store.getInstanceUpstreamGroup(groupId)!.api_key).toBe("");
    await expect(f.service.updateInstanceUpstreamGroup({ group_id: groupId, group_type: "custom",
      mode: "custom_unified" }, supported)).rejects.toThrow("own api_key");
  });
  it("does not save an unused supplier credential for a new passthrough group", async () => {
    await f.service.listInstanceUpstreamGroups(supported);
    const def = f.store.listInstanceUpstreamGroups()[0];
    await f.service.updateInstanceUpstreamGroup({ group_id: def.group_id, group_type: "default", agents: [] }, supported);
    const result = await f.service.createInstanceUpstreamCustomGroup({ name: "Client credentials", agents: ["codex"],
      mode: "custom_passthrough", base_url: "https://provider.example/v1", api_key: "unused-secret" }, supported);
    expect(result.api_key_masked).toBe("");
    expect(f.store.getInstanceUpstreamGroup(String(result.group_id))!.api_key).toBe("");
  });
});

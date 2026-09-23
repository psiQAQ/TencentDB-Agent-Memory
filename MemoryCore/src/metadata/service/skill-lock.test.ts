import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { V3AuthContext } from "../router/auth.js";
import { SqliteMetadataStore } from "../store/sqlite-adapter.js";
import { MetadataService } from "./metadata-service.js";

describe("Skill lock metadata authorization", () => {
  let store: SqliteMetadataStore;
  let service: MetadataService;
  let ownerId: string;
  let teamId: string;
  let caller: V3AuthContext;

  beforeEach(async () => {
    store = new SqliteMetadataStore(":memory:");
    await store.init();
    service = new MetadataService(store);
    ownerId = (await store.createUser({
      username: "skill-owner", auth_provider: "local", external_id: "skill-owner",
    })).user_id;
    teamId = (await service.createTeam({ name: "Skills", owner_user_id: ownerId })).team_id;
    caller = { token: "synthetic-test-key", userId: ownerId, isAdmin: false, isSystemAdmin: false };
  });

  afterEach(async () => { await store.close(); });

  it("reserves lock transitions for the internal action and preserves read-only state", async () => {
    const input = {
      asset_id: "skl-locked", team_id: teamId, asset_type: "skill" as const,
      owner_user_id: ownerId, name: "Locked Skill", source_type: "manual",
      visibility: "team" as const, status: "active" as const,
    };
    await expect(service.createAssetForCaller({
      ...input, metadata_json: '{"skill_lock":{"locked":true}}',
    }, caller)).rejects.toMatchObject({ code: "skill_lock_requires_internal" });
    await service.createAssetForCaller(input, caller);
    await expect(service.updateAssetForCaller(input.asset_id, {
      metadata_json: '{"skill_lock":{"locked":true}}',
    }, caller)).rejects.toMatchObject({ code: "skill_lock_requires_internal" });

    await expect(service.setSkillLockInternal(input.asset_id, "other-user", true))
      .rejects.toMatchObject({ code: "stale_lifecycle_operation" });
    const locked = await service.setSkillLockInternal(input.asset_id, ownerId, true);
    expect(JSON.parse(locked.metadata_json).skill_lock.locked).toBe(true);
    await expect(service.updateAssetForCaller(input.asset_id, { name: "Changed" }, caller))
      .rejects.toMatchObject({ code: "skill_locked" });
    await expect(service.updateAssetForCaller(input.asset_id, {
      metadata_json: '{"skill_lock":{"locked":false}}',
    }, caller)).rejects.toMatchObject({ code: "skill_locked" });

    const unlocked = await service.setSkillLockInternal(input.asset_id, ownerId, false);
    expect(JSON.parse(unlocked.metadata_json).skill_lock.locked).toBe(false);
    await expect(service.updateAssetForCaller(input.asset_id, { name: "Changed" }, caller))
      .resolves.toMatchObject({ name: "Changed" });
  });
});

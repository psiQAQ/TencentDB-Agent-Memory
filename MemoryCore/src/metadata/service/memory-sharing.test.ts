import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { V3AuthContext } from "../router/auth.js";
import { SqliteMetadataStore } from "../store/sqlite-adapter.js";
import type { AssetEntity, FixedAssetBindingInput } from "../types.js";
import { MetadataService } from "./metadata-service.js";

const caller = (userId: string): V3AuthContext => ({ token: "synthetic-test-key", userId, isAdmin: false, isSystemAdmin: false });

describe("Chat Memory sharing through MetadataService", () => {
  let store: SqliteMetadataStore;
  let service: MetadataService;
  let ownerId: string;
  let readerId: string;
  let teamId: string;
  let agentId: string;
  let asset: AssetEntity;

  beforeEach(async () => {
    store = new SqliteMetadataStore(":memory:");
    await store.init();
    service = new MetadataService(store);
    ownerId = (await store.createUser({ username: "owner", auth_provider: "local", external_id: "owner" })).user_id;
    readerId = (await store.createUser({ username: "reader", auth_provider: "local", external_id: "reader" })).user_id;
    teamId = (await service.createTeam({ name: "Team", owner_user_id: ownerId })).team_id;
    await service.addTeamMember({ team_id: teamId, user_id: readerId, role: "member" });
    agentId = (await service.createAgent({ team_id: teamId, owner_user_id: readerId, name: "Reader" })).agent_id;
    asset = await service.createAsset({ asset_id: "shared-memory", team_id: teamId, owner_user_id: ownerId, asset_type: "chat_memory", name: "Memory", source_type: "manual", visibility: "private", status: "approved" });
  });
  afterEach(async () => { vi.restoreAllMocks(); await store.close(); });

  const binding = (assetId: string): FixedAssetBindingInput => ({ asset_id: assetId, asset_type: "chat_memory", injection_mode: "summary", priority: 50, created_by: "test" });
  const permission = () => service.checkAssetPermission({ user_id: readerId, asset_id: asset.asset_id, action: "read", agent_id: agentId });
  const visible = () => service.listAgentFixedAssetsWithDetailForCaller({ agent_id: agentId, apply_visibility_filter: true }, caller(readerId));

  it.each(["user", "team_role", "agent"] as const)("honors a restricted %s ACL and its revocation", async (subjectType) => {
    await service.updateAssetForCaller(asset.asset_id, { visibility: "restricted" }, caller(ownerId));
    expect((await permission()).allowed).toBe(false);
    const grant = await service.grantAclForCaller({ asset_id: asset.asset_id, subject_type: subjectType,
      subject_id: subjectType === "user" ? readerId : subjectType === "team_role" ? "member" : agentId,
      permission: "read", granted_by: ownerId }, caller(ownerId));
    expect(await permission()).toEqual({ allowed: true, reason: `acl:${grant.id}` });
    const list = await service.listAccessibleAssetsForCaller({ user_id: readerId, team_id: teamId, agent_id: agentId }, caller(readerId));
    expect(list.items.map((item) => item.asset_id)).toContain(asset.asset_id);
    await service.revokeAclForCaller(grant.id, caller(ownerId));
    expect((await permission()).allowed).toBe(false);
    expect((await service.listAccessibleAssetsForCaller({ user_id: readerId, team_id: teamId, agent_id: agentId }, caller(readerId))).items.map((item) => item.asset_id)).not.toContain(asset.asset_id);
  });

  it("does not load ACLs to bypass private, removed-member, or archived boundaries", async () => {
    await service.grantAcl({ asset_id: asset.asset_id, subject_type: "user", subject_id: readerId, permission: "read", granted_by: ownerId });
    const aclRead = vi.spyOn(store, "listAclByAsset");
    expect((await permission()).allowed).toBe(false);
    await service.updateAsset(asset.asset_id, { visibility: "restricted" });
    await store.removeTeamMember(teamId, readerId);
    expect((await permission()).allowed).toBe(false);
    await service.updateAsset(asset.asset_id, { status: "archived" });
    expect((await permission()).reason).toBe("asset_not_available");
    expect(aclRead).not.toHaveBeenCalled();
  });

  it("requires the asset owner to share or grant permissions", async () => {
    await expect(service.updateAssetForCaller(asset.asset_id, { visibility: "team" }, caller(readerId))).rejects.toMatchObject({ code: "permission_denied" });
    await expect(service.grantAclForCaller({ asset_id: asset.asset_id, subject_type: "user", subject_id: readerId, permission: "read", granted_by: readerId }, caller(readerId))).rejects.toMatchObject({ code: "permission_denied" });
    expect((await service.getAssetById(asset.asset_id))?.visibility).toBe("private");
    expect((await store.listAclByAsset(asset.asset_id, { limit: 10, offset: 0 })).items).toEqual([]);
  });

  it("filters retained bindings immediately when sharing is revoked or the asset is archived", async () => {
    await service.updateAssetForCaller(asset.asset_id, { visibility: "team" }, caller(ownerId));
    // Team visibility grants read access; it does not itself bind the reader Agent.
    expect((await permission()).allowed).toBe(true);
    expect((await visible()).items.map((item) => item.asset_id)).not.toContain(asset.asset_id);
    await service.setAgentFixedAssetsForCaller(agentId, [binding(asset.asset_id)], caller(readerId));
    expect((await visible()).items.map((item) => item.asset_id)).toEqual([asset.asset_id]);
    await service.updateAssetForCaller(asset.asset_id, { visibility: "private" }, caller(ownerId));
    expect((await visible()).items).toEqual([]);
    expect((await store.listAgentFixedAssets(agentId, { limit: 10, offset: 0 })).items).toHaveLength(1);
    await service.updateAssetForCaller(asset.asset_id, { visibility: "team" }, caller(ownerId));
    expect((await visible()).items).toHaveLength(1);
    await service.updateAsset(asset.asset_id, { status: "archived" });
    expect((await visible()).items).toEqual([]);
  });

  it("rejects subsequent caller reads when the reader leaves the Team", async () => {
    await service.updateAsset(asset.asset_id, { visibility: "team" });
    await service.setAgentFixedAssetsForCaller(agentId, [binding(asset.asset_id)], caller(readerId));
    await store.removeTeamMember(teamId, readerId);
    await expect(visible()).rejects.toMatchObject({ code: "permission_denied" });
    expect((await permission()).allowed).toBe(false);
  });

  it.each(["private", "cross-team", "missing"])("rejects an entire binding batch containing a %s asset", async (invalidKind) => {
    const original = await store.listAgentFixedAssets(agentId, { limit: 10, offset: 0 });
    const write = vi.spyOn(store, "setAgentFixedAssets");
    await service.updateAsset(asset.asset_id, { visibility: "team" });
    let invalidId = "missing";
    if (invalidKind !== "missing") {
      const otherTeam = invalidKind === "cross-team" ? (await service.createTeam({ name: "Other", owner_user_id: ownerId })).team_id : teamId;
      invalidId = (await service.createAsset({ asset_id: "invalid-memory", team_id: otherTeam, owner_user_id: ownerId, asset_type: "chat_memory", name: "Invalid", source_type: "manual", visibility: invalidKind === "private" ? "private" : "team" })).asset_id;
    }
    await expect(service.setAgentFixedAssetsForCaller(agentId, [binding(asset.asset_id), binding(invalidId)], caller(readerId)))
      .rejects.toMatchObject({ code: invalidKind === "missing" ? "asset_not_found" : "asset_not_bindable" });
    expect(write).not.toHaveBeenCalled();
    expect(await store.listAgentFixedAssets(agentId, { limit: 10, offset: 0 })).toEqual(original);
  });
});

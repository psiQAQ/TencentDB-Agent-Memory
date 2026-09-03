import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteMetadataStore } from "../store/sqlite-adapter.js";
import type { V3AuthContext } from "../router/auth.js";
import { MetadataError, MetadataService } from "./metadata-service.js";

function ctx(userId: string, isSystemAdmin = false): V3AuthContext {
  return { token: `key-${userId}`, userId, isAdmin: false, isSystemAdmin };
}

describe("MetadataService caller-scoped personnel and Team authorization", () => {
  let store: SqliteMetadataStore;
  let service: MetadataService;

  beforeEach(async () => {
    store = new SqliteMetadataStore(":memory:");
    await store.init();
    service = new MetadataService(store);
  });

  afterEach(async () => {
    await store.close();
  });

  async function user(username: string, userType: "normal" | "system_admin" = "normal") {
    return store.createUser({
      username,
      user_type: userType,
      auth_provider: "local",
      external_id: username,
    });
  }

  it("system_admin user creation remains fixed to normal", async () => {
    const admin = await user("bootstrap", "system_admin");
    const created = await service.createNormalUser({ username: "created" });

    expect(created.user_type).toBe("normal");
    await expect(
      Promise.resolve().then(() => store.createUser({
        username: "second-admin",
        user_type: "system_admin",
        auth_provider: "local",
        external_id: "second-admin",
      })),
    ).rejects.toThrow();
    expect((await service.listUsersForCaller({}, ctx(admin.user_id, true), { limit: 20, offset: 0 })).total).toBe(2);
  });

  it("requires active Team membership for Team business reads, including system_admin", async () => {
    const owner = await user("owner");
    const outsider = await user("outsider");
    const admin = await user("bootstrap", "system_admin");
    const team = await service.createTeam({ name: "private-team", owner_user_id: owner.user_id });
    const agent = await service.createAgent({ team_id: team.team_id, owner_user_id: owner.user_id, name: "agent" });
    const task = await service.createTask({ team_id: team.team_id, creator_user_id: owner.user_id, title: "task" });
    const asset = await service.createAsset({
      asset_id: "asset-private",
      team_id: team.team_id,
      asset_type: "skill",
      name: "asset",
      owner_user_id: owner.user_id,
      source_type: "manual",
    });

    await expect(service.getTeamForCaller(team.team_id, ctx(outsider.user_id))).rejects.toMatchObject({ code: "permission_denied" });
    await expect(service.getAgentForCaller(agent.agent_id, ctx(admin.user_id, true))).rejects.toMatchObject({ code: "permission_denied" });
    await expect(service.listTasksByTeamForCaller(team.team_id, ctx(outsider.user_id))).rejects.toMatchObject({ code: "permission_denied" });
    await expect(service.getAssetForCaller(asset.asset_id, ctx(outsider.user_id))).rejects.toMatchObject({ code: "permission_denied" });
    await expect(service.listAgentsByOwnerForCaller(owner.user_id, ctx(outsider.user_id))).rejects.toMatchObject({ code: "permission_denied" });
    await expect(service.listAccessibleAssetsForCaller(
      { user_id: owner.user_id, team_id: team.team_id },
      ctx(outsider.user_id),
    )).rejects.toMatchObject({ code: "permission_denied" });

    await service.addTeamMember({ team_id: team.team_id, user_id: admin.user_id, role: "member" });
    await expect(service.getAgentForCaller(agent.agent_id, ctx(admin.user_id, true))).resolves.toMatchObject({ agent_id: agent.agent_id });
    await expect(service.getTaskForCaller(task.task_id, ctx(admin.user_id, true))).resolves.toMatchObject({ task_id: task.task_id });
    await expect(service.listAssetsByTeamForCaller(team.team_id, ctx(admin.user_id, true))).resolves.toMatchObject({ total: 2 });
  });

  it("lets system_admin inspect cross-Team personnel relations without granting business reads", async () => {
    const owner = await user("owner");
    const admin = await user("bootstrap", "system_admin");
    const team = await service.createTeam({ name: "org", owner_user_id: owner.user_id });

    await expect(service.listTeamsForCaller(owner.user_id, ctx(admin.user_id, true)))
      .resolves.toMatchObject({ items: [expect.objectContaining({ team_id: team.team_id })] });
    await expect(service.listTeamMembersForCaller(team.team_id, ctx(admin.user_id, true)))
      .resolves.toMatchObject({ items: [expect.objectContaining({ user_id: owner.user_id, role: "admin" })] });
    await expect(service.getTeamForCaller(team.team_id, ctx(admin.user_id, true)))
      .rejects.toMatchObject({ code: "permission_denied" });
  });

  it("does not grant Team writes to a system_admin who is only a member", async () => {
    const owner = await user("owner");
    const admin = await user("bootstrap", "system_admin");
    const invited = await user("invited");
    const team = await service.createTeam({ name: "autonomous", owner_user_id: owner.user_id });
    await service.addTeamMember({ team_id: team.team_id, user_id: admin.user_id, role: "member" });

    await expect(
      service.addTeamMemberForCaller(
        { team_id: team.team_id, user_id: invited.user_id, role: "reviewer" },
        ctx(admin.user_id, true),
      ),
    ).rejects.toMatchObject({ code: "permission_denied" });

    await service.addTeamMemberForCaller(
      { team_id: team.team_id, user_id: admin.user_id, role: "admin" },
      ctx(owner.user_id),
    );
    await expect(
      service.addTeamMemberForCaller(
        { team_id: team.team_id, user_id: invited.user_id, role: "reviewer" },
        ctx(admin.user_id, true),
      ),
    ).resolves.toMatchObject({ role: "reviewer" });
  });

  it("rejects the entire delete batch when any user owns resources", async () => {
    const admin = await user("bootstrap", "system_admin");
    const owner = await user("owner");
    const disposable = await user("disposable");
    const team = await service.createTeam({ name: "owned", owner_user_id: owner.user_id });
    await service.createAgent({ team_id: team.team_id, owner_user_id: owner.user_id, name: "agent" });
    await service.createTask({ team_id: team.team_id, creator_user_id: owner.user_id, title: "task" });

    await expect(service.deleteUsersForCaller([owner.user_id, disposable.user_id], ctx(admin.user_id, true)))
      .rejects.toMatchObject<Partial<MetadataError>>({
        code: "user_has_owned_resources",
        data: { blockers: [expect.objectContaining({ user_id: owner.user_id })] },
      });
    expect(store.getUserById(disposable.user_id)).not.toBeNull();
    expect(store.getUserOwnedResourceCounts(owner.user_id)).toMatchObject({
      teams: 1,
      agents: 1,
      tasks: 1,
    });
  });

  it("lists minimal owned-resource dependencies for self, Team admin, and system_admin", async () => {
    const owner = await user("owner");
    const member = await user("member");
    const outsider = await user("outsider");
    const admin = await user("bootstrap", "system_admin");
    const team = await service.createTeam({ name: "dependency-team", owner_user_id: owner.user_id });
    await service.addTeamMember({ team_id: team.team_id, user_id: member.user_id, role: "member" });
    await service.createAgent({
      team_id: team.team_id,
      owner_user_id: member.user_id,
      name: "member-agent",
      prompt: "must-not-leak",
      status: "inactive",
    });
    await service.createTask({
      team_id: team.team_id,
      creator_user_id: member.user_id,
      title: "member-task",
      description: "must-not-leak",
    });
    await service.createAsset({
      asset_id: "asset-dependency",
      team_id: team.team_id,
      asset_type: "skill",
      name: "member-skill",
      description: "must-not-leak",
      owner_user_id: member.user_id,
      source_type: "manual",
      status: "archived",
    });

    const own = await service.listUserDependenciesForCaller(member.user_id, {}, ctx(member.user_id));
    expect(own.counts).toMatchObject({ teams: 0, agents: 1, tasks: 1, assets: 2, total: 4 });
    expect(own.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "member-agent", status: "inactive", membership_status: "active" }),
      expect.objectContaining({ name: "member-skill", status: "archived", asset_type: "skill" }),
    ]));
    expect(JSON.stringify(own)).not.toContain("must-not-leak");

    await expect(service.listUserDependenciesForCaller(
      member.user_id,
      { team_id: team.team_id },
      ctx(owner.user_id),
    )).resolves.toMatchObject({ counts: { agents: 1, tasks: 1, assets: 2 } });
    await expect(service.listUserDependenciesForCaller(member.user_id, {}, ctx(admin.user_id, true)))
      .resolves.toMatchObject({ counts: { total: 4 } });
    await expect(service.listUserDependenciesForCaller(member.user_id, {}, ctx(outsider.user_id)))
      .rejects.toMatchObject({ code: "permission_denied" });
    await expect(service.listUserDependenciesForCaller(
      member.user_id,
      { team_id: team.team_id },
      ctx(outsider.user_id),
    )).rejects.toMatchObject({ code: "permission_denied" });
  });

  it("blocks member removal for active or archived resources without changing membership", async () => {
    const owner = await user("owner");
    const member = await user("member");
    const team = await service.createTeam({ name: "offboarding-team", owner_user_id: owner.user_id });
    await service.addTeamMember({ team_id: team.team_id, user_id: member.user_id, role: "member" });
    await service.createAgent({
      team_id: team.team_id,
      owner_user_id: member.user_id,
      name: "inactive-agent",
      status: "inactive",
    });

    await expect(service.removeTeamMemberForCaller(team.team_id, member.user_id, ctx(owner.user_id)))
      .rejects.toMatchObject<Partial<MetadataError>>({
        code: "member_has_owned_resources",
        data: {
          user_id: member.user_id,
          team_id: team.team_id,
          counts: expect.objectContaining({ agents: 1 }),
        },
      });
    expect(await store.getTeamMember(team.team_id, member.user_id))
      .toMatchObject({ status: "active" });

    const deps = await service.listUserDependenciesForCaller(member.user_id, {}, ctx(member.user_id));
    await service.deleteAssets(deps.items.filter((item) => item.resource_type === "asset").map((item) => item.resource_id));
    await service.deleteAgents(deps.items.filter((item) => item.resource_type === "agent").map((item) => item.resource_id));
    await expect(service.removeTeamMemberForCaller(team.team_id, member.user_id, ctx(owner.user_id))).resolves.toBeUndefined();
    const orphanView = await service.listUserDependenciesForCaller(member.user_id, {}, ctx(member.user_id));
    expect(orphanView.items).toHaveLength(0);
  });

  it("deletes a resource-free normal user and protects the last system_admin", async () => {
    const admin = await user("bootstrap", "system_admin");
    const disposable = await user("disposable");

    await expect(service.deleteUsersForCaller([disposable.user_id], ctx(admin.user_id, true)))
      .resolves.toMatchObject({ deleted_ids: [disposable.user_id] });
    await expect(service.deleteUsersForCaller([admin.user_id], ctx(admin.user_id, true)))
      .rejects.toMatchObject({ code: "last_system_admin" });
  });
});

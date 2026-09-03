import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteMetadataStore } from "../store/sqlite-adapter.js";
import type { V3AuthContext } from "../router/auth.js";
import { MetadataError, MetadataService } from "./metadata-service.js";
import { teamMemberAddSchema } from "../router/v3-meta-schemas.js";

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

  it("rejects public attempts to add a member with status=removed", () => {
    expect(teamMemberAddSchema.safeParse({
      team_id: "team-1",
      user_id: "user-1",
      role: "member",
      status: "removed",
    }).success).toBe(false);
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

    await service.updateTeamMemberRoleForCaller(team.team_id, admin.user_id, "admin", ctx(owner.user_id));
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
    expect(own.asset_counts).toMatchObject({ skill: 1, chat_memory: 1, llm_wiki: 0, code_graph: 0, other: 0 });
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

  it("does not let a Team admin create ownership for another member", async () => {
    const owner = await user("owner");
    const member = await user("member");
    const team = await service.createTeam({ name: "team", owner_user_id: owner.user_id });
    await service.addTeamMember({ team_id: team.team_id, user_id: member.user_id, role: "member" });
    await expect(service.createAgentForCaller({
      team_id: team.team_id,
      owner_user_id: member.user_id,
      name: "surprise-agent",
    }, ctx(owner.user_id))).rejects.toMatchObject({ code: "permission_denied" });
  });

  it("blocks direct Agent deletion while aggregate child assets still exist", async () => {
    const owner = await user("aggregate-owner");
    const team = await service.createTeam({ name: "aggregate-team", owner_user_id: owner.user_id });
    const agent = await service.createAgentForCaller({
      team_id: team.team_id,
      owner_user_id: owner.user_id,
      name: "aggregate-agent",
    }, ctx(owner.user_id));

    await expect(service.deleteAgentsForCaller([agent.agent_id], ctx(owner.user_id)))
      .rejects.toMatchObject({ code: "managed_resource_requires_lifecycle" });
  });

  it("requires lifecycle finalize for managed assets and blocks transfer target while pending", async () => {
    const owner = await user("knowledge-owner");
    const target = await user("knowledge-target");
    const team = await service.createTeam({ name: "knowledge-team", owner_user_id: owner.user_id });
    await service.addTeamMember({ team_id: team.team_id, user_id: target.user_id, role: "member" });
    const asset = await service.createAsset({
      asset_id: "wiki-lifecycle-test",
      team_id: team.team_id,
      owner_user_id: owner.user_id,
      asset_type: "llm_wiki",
      name: "Lifecycle Wiki",
      source_type: "manual",
    });
    await expect(service.deleteAssetsForCaller([asset.asset_id], ctx(owner.user_id)))
      .rejects.toMatchObject({ code: "managed_resource_requires_lifecycle" });

    const operation = {
      team_id: team.team_id,
      asset_id: asset.asset_id,
      from_owner_user_id: owner.user_id,
      to_owner_user_id: target.user_id,
      idempotency_key: "22222222-2222-4222-8222-222222222222",
    };
    await expect(service.prepareAssetTransferInternal(operation)).resolves.toMatchObject({ status: "pending" });
    await expect(service.leaveTeamForCaller(team.team_id, ctx(target.user_id)))
      .rejects.toMatchObject({ code: "lifecycle_operation_in_progress" });
    await expect(service.finalizeAssetTransferInternal(operation)).resolves.toMatchObject({ transferred: true });
    expect(await service.getAssetById(asset.asset_id)).toMatchObject({ owner_user_id: target.user_id });
  });

  it("requires Team ownership transfer before self leave and keeps Task creator immutable", async () => {
    const owner = await user("owner");
    const nextAdmin = await user("next-admin");
    const team = await service.createTeam({ name: "handoff", owner_user_id: owner.user_id });
    await service.addTeamMember({ team_id: team.team_id, user_id: nextAdmin.user_id, role: "admin" });
    const task = await service.createTask({
      team_id: team.team_id,
      creator_user_id: owner.user_id,
      title: "handoff-task",
    });

    await expect(service.leaveTeamForCaller(team.team_id, ctx(owner.user_id)))
      .rejects.toMatchObject({ code: "team_owner_transfer_required" });
    const transfer = await service.transferOwnershipForCaller({
      team_id: team.team_id,
      transfers: [
        { resource_type: "task", resource_id: task.task_id, to_user_id: nextAdmin.user_id },
        { resource_type: "team", resource_id: team.team_id, to_user_id: nextAdmin.user_id },
      ],
      idempotency_key: "11111111-1111-4111-8111-111111111111",
    }, ctx(owner.user_id));
    expect(transfer.items.every((item) => item.transferred)).toBe(true);
    expect(await service.getTaskById(task.task_id)).toMatchObject({
      creator_user_id: owner.user_id,
      owner_user_id: nextAdmin.user_id,
    });
    await expect(service.leaveTeamForCaller(team.team_id, ctx(owner.user_id))).resolves.toBeUndefined();
    expect(await store.getTeamMember(team.team_id, owner.user_id)).toBeNull();
  });

  it("moves Agent chat-memory ownership before committing metadata ownership", async () => {
    const owner = await user("agent-owner");
    const recipient = await user("agent-recipient");
    const team = await service.createTeam({ name: "agent-handoff", owner_user_id: owner.user_id });
    await service.addTeamMember({ team_id: team.team_id, user_id: recipient.user_id, role: "member" });
    const agent = await service.createAgent({ team_id: team.team_id, owner_user_id: owner.user_id, name: "agent" });
    const sourceAgent = await service.createAgent({ team_id: team.team_id, owner_user_id: owner.user_id, name: "source-agent" });
    const selfMemoryId = `chat_memory-${team.team_id}-${agent.agent_id}`;
    const borrowedMemoryId = `chat_memory-${team.team_id}-${sourceAgent.agent_id}`;
    for (const assetId of [selfMemoryId, borrowedMemoryId]) {
      if (!await service.getAssetById(assetId)) {
        await service.createAsset({
          asset_id: assetId,
          team_id: team.team_id,
          asset_type: "chat_memory",
          name: assetId,
          owner_user_id: owner.user_id,
          source_type: "auto",
        });
      }
    }
    await service.setAgentFixedAssets(agent.agent_id, [
      { asset_id: selfMemoryId, asset_type: "chat_memory", created_by: owner.user_id },
      { asset_id: borrowedMemoryId, asset_type: "chat_memory", created_by: owner.user_id },
    ]);
    const visibleBindings = await service.listAgentFixedAssetsWithDetailForCaller(
      { agent_id: agent.agent_id, apply_visibility_filter: true },
      ctx(owner.user_id),
    );
    expect(visibleBindings.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ asset_id: selfMemoryId, owner_user_id: owner.user_id }),
    ]));
    const calls: Array<{ fromOwnerUserId: string; toOwnerUserId: string }> = [];
    service.setChatMemoryOwnerTransfer(async (input) => {
      calls.push(input);
      return { l0Updated: 2, l1Updated: 1 };
    });

    const result = await service.transferOwnershipForCaller({
      team_id: team.team_id,
      transfers: [{ resource_type: "agent", resource_id: agent.agent_id, to_user_id: recipient.user_id }],
      idempotency_key: "22222222-2222-4222-8222-222222222222",
    }, ctx(owner.user_id));

    expect(result.items[0]).toMatchObject({ transferred: true, resource_id: agent.agent_id });
    expect(calls).toEqual([
      { teamId: team.team_id, agentId: agent.agent_id,
        fromOwnerUserId: owner.user_id, toOwnerUserId: recipient.user_id },
      { teamId: team.team_id, agentId: sourceAgent.agent_id,
        fromOwnerUserId: owner.user_id, toOwnerUserId: recipient.user_id },
    ]);
    expect(await service.getAgentById(agent.agent_id)).toMatchObject({ owner_user_id: recipient.user_id });
    expect(await service.getAssetById(selfMemoryId)).toMatchObject({ owner_user_id: recipient.user_id });
    expect(await service.getAssetById(borrowedMemoryId)).toMatchObject({ owner_user_id: recipient.user_id });
  });

  it("allows standalone Chat Memory transfer without changing its Agent owner", async () => {
    const owner = await user("memory-owner");
    const recipient = await user("memory-recipient");
    const team = await service.createTeam({ name: "memory-handoff", owner_user_id: owner.user_id });
    await service.addTeamMember({ team_id: team.team_id, user_id: recipient.user_id, role: "member" });
    const agent = await service.createAgent({ team_id: team.team_id, owner_user_id: owner.user_id, name: "agent" });
    const memoryId = `chat_memory-${team.team_id}-${agent.agent_id}`;
    const calls: Array<{ teamId: string; agentId: string; fromOwnerUserId: string; toOwnerUserId: string }> = [];
    service.setChatMemoryOwnerTransfer(async (input) => { calls.push(input); return { l0Updated: 1, l1Updated: 0 }; });

    const result = await service.transferOwnershipForCaller({
      team_id: team.team_id,
      transfers: [{ resource_type: "asset", resource_id: memoryId, to_user_id: recipient.user_id }],
      idempotency_key: "77777777-7777-4777-8777-777777777777",
    }, ctx(owner.user_id));

    expect(result.items[0]).toMatchObject({ transferred: true, resource_id: memoryId });
    expect(calls).toEqual([{ teamId: team.team_id, agentId: agent.agent_id, fromOwnerUserId: owner.user_id, toOwnerUserId: recipient.user_id }]);
    expect(await service.getAgentById(agent.agent_id)).toMatchObject({ owner_user_id: owner.user_id });
    expect(await service.getAssetById(memoryId)).toMatchObject({ owner_user_id: recipient.user_id });
  });

  it("refuses a direct Agent metadata commit while owned Knowledge backing is uncoordinated", async () => {
    const owner = await user("knowledge-agent-owner");
    const recipient = await user("knowledge-agent-recipient");
    const team = await service.createTeam({ name: "knowledge-agent-handoff", owner_user_id: owner.user_id });
    await service.addTeamMember({ team_id: team.team_id, user_id: recipient.user_id, role: "member" });
    const agent = await service.createAgent({ team_id: team.team_id, owner_user_id: owner.user_id, name: "agent" });
    const wiki = await service.createAsset({
      asset_id: `wiki-${Math.random()}`,
      team_id: team.team_id,
      asset_type: "llm_wiki",
      name: "wiki",
      owner_user_id: owner.user_id,
      source_type: "manual",
    });
    await service.setAgentFixedAssets(agent.agent_id, [
      { asset_id: wiki.asset_id, asset_type: "llm_wiki", created_by: owner.user_id },
    ]);
    service.setChatMemoryOwnerTransfer(async () => ({ l0Updated: 0, l1Updated: 0 }));

    await expect(service.transferOwnershipForCaller({
      team_id: team.team_id,
      transfers: [{ resource_type: "agent", resource_id: agent.agent_id, to_user_id: recipient.user_id }],
      idempotency_key: "55555555-5555-4555-8555-555555555555",
    }, ctx(owner.user_id))).rejects.toMatchObject({ code: "managed_resource_requires_lifecycle" });
    expect(await service.getAgentById(agent.agent_id)).toMatchObject({ owner_user_id: owner.user_id });
  });

  it("only deletes an empty Team by owner with a fresh preview", async () => {
    const owner = await user("owner");
    const team = await service.createTeam({ name: "empty-team", owner_user_id: owner.user_id });
    const preview = await service.previewTeamDeleteForCaller(team.team_id, ctx(owner.user_id));
    expect(preview.ready).toBe(true);
    await expect(service.deleteTeamForCaller({
      team_id: team.team_id,
      team_name: team.name,
      revision: preview.revision,
    }, ctx(owner.user_id))).resolves.toMatchObject({ deleted_ids: [team.team_id] });
  });

  it("classifies membership-loss dependencies as recoverable and never makes them purgeable", async () => {
    const sys = await user("bootstrap", "system_admin");
    const owner = await user("owner");
    const team = await service.createTeam({ name: "recoverable", owner_user_id: owner.user_id });
    await service.createAgent({ team_id: team.team_id, owner_user_id: owner.user_id, name: "agent" });
    await store.removeTeamMember(team.team_id, owner.user_id);

    const scan = await service.scanIntegrityForCaller(ctx(sys.user_id, true));
    const agentFinding = scan.findings.find((item) => item.resource_type === "agent");
    expect(agentFinding).toMatchObject({
      category: "recoverable_dependency",
      reason: "owner_membership_absent",
      allowed_actions: ["inspect"],
    });
    await expect(service.scanIntegrityForCaller(ctx(owner.user_id)))
      .rejects.toMatchObject({ code: "permission_denied" });
  });
});

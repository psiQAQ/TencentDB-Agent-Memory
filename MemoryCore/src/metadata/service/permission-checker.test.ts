import { describe, expect, it } from "vitest";
import { canBindAsset, canReadTeamMembersGlobally, checkPermission, roleDefaultCovers } from "./permission-checker.js";
import type { AclEntity, AssetEntity, AssetVisibility, Permission, TeamMemberEntity } from "../types.js";

const asset: AssetEntity = {
  asset_id: "memory-1", team_id: "team-1", asset_type: "chat_memory", name: "Memory",
  owner_user_id: "owner", source_type: "manual", version: 1, visibility: "team",
  status: "approved", usage_count: 0, created_at: "", updated_at: "", metadata_json: "{}",
};
const member: TeamMemberEntity = {
  id: "membership", team_id: "team-1", user_id: "reader", role: "member", joined_at: "", status: "active",
};
const grant: AclEntity = {
  id: "grant-1", asset_id: asset.asset_id, subject_type: "user", subject_id: "reader",
  permission: "use", effect: "allow", granted_by: "owner", created_at: "", updated_at: "",
};
const permissions: Permission[] = ["read", "write", "delete", "assign", "share", "use"];

describe("shared asset permission boundaries", () => {
  const context = { user: { user_id: "reader" }, asset, membership: member, action: "read" as const, aclRecords: [] };

  it.each([null, { ...asset, status: "archived" as const }])("rejects unavailable assets even for the owner", (unavailable) => {
    expect(checkPermission({ ...context, asset: unavailable, user: { user_id: "owner" } }))
      .toEqual({ allowed: false, reason: "asset_not_available" });
  });

  it.each(permissions)("allows the owner to %s without membership", (action) => {
    expect(checkPermission({ ...context, action, membership: null, user: { user_id: "owner" } }).allowed).toBe(true);
  });

  it.each([null, { ...member, status: "removed" as const }])("rejects a non-member even with an ACL", (membership) => {
    expect(checkPermission({ ...context, membership, action: "use", aclRecords: [grant] }))
      .toEqual({ allowed: false, reason: "not_team_member" });
  });

  it.each(["admin", "member", "reviewer"] as const)("keeps private assets hidden from non-owner %s and ACLs", (role) => {
    expect(checkPermission({ ...context, asset: { ...asset, visibility: "private" }, membership: { ...member, role }, action: "use", aclRecords: [grant] }))
      .toEqual({ allowed: false, reason: "visibility_restricted" });
  });

  it.each(["admin", "member", "reviewer"] as const)("applies the %s role defaults for team and agent assets", (role) => {
    for (const visibility of ["team", "agent"] as const) {
      for (const action of permissions) {
        const expected = role === "admin" ? ["read", "write", "assign", "share"].includes(action) : action === "read";
        expect(checkPermission({ ...context, asset: { ...asset, visibility }, membership: { ...member, role }, action }).allowed).toBe(expected);
        expect(roleDefaultCovers(role, action)).toBe(expected);
      }
    }
  });

  it.each(["team", "restricted"] as const)("accepts only matching allow ACLs for %s assets", (visibility) => {
    for (const [subject_type, subject_id] of [["user", "reader"], ["team_role", "member"], ["agent", "agt-reader"]] as const) {
      const acl = { ...grant, subject_type, subject_id };
      const input = { ...context, asset: { ...asset, visibility }, action: "use" as const, agentId: "agt-reader" };
      expect(checkPermission({ ...input, aclRecords: [acl] })).toEqual({ allowed: true, reason: "acl:grant-1" });
      for (const mismatch of [{ ...acl, subject_id: "someone-else" }, { ...acl, permission: "write" as const }, { ...acl, effect: "deny" as const }]) {
        expect(checkPermission({ ...input, aclRecords: [mismatch] }).allowed).toBe(false);
      }
      if (subject_type === "agent") expect(checkPermission({ ...input, agentId: undefined, aclRecords: [acl] }).allowed).toBe(false);
    }
  });

  it("requires explicit ACLs for restricted member reads but retains admin defaults", () => {
    const input = { ...context, asset: { ...asset, visibility: "restricted" as const } };
    expect(checkPermission(input).allowed).toBe(false);
    expect(checkPermission({ ...input, aclRecords: [{ ...grant, permission: "read" }] }).allowed).toBe(true);
    expect(checkPermission({ ...input, membership: { ...member, role: "admin" } }).allowed).toBe(true);
  });

  it("allows task reads but denies non-admin task writes even with an ACL", () => {
    const input = { ...context, asset: { ...asset, visibility: "task" as const } };
    expect(checkPermission(input).allowed).toBe(true);
    expect(checkPermission({ ...input, action: "write", aclRecords: [{ ...grant, permission: "write" }] }).allowed).toBe(false);
    expect(checkPermission({ ...input, action: "write", membership: { ...member, role: "admin" } }).allowed).toBe(true);
  });

  it("fails closed for unknown persisted visibility", () => {
    expect(checkPermission({ ...context, asset: { ...asset, visibility: "unknown" as AssetVisibility } }).allowed).toBe(false);
  });
});

describe("fixed asset binding boundaries", () => {
  const agent = { team_id: "team-1", owner_user_id: "reader" };
  it.each(["team", "agent"] as const)("allows %s assets only within the same Team", (visibility) => {
    expect(canBindAsset(agent, { ...asset, visibility })).toBe(true);
    expect(canBindAsset({ ...agent, team_id: "other-team" }, { ...asset, visibility })).toBe(false);
  });
  it("requires both matching owner and Team for private assets", () => {
    const privateAsset = { ...asset, visibility: "private" as const };
    expect(canBindAsset(agent, privateAsset)).toBe(false);
    expect(canBindAsset({ ...agent, owner_user_id: "owner" }, privateAsset)).toBe(true);
    expect(canBindAsset({ team_id: "other-team", owner_user_id: "owner" }, privateAsset)).toBe(false);
  });
  it.each(["restricted", "task", "unknown"])("does not turn %s visibility into a fixed binding", (visibility) => {
    expect(canBindAsset(agent, { ...asset, visibility: visibility as AssetVisibility })).toBe(false);
  });
});

describe("team member read scope", () => {
  it("allows only system_admin to read member roles without joining the Team", () => {
    expect(canReadTeamMembersGlobally(true)).toBe(true);
    expect(canReadTeamMembersGlobally(false)).toBe(false);
  });
});

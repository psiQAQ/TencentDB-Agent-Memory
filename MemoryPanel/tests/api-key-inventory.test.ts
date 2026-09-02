import { describe, expect, it } from "vitest";
import {
  buildApiKeySubjects,
  buildManagedUserKeys,
  filterApiKeySubjects,
  filterManagedUserKeys,
  getKeyRevokeBlockReason,
  getPrivilegedMemberships,
  loadSystemAdminApiKeyInventory,
} from "../web/src/pages/ApiKeysPage/api-key-inventory.js";

describe("API Key system-admin inventory", () => {
  it("includes every Team member once, resolves owner/member roles, and keeps the current admin", () => {
    const subjects = buildApiKeySubjects(
      [
        { user_id: "admin", username: "root", user_type: "system_admin" },
        { user_id: "alice", username: "alice" },
        { user_id: "orphan", username: "orphan" },
      ],
      new Map([
        [
          "alice",
          [
            {
              team_id: "team-a",
              name: "Alpha",
              owner_user_id: "alice",
            },
            { team_id: "team-b", name: "Beta", owner_user_id: "bob" },
          ],
        ],
      ]),
      new Map([
        ["team-a", [{ user_id: "alice", role: "admin" }]],
        ["team-b", [{ user_id: "alice", role: "member" }]],
      ]),
      "admin",
    );

    expect(subjects.map((subject) => subject.userId)).toEqual([
      "admin",
      "alice",
    ]);
    expect(subjects[1]?.teams).toEqual([
      {
        teamId: "team-a",
        teamName: "Alpha",
        roles: ["owner", "admin"],
      },
      { teamId: "team-b", teamName: "Beta", roles: ["member"] },
    ]);
  });

  it("combines active keys with owner and Team role context and hides revoked keys", () => {
    const subjects = buildApiKeySubjects(
      [{ user_id: "alice", username: "alice", display_name: "Alice" }],
      new Map([
        [
          "alice",
          [{ team_id: "team-a", name: "Alpha", owner_user_id: "alice" }],
        ],
      ]),
      new Map([["team-a", [{ user_id: "alice", role: "admin" }]]]),
      "admin",
    );
    const rows = buildManagedUserKeys(
      subjects,
      new Map([
        [
          "alice",
          [
            { key_id: "new", created_at: "2026-09-02T02:00:00.000Z" },
            {
              key_id: "revoked",
              created_at: "2026-09-02T03:00:00.000Z",
              revoked_at: "2026-09-02T04:00:00.000Z",
            },
            { key_id: "old", created_at: "2026-09-01T02:00:00.000Z" },
          ],
        ],
      ]),
    );

    expect(rows.map((row) => row.key_id)).toEqual(["new", "old"]);
    expect(rows[0]).toMatchObject({
      ownerUserId: "alice",
      ownerName: "Alice",
      teamMemberships: [
        {
          teamId: "team-a",
          teamName: "Alpha",
          roles: ["owner", "admin"],
        },
      ],
    });
    expect(getPrivilegedMemberships(rows[0]!)).toHaveLength(1);
  });

  it("filters by Team first and then matches member identity fields", () => {
    const subjects = buildApiKeySubjects(
      [
        { user_id: "usr-a", username: "alice", display_name: "Alice Chen" },
        { user_id: "usr-b", username: "bob", display_name: "Bob Li" },
      ],
      new Map([
        ["usr-a", [{ team_id: "team-a", name: "Alpha" }]],
        ["usr-b", [{ team_id: "team-b", name: "Beta" }]],
      ]),
      new Map([
        ["team-a", [{ user_id: "usr-a", role: "member" }]],
        ["team-b", [{ user_id: "usr-b", role: "member" }]],
      ]),
      "admin",
    );
    const keys = buildManagedUserKeys(
      subjects,
      new Map([
        ["usr-a", [{ key_id: "key-a" }]],
        ["usr-b", [{ key_id: "key-b" }]],
      ]),
    );

    const alpha = filterApiKeySubjects(subjects, "team-a", "");
    expect(alpha.map((subject) => subject.userId)).toEqual(["usr-a"]);
    expect(filterApiKeySubjects(subjects, "*", "BOB LI")).toHaveLength(1);
    expect(filterManagedUserKeys(keys, alpha).map((key) => key.key_id)).toEqual(
      ["key-a"],
    );
  });

  it("protects only the bootstrap admin Key and lets system_admin revoke other Keys", () => {
    const bootstrapKey = {
      key_id: "bootstrap",
      ownerUserId: "admin",
      ownerName: "admin",
      ownerUserType: "system_admin",
      is_default: true,
      teamMemberships: [],
    };
    const systemKey = { ...bootstrapKey, key_id: "system", is_default: false };
    const onlyKey = {
      key_id: "only",
      ownerUserId: "alice",
      ownerName: "Alice",
      ownerUserType: "user",
      teamMemberships: [],
    };
    const secondKey = { ...onlyKey, key_id: "second" };

    expect(getKeyRevokeBlockReason(bootstrapKey, [bootstrapKey, systemKey])).toBe(
      "bootstrap_admin_key",
    );
    expect(
      getKeyRevokeBlockReason(systemKey, [bootstrapKey, systemKey], {
        callerUserId: "admin",
        callerIsSystemAdmin: true,
      }),
    ).toBeNull();
    expect(getKeyRevokeBlockReason(onlyKey, [onlyKey])).toBe("last_active_key");
    expect(
      getKeyRevokeBlockReason(onlyKey, [onlyKey], {
        callerUserId: "admin",
        callerIsSystemAdmin: true,
      }),
    ).toBeNull();
    expect(getKeyRevokeBlockReason(onlyKey, [onlyKey, secondKey])).toBeNull();
  });

  it("loads member roles once per unique Team and keys only for managed subjects", async () => {
    const teamCalls: string[] = [];
    const memberCalls: string[] = [];
    const keyCalls: string[] = [];
    const inventory = await loadSystemAdminApiKeyInventory("admin", {
      listUsers: async () => [
        { user_id: "admin", username: "root", user_type: "system_admin" },
        { user_id: "alice", username: "alice" },
        { user_id: "orphan", username: "orphan" },
      ],
      listTeamsForUser: async (userId) => {
        teamCalls.push(userId);
        return userId === "alice"
          ? [{ team_id: "team-a", name: "Alpha", owner_user_id: "alice" }]
          : [];
      },
      listMembersForTeam: async (teamId) => {
        memberCalls.push(teamId);
        return [{ user_id: "alice", role: "admin" }];
      },
      listKeysForUser: async (userId) => {
        keyCalls.push(userId);
        return [{ key_id: `key-${userId}` }];
      },
    });

    expect(teamCalls.sort()).toEqual(["admin", "alice", "orphan"]);
    expect(memberCalls).toEqual(["team-a"]);
    expect(keyCalls.sort()).toEqual(["admin", "alice"]);
    expect(inventory.keys.map((key) => key.key_id).sort()).toEqual([
      "key-admin",
      "key-alice",
    ]);
  });
});

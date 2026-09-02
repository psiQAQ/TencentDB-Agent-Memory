import { describe, expect, it } from "vitest";
import {
  buildApiKeySubjects,
  buildManagedUserKeys,
  loadSystemAdminApiKeyInventory,
} from "../web/src/pages/ApiKeysPage/api-key-inventory.js";

describe("API Key system-admin inventory", () => {
  it("includes every Team member once and keeps the current admin without a Team", () => {
    const subjects = buildApiKeySubjects(
      [
        { user_id: "admin", username: "root" },
        { user_id: "alice", username: "alice" },
        { user_id: "orphan", username: "orphan" },
      ],
      new Map([
        [
          "alice",
          [
            { team_id: "team-a", name: "Alpha" },
            { team_id: "team-b", name: "Beta" },
          ],
        ],
      ]),
      "admin",
    );

    expect(subjects.map((subject) => subject.userId)).toEqual([
      "admin",
      "alice",
    ]);
    expect(subjects[1]?.teams.map((team) => team.name)).toEqual([
      "Alpha",
      "Beta",
    ]);
  });

  it("combines active keys with owner and Team context and hides revoked keys", () => {
    const subjects = buildApiKeySubjects(
      [{ user_id: "alice", username: "alice", display_name: "Alice" }],
      new Map([["alice", [{ team_id: "team-a", name: "Alpha" }]]]),
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
      teamNames: ["Alpha"],
    });
  });

  it("loads Team membership for all users and keys only for managed subjects", async () => {
    const teamCalls: string[] = [];
    const keyCalls: string[] = [];
    const inventory = await loadSystemAdminApiKeyInventory("admin", {
      listUsers: async () => [
        { user_id: "admin", username: "root" },
        { user_id: "alice", username: "alice" },
        { user_id: "orphan", username: "orphan" },
      ],
      listTeamsForUser: async (userId) => {
        teamCalls.push(userId);
        return userId === "alice" ? [{ team_id: "team-a", name: "Alpha" }] : [];
      },
      listKeysForUser: async (userId) => {
        keyCalls.push(userId);
        return [{ key_id: `key-${userId}` }];
      },
    });

    expect(teamCalls.sort()).toEqual(["admin", "alice", "orphan"]);
    expect(keyCalls.sort()).toEqual(["admin", "alice"]);
    expect(inventory.keys.map((key) => key.key_id).sort()).toEqual([
      "key-admin",
      "key-alice",
    ]);
  });
});

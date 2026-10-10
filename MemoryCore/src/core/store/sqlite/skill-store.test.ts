import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { SqliteSkillStore } from "./skill-store.js";

it("keeps version queries and deletion counts scoped to their team", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    const store = new SqliteSkillStore({ db, dimensions: 0 });
    store.init();
    const input = { skill_id: "skl-test", team_id: "team-a", owner_agent_id: "agent-a", name: "test-skill",
      description: "A test skill", content: "version one", content_hash: "hash-one", manifest: [], storage_dir: "skills/test" };
    expect(await store.appendVersion(input)).toMatchObject({ version: 1, is_head: true });
    expect(await store.appendVersion({ ...input, content: "version two", content_hash: "hash-two" })).toMatchObject({ version: 2 });
    expect((await store.listVersions(input.skill_id, "team-a")).map((item) => item.version)).toEqual([2, 1]);
    expect((await store.listSkills({ team_id: "team-b" })).total).toBe(0);
    expect(await store.deleteAllVersions(input.skill_id, "team-b")).toBe(0);
    expect((await store.listSkills({ team_id: "team-a" })).items).toHaveLength(1);
    expect(await store.archiveHead(input.skill_id, "team-a")).toEqual({ archived: true });
    expect(await store.deleteAllVersions(input.skill_id, "team-a")).toBe(2);
    expect(await store.listVersions(input.skill_id)).toEqual([]);
  } finally { db.close(); }
});

import { describe, expect, it, vi } from "vitest";
import { MongoMemoryStore } from "./memory-store.js";
import { MongoSkillStore } from "./skill-store.js";
import { COLLECTIONS } from "./collections.js";
import { docToL0QueryRow, docToL1SearchResult, l0RecordToDoc, l1RecordToDoc } from "./doc-mappers.js";
import type { MongoClientPool } from "./client-pool.js";
import type { MongoConfig } from "../../instance-config-provider.js";
import type { MemoryRecord } from "../../record/l1-writer.js";

const config = { endpoint: "mongodb://offline.invalid", database: "merge-test" } as MongoConfig;
const l0Record = {
  id: "l0", sessionKey: "session", sessionId: "session", teamId: "team", agentId: "agent",
  userId: "historical-user", ownerUserId: "current-owner", role: "user", messageText: "hello",
  recordedAt: "2026-09-08T00:00:00.000Z", timestamp: 1,
};
const l1Record: MemoryRecord = {
  ...l0Record, id: "l1", content: "hello", type: "persona", priority: 1, scene_name: "test",
  timestamps: [l0Record.recordedAt], createdAt: l0Record.recordedAt, updatedAt: l0Record.recordedAt,
  source_message_ids: [], metadata: {},
};

function fixture() {
  const l0 = {
    updateOne: vi.fn().mockResolvedValue({}),
    updateMany: vi.fn().mockResolvedValue({ modifiedCount: 2 }),
    countDocuments: vi.fn().mockResolvedValue(2),
    deleteMany: vi.fn().mockResolvedValue({ deletedCount: 2 }),
    aggregate: vi.fn().mockReturnValue({ toArray: async () => [] }),
  };
  const l1 = { ...l0, updateOne: vi.fn().mockResolvedValue({}), updateMany: vi.fn().mockResolvedValue({ modifiedCount: 3 }) };
  const profiles = { deleteMany: vi.fn().mockResolvedValue({ deletedCount: 0 }) };
  const skills = { findOne: vi.fn(), updateMany: vi.fn().mockResolvedValue({ modifiedCount: 3 }) };
  const collections = { [COLLECTIONS.L0]: l0, [COLLECTIONS.L1]: l1, [COLLECTIONS.PROFILES]: profiles, [COLLECTIONS.SKILLS]: skills };
  const session = { withTransaction: vi.fn(async (fn: () => Promise<unknown>) => fn()), endSession: vi.fn() };
  const pool = { getClient: async () => ({ startSession: () => session }) } as unknown as MongoClientPool;
  const db = { collection: (name: keyof typeof collections) => collections[name] };
  const memoryStore = new MongoMemoryStore({ pool, mongoConfig: config });
  const skillStore = new MongoSkillStore({ pool, mongoConfig: config, now: () => 42 });
  // Inject only the driver boundary; all ownership, mapping and query logic is real.
  Object.assign(memoryStore, { db, searchIndexReady: true });
  Object.assign(skillStore, { db, initialized: true });
  return { memoryStore, skillStore, l0, l1, profiles, skills, session };
}

describe("MongoDB compatibility with local ownership semantics", () => {
  it("round-trips current owners separately from historical users", () => {
    expect(docToL0QueryRow(l0RecordToDoc(l0Record))).toMatchObject({ user_id: "historical-user", owner_user_id: "current-owner" });
    expect(docToL1SearchResult(l1RecordToDoc(l1Record), 0.8)).toMatchObject({ user_id: "historical-user", owner_user_id: "current-owner" });
    const legacy = l0RecordToDoc(l0Record);
    delete legacy.owner_user_id;
    expect(docToL0QueryRow(legacy).owner_user_id).toBe("historical-user");
  });

  it("does not overwrite transferred owners when historical records are reprocessed", async () => {
    const { memoryStore, l0, l1 } = fixture();
    await memoryStore.upsertL0(l0Record);
    await memoryStore.upsertL1(l1Record);
    for (const coll of [l0, l1]) {
      const [, update] = coll.updateOne.mock.calls[0];
      expect(update.$set).not.toHaveProperty("owner_user_id");
      expect(update.$setOnInsert).toEqual({ owner_user_id: "current-owner" });
      expect(update.$set.user_id).toBe("historical-user");
    }
  });

  it("moves both layers in one transaction with an exact team, agent and owner scope", async () => {
    const { memoryStore, l0, l1, session } = fixture();
    expect(await memoryStore.transferMemoryOwner({ teamId: "team", agentId: "agent", fromOwnerUserId: "old", toOwnerUserId: "new" }))
      .toEqual({ l0Updated: 2, l1Updated: 3 });
    for (const coll of [l0, l1]) expect(coll.updateMany).toHaveBeenCalledWith(
      { team_id: "team", agent_id: "agent", owner_user_id: "old" },
      { $set: { owner_user_id: "new" } }, { session },
    );
    expect(session.withTransaction).toHaveBeenCalledOnce();
    expect(session.endSession).toHaveBeenCalledOnce();
  });

  it("propagates failed transfers to the transaction and releases the session", async () => {
    const { memoryStore, l1, session } = fixture();
    l1.updateMany.mockRejectedValueOnce(new Error("write failed"));
    await expect(memoryStore.transferMemoryOwner({ teamId: "team", agentId: "agent", fromOwnerUserId: "old", toOwnerUserId: "new" })).rejects.toThrow("write failed");
    await expect(session.withTransaction.mock.results[0].value).rejects.toThrow("write failed");
    expect(session.endSession).toHaveBeenCalledOnce();
  });

  it("rejects incomplete transfer scopes before touching storage", async () => {
    const { memoryStore, l0 } = fixture();
    await expect(memoryStore.transferMemoryOwner({ teamId: " ", agentId: "agent", fromOwnerUserId: "old", toOwnerUserId: "new" })).rejects.toThrow("complete team/agent/owner scope");
    expect(l0.updateMany).not.toHaveBeenCalled();
  });

  it("filters current ownership before the search limit and retains profile scope semantics", async () => {
    const { memoryStore, l0, profiles } = fixture();
    const filter = { teamId: "team", agentId: "agent", userId: "current-owner" };
    await memoryStore.searchL0Fts("hello", 5, filter);
    const [pipeline] = l0.aggregate.mock.calls[0];
    expect(pipeline[0].$search.compound.filter).toContainEqual({ equals: { path: "owner_user_id", value: "current-owner" } });
    expect(pipeline[1]).toEqual({ $match: { team_id: "team", agent_id: "agent", owner_user_id: "current-owner" } });
    expect(pipeline[2]).toEqual({ $limit: 5 });
    await memoryStore.countL0(filter);
    expect(l0.countDocuments).toHaveBeenCalledWith({ team_id: "team", agent_id: "agent", owner_user_id: "current-owner" });
    await memoryStore.clearMemoryContent(filter);
    expect(l0.deleteMany).toHaveBeenCalledWith({ team_id: "team", agent_id: "agent", owner_user_id: "current-owner" });
    expect(profiles.deleteMany).toHaveBeenCalledWith({ team_id: "team", agent_id: "agent", user_id: "current-owner" });
  });

  it("transfers all Skill versions in the same team and supports idempotent retries", async () => {
    const { skillStore, skills, session } = fixture();
    skills.findOne.mockResolvedValueOnce({ owner_agent_id: "old" }).mockResolvedValueOnce(null);
    expect(await skillStore.transferOwnerAgent("skill", "team", "old", "new")).toBe(3);
    expect(skills.updateMany).toHaveBeenCalledWith(
      { skill_id: "skill", team_id: "team", owner_agent_id: "old" },
      { $set: { owner_agent_id: "new", updated_at_ms: 42 } }, { session },
    );
    skills.findOne.mockResolvedValueOnce({ owner_agent_id: "new" });
    expect(await skillStore.transferOwnerAgent("skill", "team", "old", "new")).toBe(0);
    expect(skills.updateMany).toHaveBeenCalledOnce();
  });

  it.each([null, { owner_agent_id: "other" }])("rejects missing or mismatched Skill ownership: %j", async (head) => {
    const { skillStore, skills, session } = fixture();
    skills.findOne.mockResolvedValueOnce(head);
    await expect(skillStore.transferOwnerAgent("skill", "team", "old", "new")).rejects.toMatchObject({ code: head ? "SKILL_NOT_OWNER" : "SKILL_NOT_FOUND" });
    expect(skills.updateMany).not.toHaveBeenCalled();
    expect(session.endSession).toHaveBeenCalledOnce();
  });
});

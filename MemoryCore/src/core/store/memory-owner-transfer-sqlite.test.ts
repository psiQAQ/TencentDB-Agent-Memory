import { afterEach, describe, expect, it } from "vitest";

import type { MemoryRecord } from "../record/l1-writer.js";
import { VectorStore } from "./sqlite.js";

describe("SQLite chat-memory current ownership", () => {
  let store: VectorStore | undefined;
  afterEach(() => store?.close());

  it("transfers L0/L1 current owner while preserving historical user_id", () => {
    store = new VectorStore(":memory:", 0);
    store.init();
    store.upsertL0({
      id: "l0-1", sessionKey: "s", sessionId: "s", teamId: "team-a",
      userId: "user-old", agentId: "agent-a", role: "user", messageText: "secret",
      recordedAt: "2026-01-01T00:00:00.000Z", timestamp: 1,
    });
    const l1: MemoryRecord = {
      id: "l1-1", content: "memory", type: "episodic", priority: 50,
      scene_name: "", source_message_ids: [], metadata: {}, timestamps: [],
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
      sessionKey: "s", sessionId: "s", teamId: "team-a", userId: "user-old", agentId: "agent-a",
    };
    store.upsertL1(l1, undefined);

    expect(store.transferMemoryOwner({
      teamId: "team-a", agentId: "agent-a", fromOwnerUserId: "user-old", toOwnerUserId: "user-new",
    })).toEqual({ l0Updated: 1, l1Updated: 1 });

    const l0 = store.queryL0Paginated({ teamId: "team-a", userId: "user-new", limit: 10, offset: 0 });
    const l1Rows = store.queryL1Records({ teamId: "team-a", userId: "user-new" });
    expect(l0.rows[0]).toMatchObject({ user_id: "user-old", owner_user_id: "user-new" });
    expect(l1Rows[0]).toMatchObject({ user_id: "user-old", owner_user_id: "user-new" });
    expect(store.queryL0ForL1("s")[0]).toMatchObject({
      user_id: "user-old", owner_user_id: "user-new",
    });
    expect(store.searchL0Fts("secret", 10)[0]).toMatchObject({
      user_id: "user-old", owner_user_id: "user-new",
    });
    expect(store.searchL1Fts("memory", 10)[0]).toMatchObject({
      user_id: "user-old", owner_user_id: "user-new",
    });
    expect(store.countL0({ teamId: "team-a", userId: "user-old" })).toBe(0);
    expect(store.countL1({ teamId: "team-a", userId: "user-old" })).toBe(0);

    // Ordinary upserts update content, but cannot silently reclaim transferred ownership.
    store.upsertL1({ ...l1, content: "updated" }, undefined);
    expect(store.queryL1Records({ recordIds: ["l1-1"] })[0]).toMatchObject({
      user_id: "user-old", owner_user_id: "user-new", content: "updated",
    });
  });

  it("returns current ownership from SQLite vector search results", () => {
    store = new VectorStore(":memory:", 3);
    store.init();
    const embedding = new Float32Array([1, 0, 0]);
    store.upsertL0({
      id: "l0-vector", sessionKey: "s-vector", sessionId: "s-vector", teamId: "team-a",
      userId: "user-old", agentId: "agent-a", role: "user", messageText: "vector secret",
      recordedAt: "2026-01-01T00:00:00.000Z", timestamp: 1,
    }, embedding);
    store.upsertL1({
      id: "l1-vector", content: "vector memory", type: "episodic", priority: 50,
      scene_name: "", source_message_ids: [], metadata: {}, timestamps: [],
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
      sessionKey: "s-vector", sessionId: "s-vector", teamId: "team-a",
      userId: "user-old", agentId: "agent-a",
    }, embedding);
    store.transferMemoryOwner({
      teamId: "team-a", agentId: "agent-a", fromOwnerUserId: "user-old", toOwnerUserId: "user-new",
    });

    expect(store.searchL0Vector(embedding, 1)[0]).toMatchObject({
      user_id: "user-old", owner_user_id: "user-new",
    });
    expect(store.searchL1Vector(embedding, 1)[0]).toMatchObject({
      user_id: "user-old", owner_user_id: "user-new",
    });
  });
});

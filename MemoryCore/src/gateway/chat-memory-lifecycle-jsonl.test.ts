import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { LocalStorageBackend } from "../core/storage/local-backend.js";
import { StorageAdapter } from "../core/storage/adapter.js";
import { VectorStore } from "../core/store/sqlite/memory-store.js";
import {
  clearChatMemoryContent,
  transferChatMemoryContentOwnership,
} from "./chat-memory-handlers.js";

describe("chat-memory JSONL lifecycle", () => {
  let dir: string | undefined;
  let store: VectorStore | undefined;

  afterEach(async () => {
    store?.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("transfers fallback ownership and then removes every scoped JSONL row", async () => {
    dir = await mkdtemp(join(tmpdir(), "chat-memory-lifecycle-"));
    const storage = new StorageAdapter(new LocalStorageBackend(dir));
    store = new VectorStore(":memory:", 0);
    store.init();

    store.upsertL0({
      id: "l0-a", sessionKey: "s", sessionId: "s", teamId: "team-a",
      userId: "user-old", agentId: "agent-a", role: "user", messageText: "secret",
      recordedAt: "2026-01-01T00:00:00.000Z", timestamp: 1,
    });
    await storage.appendFile("conversations/2026-01-01.jsonl", `${JSON.stringify({
      id: "l0-a", teamId: "team-a", agentId: "agent-a", userId: "user-old", content: "secret",
    })}\n${JSON.stringify({
      id: "l0-b", teamId: "team-b", agentId: "agent-b", userId: "other", content: "keep",
    })}\n`);
    await storage.appendFile("records/2026-01-01.jsonl", `${JSON.stringify({
      id: "l1-a", teamId: "team-a", agentId: "agent-a", userId: "user-old", content: "memory",
    })}\n`);

    const transferred = await transferChatMemoryContentOwnership({
      store,
      storage,
      teamId: "team-a",
      agentId: "agent-a",
      fromOwnerUserId: "user-old",
      toOwnerUserId: "user-new",
    });
    expect(transferred).toMatchObject({ l0Updated: 1, jsonlUpdated: 2 });
    expect(await storage.readFile("conversations/2026-01-01.jsonl")).toContain('"ownerUserId":"user-new"');
    expect(await storage.readFile("conversations/2026-01-01.jsonl")).toContain('"userId":"user-old"');

    await clearChatMemoryContent({
      store,
      storage,
      teamId: "team-a",
      agentId: "agent-a",
      instanceId: "test-instance",
    });
    expect(await storage.readFile("conversations/2026-01-01.jsonl")).toContain('"id":"l0-b"');
    expect(await storage.readFile("conversations/2026-01-01.jsonl")).not.toContain('"id":"l0-a"');
    expect(await storage.readFile("records/2026-01-01.jsonl")).toBe("");
    expect(store.countL0({ teamId: "team-a", agentId: "agent-a" })).toBe(0);
  });
});

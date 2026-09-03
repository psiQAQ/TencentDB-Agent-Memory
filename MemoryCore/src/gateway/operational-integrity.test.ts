import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { LocalStorageBackend } from "../core/storage/local-backend.js";
import { StorageAdapter } from "../core/storage/adapter.js";
import { VectorStore } from "../core/store/sqlite.js";
import { SqliteMetadataStore } from "../metadata/store/sqlite-adapter.js";
import { purgeOperationalIntegrity, scanOperationalIntegrity } from "./operational-integrity.js";

const logger = { debug() {}, info() {}, warn() {}, error() {} };

describe("operational integrity governance", () => {
  let dir: string | undefined;
  let memoryStore: VectorStore | undefined;
  let metadataStore: SqliteMetadataStore | undefined;
  afterEach(async () => {
    memoryStore?.close();
    metadataStore?.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("exposes and revalidates a missing-parent runtime scope before purge", async () => {
    dir = await mkdtemp(join(tmpdir(), "runtime-integrity-"));
    const storage = new StorageAdapter(new LocalStorageBackend(dir));
    memoryStore = new VectorStore(":memory:", 0);
    memoryStore.init();
    metadataStore = new SqliteMetadataStore(":memory:");
    metadataStore.init();
    memoryStore.upsertL0({
      id: "l0-orphan", sessionKey: "s", sessionId: "s", teamId: "team-gone",
      userId: "user-old", agentId: "agent-gone", role: "user", messageText: "secret",
      recordedAt: "2026-01-01T00:00:00.000Z", timestamp: 1,
    });
    await storage.appendFile("conversations/2026-01-01.jsonl", `${JSON.stringify({
      id: "l0-orphan", teamId: "team-gone", agentId: "agent-gone",
      userId: "user-old", content: "secret",
    })}\n`);

    const deps = {
      metadataStore,
      memoryStore,
      storage,
      instanceId: "test-instance",
      logger,
    };
    const [finding] = await scanOperationalIntegrity(deps);
    expect(finding).toMatchObject({
      category: "operational_orphan",
      resource_type: "chat_memory_runtime",
      team_id: "team-gone",
      owner_user_id: "user-old",
      allowed_actions: ["inspect", "purge"],
    });

    const result = await purgeOperationalIntegrity(deps, [{
      finding_id: finding.finding_id,
      fingerprint: finding.fingerprint,
    }]);
    expect(result.failed).toEqual([]);
    expect(result.deleted).toEqual([finding.finding_id]);
    expect(memoryStore.countL0({ teamId: "team-gone", agentId: "agent-gone" })).toBe(0);
    expect(await storage.readFile("conversations/2026-01-01.jsonl")).toBe("");
    expect(await scanOperationalIntegrity(deps)).toEqual([]);
  });
});

import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { SqliteMetadataStore } from "./sqlite-adapter.js";

describe("SQLite Task owner migration", () => {
  let dir: string | undefined;
  let store: SqliteMetadataStore | undefined;
  afterEach(async () => {
    store?.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("adds and backfills owner_user_id before creating its index", async () => {
    dir = await mkdtemp(join(tmpdir(), "metadata-owner-migration-"));
    const dbPath = join(dir, "metadata.db");
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE meta_tasks (
        task_id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL,
        creator_user_id TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        source_type TEXT NOT NULL DEFAULT 'manual',
        source_url TEXT,
        status TEXT NOT NULL DEFAULT 'running',
        auto_assign_floating_assets INTEGER NOT NULL DEFAULT 0,
        risk_level TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}'
      );
      INSERT INTO meta_tasks
        (task_id,team_id,creator_user_id,title,created_at,updated_at)
      VALUES ('task-old','team-a','user-creator','legacy','2026-01-01','2026-01-01');
    `);
    db.close();

    store = new SqliteMetadataStore(dbPath);
    expect(() => store!.init()).not.toThrow();
    expect(store.getTaskById("task-old")).toMatchObject({
      creator_user_id: "user-creator",
      owner_user_id: "user-creator",
    });
  });
});

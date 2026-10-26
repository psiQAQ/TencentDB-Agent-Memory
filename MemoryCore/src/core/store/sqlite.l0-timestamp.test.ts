import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it } from "vitest";

import { VectorStore } from "./sqlite/memory-store.js";

let directory: string;
let store: VectorStore;

beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), "l0-timestamp-"));
  const filename = path.join(directory, "vectors.db");
  const db = new DatabaseSync(filename);
  // A persisted TEXT column exercises the read boundary with real SQLite rows.
  db.exec(`
    CREATE TABLE l0_conversations (
      record_id TEXT PRIMARY KEY,
      session_key TEXT NOT NULL,
      session_id TEXT DEFAULT 'default',
      role TEXT NOT NULL DEFAULT '',
      message_text TEXT NOT NULL,
      recorded_at TEXT DEFAULT '',
      timestamp TEXT
    )
  `);
  const insert = db.prepare(`
    INSERT INTO l0_conversations
      (record_id, session_key, message_text, recorded_at, timestamp)
    VALUES (?, 'session', 'synthetic message', ?, ?)
  `);
  for (const [index, timestamp] of ["1792994400000", "0", "invalid", null].entries()) {
    insert.run(String(index), `2026-10-26T06:00:0${index}.000Z`, timestamp);
  }
  db.close();
  store = new VectorStore(filename, 0);
  store.init();
});

afterEach(() => {
  store?.close();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

it("returns numeric L0 timestamps to the L1 reader, including stored text and missing values", () => {
  const rows = store.queryL0ForL1("session");
  expect(rows.map((row) => row.timestamp)).toEqual([1792994400000, 0, 0, 0]);
  expect(rows.every((row) => typeof row.timestamp === "number")).toBe(true);
});

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { SqliteMetadataStore } from "../store/sqlite-adapter.js";
import { MetadataService } from "./metadata-service.js";
import type { SupportedAgent } from "../types.js";

export const supported: SupportedAgent[] = [
  { agent_source: "codex", protocol: "openai-responses", display_name: "Codex" },
  { agent_source: "pi", protocol: "openai-chat", display_name: "Pi" },
];
export function upstreamFixture() {
  const parent = join(process.cwd(), "workspace");
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(join(parent, "upstream-test-"));
  const secret = join(directory, "key");
  writeFileSync(secret, randomBytes(32).toString("base64"), { mode: 0o600 });
  const previous = process.env.TDAI_LLM_CONFIG_ENCRYPTION_KEY_FILE;
  process.env.TDAI_LLM_CONFIG_ENCRYPTION_KEY_FILE = secret;
  const dbPath = join(directory, "metadata.db");
  const store = new SqliteMetadataStore(dbPath);
  store.init();
  return { store, service: new MetadataService(store), dbPath, directory,
    cleanup() { store.close();
      if (previous === undefined) delete process.env.TDAI_LLM_CONFIG_ENCRYPTION_KEY_FILE;
      else process.env.TDAI_LLM_CONFIG_ENCRYPTION_KEY_FILE = previous;
      rmSync(directory, { recursive: true, force: true });
    } };
}

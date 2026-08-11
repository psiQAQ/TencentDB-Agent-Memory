import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NullBindingRepo, RedisBindingRepo } from "../binding-repo.js";
import {
  __resetHookCacheRepoForTests,
  getHookCacheRepo,
} from "../hookCacheRepo.js";
import { __resetDbForTests, getDb } from "../index.js";
import { KvBindingRepo } from "../kv-binding-repo.js";
import { KvSessionRepo } from "../kv-session-repo.js";
import { RedisHookCacheRepo } from "../redis-hook-cache-repo.js";
import { RedisSessionRepo } from "../redis-session-repo.js";
import {
  parsePersistedSessionIdentityKey,
  persistedSessionIdentityKey,
} from "../session-identity-key.js";
import {
  __resetSessionRepoForTests,
  getSessionRepo,
  sessionRowId,
} from "../sessionRepo.js";
import type { SessionInitState } from "../../session/types.js";
import { MemoryStorage } from "../../storage/memory-storage.js";

const FIRST = ["space:a", "user", "claude-code", "shared-session"] as const;
const SECOND = ["space", "a:user", "claude-code", "shared-session"] as const;

function v2IdentityKey(identity: readonly string[]): string {
  return `v2:${Buffer.from(JSON.stringify(identity), "utf8").toString("base64url")}`;
}

function legacyIdentityKey(identity: readonly string[]): string {
  const [spaceId, userId, agentSource, sessionId] = identity;
  return `${spaceId || "_default"}:${userId}:${agentSource}:${sessionId}`;
}

function state(
  identity: readonly [string, string, string, string],
  marker: string,
): SessionInitState {
  const [spaceId, userId, , sessionId] = identity;
  return {
    status: "initialized",
    keyId: sessionId,
    startedAt: 1,
    attemptCount: 0,
    userId,
    sessionInfo: {
      session_id: sessionId,
      space_id: spaceId,
      team_id: "team-1",
      agent_id: marker,
      user_id: userId,
    },
    agentDetail: { id: marker, name: marker },
    taskDetail: null,
  };
}

function incompleteInitializedState(
  identity: readonly [string, string, string, string],
): Record<string, unknown> {
  const [spaceId, userId, , sessionId] = identity;
  return {
    status: "initialized",
    keyId: sessionId,
    userId,
    sessionInfo: {
      session_id: sessionId,
      space_id: spaceId,
      team_id: 7,
      agent_id: "agent-invalid-shape",
      user_id: userId,
    },
  };
}

function contextFreeLegacyCanonicalBypass(
  identity: readonly [string, string, string, string],
): Record<string, unknown> {
  const [, userId, , sessionId] = identity;
  return {
    status: "initialized",
    keyId: sessionId,
    userId,
    bypassed: true,
  };
}

interface FakeTransaction {
  hset(
    key: string,
    fieldsOrName: Record<string, string> | string,
    ...rest: string[]
  ): FakeTransaction;
  expire(key: string, ttl: number): FakeTransaction;
  exec(): Promise<Array<[Error | null, unknown]>>;
}

class FakeRedis {
  readonly strings = new Map<string, string>();
  readonly hashes = new Map<string, Record<string, string>>();
  readonly ttls = new Map<string, number>();

  async setex(key: string, ttl: number, value: string): Promise<"OK"> {
    this.strings.set(key, value);
    this.ttls.set(key, ttl);
    return "OK";
  }

  async get(key: string): Promise<string | null> {
    return this.strings.get(key) ?? null;
  }

  async mget(...keys: string[]): Promise<Array<string | null>> {
    return keys.map((key) => this.strings.get(key) ?? null);
  }

  async scan(_cursor: string, ...args: string[]): Promise<[string, string[]]> {
    const matchIndex = args.indexOf("MATCH");
    const pattern = matchIndex >= 0 ? args[matchIndex + 1] ?? "*" : "*";
    const prefix = pattern.endsWith("*") ? pattern.slice(0, -1) : pattern;
    const keys = [...this.strings.keys(), ...this.hashes.keys()]
      .filter((key, index, all) => all.indexOf(key) === index)
      .filter((key) => key.startsWith(prefix));
    return ["0", keys];
  }

  async del(...keys: string[]): Promise<number> {
    let removed = 0;
    for (const key of keys) {
      removed += Number(this.strings.delete(key));
      removed += Number(this.hashes.delete(key));
      this.ttls.delete(key);
    }
    return removed;
  }

  async hset(
    key: string,
    fieldsOrName: Record<string, string> | string,
    ...rest: string[]
  ): Promise<number> {
    const current = this.hashes.get(key) ?? {};
    if (typeof fieldsOrName === "string") {
      const pairs = [fieldsOrName, ...rest];
      for (let index = 0; index < pairs.length; index += 2) {
        current[pairs[index]!] = pairs[index + 1] ?? "";
      }
    } else {
      Object.assign(current, fieldsOrName);
    }
    this.hashes.set(key, current);
    return 1;
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    return { ...(this.hashes.get(key) ?? {}) };
  }

  async hget(key: string, field: string): Promise<string | null> {
    return this.hashes.get(key)?.[field] ?? null;
  }

  async exists(key: string): Promise<number> {
    return Number(this.strings.has(key) || this.hashes.has(key));
  }

  async expire(key: string, ttl: number): Promise<number> {
    if (!(await this.exists(key))) return 0;
    this.ttls.set(key, ttl);
    return 1;
  }

  async ttl(key: string): Promise<number> {
    if (!(await this.exists(key))) return -2;
    return this.ttls.get(key) ?? -1;
  }

  async eval(
    _script: string,
    _keyCount: number,
    key: string,
    lastSeen: string,
    ttl: string,
  ): Promise<number> {
    const current = this.hashes.get(key);
    if (!current) return 0;
    current.last_seen = lastSeen;
    this.ttls.set(key, Number(ttl));
    return 1;
  }

  multi(): FakeTransaction {
    const operations: Array<
      | { kind: "hset"; args: [string, Record<string, string> | string, ...string[]] }
      | { kind: "expire"; args: [string, number] }
    > = [];
    const transaction: FakeTransaction = {
      hset: (key, fieldsOrName, ...rest) => {
        operations.push({ kind: "hset", args: [key, fieldsOrName, ...rest] });
        return transaction;
      },
      expire: (key, ttl) => {
        operations.push({ kind: "expire", args: [key, ttl] });
        return transaction;
      },
      exec: async () => {
        const results: Array<[Error | null, unknown]> = [];
        for (const operation of operations) {
          if (operation.kind === "hset") {
            results.push([null, await this.hset(...operation.args)]);
          } else {
            results.push([null, await this.expire(...operation.args)]);
          }
        }
        return results;
      },
    };
    return transaction;
  }
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function insertLegacySession(
  identity: readonly [string, string, string, string],
  value: SessionInitState,
): void {
  const db = getDb();
  expect(db).not.toBeNull();
  db!.prepare(`
    INSERT INTO sessions (
      session_id, session_key, status, agent_id, task_id, user_id,
      cb_user_id, agent_detail_json, task_detail_json, session_info_json,
      state_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    legacyIdentityKey(identity),
    identity[3],
    "initialized",
    value.agentDetail?.id ?? null,
    null,
    identity[1],
    identity[1],
    JSON.stringify(value.agentDetail),
    null,
    JSON.stringify(value.sessionInfo),
    JSON.stringify(value),
    1,
    1,
  );
}

describe("collision-safe persisted session identity keys", () => {
  let tempDir: string;
  let originalDbPath: string | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "proxy-key-isolation-"));
    originalDbPath = process.env.PROXY_DB_PATH;
    process.env.PROXY_DB_PATH = join(tempDir, "proxy.db");
    __resetHookCacheRepoForTests();
    __resetSessionRepoForTests();
    __resetDbForTests();
  });

  afterEach(() => {
    __resetHookCacheRepoForTests();
    __resetSessionRepoForTests();
    __resetDbForTests();
    if (originalDbPath === undefined) delete process.env.PROXY_DB_PATH;
    else process.env.PROXY_DB_PATH = originalDbPath;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("separates tuples that collide under the legacy delimiter and the space sentinel", () => {
    expect(legacyIdentityKey(FIRST)).toBe(legacyIdentityKey(SECOND));
    expect(sessionRowId(...FIRST)).not.toBe(sessionRowId(...SECOND));
    expect(sessionRowId("", "user", "claude-code", "session"))
      .not.toBe(sessionRowId("_default", "user", "claude-code", "session"));
    const encoded = persistedSessionIdentityKey(...FIRST);
    expect(parsePersistedSessionIdentityKey(encoded)).toEqual({
      spaceId: FIRST[0],
      userId: FIRST[1],
      agentSource: FIRST[2],
      sessionId: FIRST[3],
    });
    expect(parsePersistedSessionIdentityKey(`${encoded}=`)).toBeNull();
    expect(parsePersistedSessionIdentityKey("v2:not-json")).toBeNull();
  });

  it("keeps SQLite session and hook rows isolated across restart, hydrate, and delete", async () => {
    const sessions = getSessionRepo();
    const hooks = getHookCacheRepo();
    await sessions.upsert(...FIRST, state(FIRST, "agent-first"));
    await sessions.upsert(...SECOND, state(SECOND, "agent-second"));
    hooks.put(...FIRST, "memory", [{ type: "text", content: "first" }]);
    hooks.put(...SECOND, "memory", [{ type: "text", content: "second" }]);

    expect((await sessions.getBySessionId(...FIRST))?.agentDetail?.id).toBe("agent-first");
    expect((await sessions.getBySessionId(...SECOND))?.agentDetail?.id).toBe("agent-second");
    expect((await hooks.get(...FIRST, "memory"))?.[0]?.content).toBe("first");
    expect((await hooks.get(...SECOND, "memory"))?.[0]?.content).toBe("second");

    __resetHookCacheRepoForTests();
    __resetSessionRepoForTests();
    __resetDbForTests();
    const restartedSessions = getSessionRepo();
    const restartedHooks = getHookCacheRepo();
    const hydrated = await restartedSessions.loadAllInitialized();
    expect(hydrated).toHaveLength(2);
    expect(hydrated.map(({ spaceId, userId }) => [spaceId, userId]))
      .toEqual(expect.arrayContaining([[FIRST[0], FIRST[1]], [SECOND[0], SECOND[1]]]));
    expect((await restartedHooks.get(...FIRST, "memory"))?.[0]?.content).toBe("first");
    expect((await restartedHooks.get(...SECOND, "memory"))?.[0]?.content).toBe("second");

    restartedHooks.clearBySession(...FIRST);
    await restartedSessions.deleteBySessionId(...FIRST);
    expect(await restartedSessions.getBySessionId(...FIRST)).toBeNull();
    expect((await restartedSessions.getBySessionId(...SECOND))?.agentDetail?.id)
      .toBe("agent-second");
    expect(await restartedHooks.get(...FIRST, "memory")).toBeNull();
    expect((await restartedHooks.get(...SECOND, "memory"))?.[0]?.content).toBe("second");
  });

  it("hydrates only canonical SQLite rows and bounds legacy point lookup", async () => {
    const safe = ["space", "user", "claude-code", "session"] as const;
    insertLegacySession(safe, state(safe, "legacy-safe"));
    getDb()!.prepare(
      "INSERT INTO hook_cache (session_id, hook_id, blocks_json, created_at) VALUES (?, ?, ?, ?)",
    ).run(
      legacyIdentityKey(safe),
      "memory",
      JSON.stringify([{ type: "text", content: "legacy-hook" }]),
      1,
    );
    getDb()!.prepare(
      "INSERT INTO hook_cache (session_id, hook_id, blocks_json, created_at) VALUES (?, ?, ?, ?)",
    ).run(
      legacyIdentityKey(safe),
      "skill",
      JSON.stringify([{ type: "text", content: "legacy-skill" }]),
      1,
    );
    const sessions = getSessionRepo();
    const hooks = getHookCacheRepo();

    expect(await sessions.loadAllInitialized()).toEqual([]);
    expect((await sessions.getBySessionId(...safe))?.agentDetail?.id).toBe("legacy-safe");
    expect((await hooks.get(...safe, "memory"))?.[0]?.content).toBe("legacy-hook");
    expect((await hooks.get(...safe, "skill"))?.[0]?.content).toBe("legacy-skill");
    expect((await hooks.getAllForSession(...safe)).map(({ hookId }) => hookId).sort())
      .toEqual(["memory", "skill"]);
    expect(getDb()!.prepare("SELECT COUNT(*) AS count FROM sessions").get())
      .toEqual({ count: 1 });
    expect(getDb()!.prepare("SELECT COUNT(*) AS count FROM hook_cache").get())
      .toEqual({ count: 2 });

    const unsafe = FIRST;
    insertLegacySession(unsafe, state(unsafe, "legacy-unsafe"));
    getDb()!.prepare(
      "INSERT INTO hook_cache (session_id, hook_id, blocks_json, created_at) VALUES (?, ?, ?, ?)",
    ).run(
      legacyIdentityKey(unsafe),
      "memory",
      JSON.stringify([{ type: "text", content: "unsafe-hook" }]),
      1,
    );
    expect(await sessions.getBySessionId(...unsafe)).toBeNull();
    expect(await hooks.get(...unsafe, "memory")).toBeNull();
    hooks.clearBySession(...unsafe);
    await sessions.deleteBySessionId(...unsafe);
    expect(getDb()!.prepare("SELECT COUNT(*) AS count FROM sessions WHERE session_id = ?")
      .get(legacyIdentityKey(unsafe))).toEqual({ count: 1 });
    expect(getDb()!.prepare("SELECT COUNT(*) AS count FROM hook_cache WHERE session_id = ?")
      .get(legacyIdentityKey(unsafe))).toEqual({ count: 1 });
  });

  it("keeps Redis session, binding, and hook keys isolated with TTL and bounded delete", async () => {
    const redis = new FakeRedis();
    const sessions = new RedisSessionRepo(redis as never, 101);
    const bindings = new RedisBindingRepo(redis as never, 2);
    const hooks = new RedisHookCacheRepo(redis as never, 202);

    await sessions.upsert(...FIRST, state(FIRST, "agent-first"));
    await sessions.upsert(...SECOND, state(SECOND, "agent-second"));
    await bindings.putBinding(...FIRST, {
      outcome: "initialized", userId: FIRST[1], agentId: "agent-first",
    });
    await bindings.putBinding(...SECOND, {
      outcome: "initialized", userId: SECOND[1], agentId: "agent-second",
    });
    hooks.put(...FIRST, "memory", [{ type: "text", content: "first" }]);
    hooks.put(...SECOND, "memory", [{ type: "text", content: "second" }]);
    await settle();

    expect((await sessions.getBySessionId(...FIRST))?.agentDetail?.id).toBe("agent-first");
    expect((await sessions.getBySessionId(...SECOND))?.agentDetail?.id).toBe("agent-second");
    expect((await bindings.getBinding(...FIRST))?.agentId).toBe("agent-first");
    expect((await bindings.getBinding(...SECOND))?.agentId).toBe("agent-second");
    expect((await hooks.get(...FIRST, "memory"))?.[0]?.content).toBe("first");
    expect((await hooks.get(...SECOND, "memory"))?.[0]?.content).toBe("second");
    const restartedSessions = new RedisSessionRepo(redis as never, 101);
    expect(await restartedSessions.loadAllInitialized()).toHaveLength(2);
    expect([...redis.strings.keys()].every((key) => key.startsWith("inj:sess:v2:"))).toBe(true);
    expect([...redis.hashes.keys()].every((key) => /inj:(binding|hook):v2:/.test(key)))
      .toBe(true);
    expect([...redis.ttls.values()]).toEqual(expect.arrayContaining([101, 202, 172800]));
    const firstBindingKey = `inj:binding:${v2IdentityKey(FIRST)}`;
    redis.hashes.get(firstBindingKey)!.last_seen = "old";
    await bindings.touchLastSeen(...FIRST);
    expect(redis.hashes.get(firstBindingKey)?.last_seen).not.toBe("old");
    expect(redis.ttls.get(firstBindingKey)).toBe(172800);

    await sessions.deleteBySessionId(...FIRST);
    await bindings.deleteBinding(...FIRST);
    hooks.clearBySession(...FIRST);
    await settle();
    expect(await sessions.getBySessionId(...FIRST)).toBeNull();
    expect((await sessions.getBySessionId(...SECOND))?.agentDetail?.id).toBe("agent-second");
    expect(await bindings.getBinding(...FIRST)).toBeNull();
    expect((await bindings.getBinding(...SECOND))?.agentId).toBe("agent-second");
    expect(await hooks.get(...FIRST, "memory")).toBeNull();
    expect((await hooks.get(...SECOND, "memory"))?.[0]?.content).toBe("second");
  });

  it("reads only unambiguous owned Redis legacy state without rewriting TTL", async () => {
    const redis = new FakeRedis();
    const sessions = new RedisSessionRepo(redis as never, 999);
    const safe = ["space", "user", "claude-code", "session"] as const;
    const safeLegacyKey = `inj:sess:${legacyIdentityKey(safe)}`;
    redis.strings.set(safeLegacyKey, JSON.stringify(state(safe, "legacy-safe")));
    redis.ttls.set(safeLegacyKey, 321);

    expect(await sessions.loadAllInitialized()).toEqual([]);
    expect((await sessions.getBySessionId(...safe))?.agentDetail?.id).toBe("legacy-safe");
    const migrated = `inj:sess:${v2IdentityKey(safe)}`;
    expect(redis.strings.has(migrated)).toBe(false);
    expect(redis.ttls.get(safeLegacyKey)).toBe(321);

    const legacyBypass = ["space-2", "user", "claude-code", "bypass-session"] as const;
    const bypassState: SessionInitState = {
      status: "initialized",
      bypassed: true,
      keyId: legacyBypass[3],
      userId: legacyBypass[1],
      startedAt: 1,
      attemptCount: 0,
    };
    const legacyBypassKey = `inj:sess:${legacyIdentityKey(legacyBypass)}`;
    redis.strings.set(legacyBypassKey, JSON.stringify(bypassState));
    redis.ttls.set(legacyBypassKey, 111);
    expect((await sessions.getBySessionId(...legacyBypass))?.bypassed).toBe(true);

    const unsafe = FIRST;
    const unsafeLegacyKey = `inj:sess:${legacyIdentityKey(unsafe)}`;
    redis.strings.set(unsafeLegacyKey, JSON.stringify(state(unsafe, "legacy-unsafe")));
    expect(await sessions.getBySessionId(...unsafe)).toBeNull();
    await sessions.deleteBySessionId(...unsafe);
    await settle();
    expect(redis.strings.has(unsafeLegacyKey)).toBe(true);

    const literalDefault = ["_default", "user", "claude-code", "session"] as const;
    redis.strings.set(
      `inj:sess:${legacyIdentityKey(literalDefault)}`,
      JSON.stringify(state(literalDefault, "literal-default")),
    );
    expect(await sessions.getBySessionId(...literalDefault)).toBeNull();
  });

  it("reads and deletes legacy recovery-only rows with an exact source-prefixed keyId", async () => {
    const identity = ["space", "user", "claude-code", "legacy-recovery"] as const;
    const recoveryState = state(identity, "legacy-recovery-agent");
    recoveryState.keyId = `${identity[2]}:${identity[3]}`;

    insertLegacySession(identity, recoveryState);
    const sqlite = getSessionRepo();
    expect((await sqlite.getBySessionId(...identity))?.agentDetail?.id)
      .toBe("legacy-recovery-agent");
    await sqlite.deleteBySessionId(...identity);
    expect(getDb()!.prepare("SELECT COUNT(*) AS count FROM sessions WHERE session_id = ?")
      .get(legacyIdentityKey(identity))).toEqual({ count: 0 });

    const redis = new FakeRedis();
    const redisRepo = new RedisSessionRepo(redis as never);
    const legacyRedisKey = `inj:sess:${legacyIdentityKey(identity)}`;
    redis.strings.set(legacyRedisKey, JSON.stringify(recoveryState));
    redis.ttls.set(legacyRedisKey, 60);
    expect((await redisRepo.getBySessionId(...identity))?.agentDetail?.id)
      .toBe("legacy-recovery-agent");
    await redisRepo.deleteBySessionId(...identity);
    await settle();
    expect(redis.strings.has(legacyRedisKey)).toBe(false);
  });

  it("never falls back to legacy Redis state after a conflicting v2 row", async () => {
    const redis = new FakeRedis();
    const sessions = new RedisSessionRepo(redis as never);
    const identity = ["space", "user", "claude-code", "session"] as const;
    const wrongOwner = ["space", "other-user", "claude-code", "session"] as const;
    redis.strings.set(
      `inj:sess:${v2IdentityKey(identity)}`,
      JSON.stringify(state(wrongOwner, "wrong-owner")),
    );
    redis.strings.set(
      `inj:sess:${legacyIdentityKey(identity)}`,
      JSON.stringify(state(identity, "legacy-owner")),
    );

    await expect(sessions.getBySessionId(...identity)).rejects.toMatchObject({
      name: "SessionRepoReadError",
      message: "session repository read failed",
    });
    expect(redis.strings).toHaveLength(2);
  });

  it("fails closed on non-expiring legacy rows and invalid TTL configuration", async () => {
    const redis = new FakeRedis();
    const sessions = new RedisSessionRepo(redis as never);
    const bindings = new RedisBindingRepo(redis as never);
    const hooks = new RedisHookCacheRepo(redis as never);
    const identity = ["space", "user", "claude-code", "session"] as const;
    redis.strings.set(
      `inj:sess:${legacyIdentityKey(identity)}`,
      JSON.stringify(state(identity, "permanent-session")),
    );
    redis.hashes.set(`inj:binding:${legacyIdentityKey(identity)}`, {
      outcome: "initialized", user_id: identity[1], agent_id: "permanent-binding",
    });
    redis.hashes.set(`inj:hook:${legacyIdentityKey(identity)}`, {
      memory: JSON.stringify([{ type: "text", content: "permanent-hook" }]),
    });
    expect(await sessions.getBySessionId(...identity)).toBeNull();
    expect(await bindings.getBinding(...identity)).toBeNull();
    expect(await hooks.getAllForSession(...identity)).toEqual([]);

    expect(() => new RedisSessionRepo(redis as never, 0)).toThrow("invalid Redis session TTL");
    expect(() => new RedisBindingRepo(redis as never, Number.NaN))
      .toThrow("invalid Redis binding TTL");
    expect(() => new RedisHookCacheRepo(redis as never, 1.5))
      .toThrow("invalid Redis hook TTL");
  });

  it("reports Redis session and binding write durability explicitly", async () => {
    const healthyRedis = new FakeRedis();
    const sessions = new RedisSessionRepo(healthyRedis as never);
    const bindings = new RedisBindingRepo(healthyRedis as never);
    expect(await sessions.upsert(...FIRST, state(FIRST, "durable-session"))).toBe(true);
    expect(await bindings.putBinding(...FIRST, {
      outcome: "initialized",
      userId: FIRST[1],
      agentId: "durable-agent",
    })).toBe(true);

    const failedSessionRedis = {
      setex: async () => { throw new Error("handled-session-write-failure"); },
    };
    expect(await new RedisSessionRepo(failedSessionRedis as never)
      .upsert(...FIRST, state(FIRST, "failed-session"))).toBe(false);

    let failedTransaction!: FakeTransaction;
    failedTransaction = {
      hset: () => failedTransaction,
      expire: () => failedTransaction,
      exec: async () => [[new Error("handled-binding-write-failure"), null], [null, 1]],
    };
    const failedBindingRedis = { multi: () => failedTransaction };
    expect(await new RedisBindingRepo(failedBindingRedis as never).putBinding(...FIRST, {
      outcome: "initialized",
      userId: FIRST[1],
      agentId: "failed-agent",
    })).toBe(false);
  });

  it("reports durable delete success and failure across real adapters", async () => {
    const sqlite = getSessionRepo();
    expect(await sqlite.upsert(...FIRST, state(FIRST, "sqlite-owner"))).toBe(true);
    getDb()!.close();
    expect(await sqlite.deleteBySessionId(...FIRST)).toBe(false);
    __resetSessionRepoForTests();
    __resetDbForTests();
    await expect(getSessionRepo().getBySessionId(...FIRST)).resolves.toMatchObject({
      agentDetail: { id: "sqlite-owner" },
    });

    const redisSessionBackend = new FakeRedis();
    vi.spyOn(redisSessionBackend, "del").mockRejectedValue(new Error("redis-delete-detail"));
    expect(await new RedisSessionRepo(redisSessionBackend as never).deleteBySessionId(...FIRST))
      .toBe(false);

    const redisBindingBackend = new FakeRedis();
    vi.spyOn(redisBindingBackend, "del").mockRejectedValue(new Error("redis-delete-detail"));
    expect(await new RedisBindingRepo(redisBindingBackend as never).deleteBinding(...FIRST))
      .toBe(false);

    const kvSessionStorage = new MemoryStorage();
    vi.spyOn(kvSessionStorage, "del").mockRejectedValue(new Error("kv-delete-detail"));
    expect(await new KvSessionRepo(kvSessionStorage).deleteBySessionId(...FIRST))
      .toBe(false);

    const kvBindingStorage = new MemoryStorage();
    vi.spyOn(kvBindingStorage, "del").mockRejectedValue(new Error("kv-delete-detail"));
    expect(await new KvBindingRepo(kvBindingStorage).deleteBinding(...FIRST))
      .toBe(false);

    expect(await new KvSessionRepo(new MemoryStorage()).deleteBySessionId(...FIRST))
      .toBe(true);
    expect(await new KvBindingRepo(new MemoryStorage()).deleteBinding(...FIRST))
      .toBe(true);
    expect(await new NullBindingRepo().deleteBinding(...FIRST)).toBe(true);
  });

  it("distinguishes durable read failures from missing rows", async () => {
    const rawDetail = "raw-backend-read-detail-sentinel";
    const failedRedisSession = new RedisSessionRepo({
      get: async () => { throw new Error(rawDetail); },
    } as never);
    const failedRedisBinding = new RedisBindingRepo({
      hgetall: async () => { throw new Error(rawDetail); },
    } as never);
    const failedStorage = {
      getJSON: async () => { throw new Error(rawDetail); },
    } as never;

    await expect(failedRedisSession.getBySessionId(...FIRST)).rejects.toMatchObject({
      name: "SessionRepoReadError",
      message: "session repository read failed",
    });
    await expect(failedRedisBinding.getBinding(...FIRST)).rejects.toMatchObject({
      name: "BindingRepoReadError",
      message: "binding repository read failed",
    });
    await expect(new KvSessionRepo(failedStorage).getBySessionId(...FIRST))
      .rejects.toMatchObject({
        name: "SessionRepoReadError",
        message: "session repository read failed",
      });
    await expect(new KvBindingRepo(failedStorage).getBinding(...FIRST))
      .rejects.toMatchObject({
        name: "BindingRepoReadError",
        message: "binding repository read failed",
      });

    const sqliteSession = getSessionRepo();
    getDb()!.close();
    await expect(sqliteSession.getBySessionId(...FIRST)).rejects.toMatchObject({
      name: "SessionRepoReadError",
      message: "session repository read failed",
    });
  });

  it("rejects present malformed and mismatched canonical SQLite sessions", async () => {
    const detail = "malformed-sqlite-session-detail-sentinel";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const sessions = getSessionRepo();
    expect(await sessions.upsert(...FIRST, state(FIRST, "canonical-owner"))).toBe(true);
    const db = getDb()!;
    const update = db.prepare("UPDATE sessions SET state_json = ? WHERE session_id = ?");

    update.run(`{${detail}`, sessionRowId(...FIRST));
    await expect(sessions.getBySessionId(...FIRST)).rejects.toMatchObject({
      name: "SessionRepoReadError",
      message: "session repository read failed",
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM sessions WHERE session_id = ?")
      .get(sessionRowId(...FIRST))).toEqual({ count: 1 });

    update.run(JSON.stringify(state(SECOND, "wrong-owner")), sessionRowId(...FIRST));
    await expect(sessions.getBySessionId(...FIRST)).rejects.toMatchObject({
      name: "SessionRepoReadError",
      message: "session repository read failed",
    });

    update.run(JSON.stringify({ ...state(FIRST, "owner"), status: detail }), sessionRowId(...FIRST));
    await expect(sessions.getBySessionId(...FIRST)).rejects.toMatchObject({
      name: "SessionRepoReadError",
      message: "session repository read failed",
    });
    await expect(sessions.loadAllInitialized()).rejects.toMatchObject({
      name: "SessionRepoReadError",
      message: "session repository read failed",
    });

    update.run(JSON.stringify(incompleteInitializedState(FIRST)), sessionRowId(...FIRST));
    await expect(sessions.getBySessionId(...FIRST)).rejects.toMatchObject({
      name: "SessionRepoReadError",
      message: "session repository read failed",
    });
    await expect(sessions.loadAllInitialized()).rejects.toMatchObject({
      name: "SessionRepoReadError",
      message: "session repository read failed",
    });
    const emitted = [...warn.mock.calls, ...error.mock.calls].flat().join(" ");
    expect(emitted).not.toContain(detail);
  });

  it("rejects SQLite hydrate status-column disagreement before filtering", async () => {
    const sessions = getSessionRepo();
    expect(await sessions.upsert(...FIRST, state(FIRST, "canonical-owner"))).toBe(true);
    getDb()!.prepare("UPDATE sessions SET status = ? WHERE session_id = ?")
      .run("pending_form", sessionRowId(...FIRST));

    await expect(sessions.getBySessionId(...FIRST)).rejects.toMatchObject({
      name: "SessionRepoReadError",
      message: "session repository read failed",
    });
    await expect(sessions.loadAllInitialized()).rejects.toMatchObject({
      name: "SessionRepoReadError",
      message: "session repository read failed",
    });
  });

  it("normalizes only the context-free legacy canonical bypass shape", async () => {
    const legacyBypass = contextFreeLegacyCanonicalBypass(FIRST);
    const expected = {
      status: "initialized",
      keyId: FIRST[3],
      userId: FIRST[1],
      bypassed: true,
      startedAt: 0,
      attemptCount: 0,
      sessionInfo: null,
      agentDetail: null,
      taskDetail: null,
    };

    const sqlite = getSessionRepo();
    expect(await sqlite.upsert(...FIRST, state(FIRST, "seed"))).toBe(true);
    getDb()!.prepare("UPDATE sessions SET state_json = ? WHERE session_id = ?")
      .run(JSON.stringify(legacyBypass), sessionRowId(...FIRST));
    await expect(sqlite.getBySessionId(...FIRST)).resolves.toMatchObject(expected);
    await expect(sqlite.loadAllInitialized()).resolves.toEqual([
      expect.objectContaining({ state: expect.objectContaining(expected) }),
    ]);

    const storage = new MemoryStorage();
    const kv = new KvSessionRepo(storage);
    await storage.putJSON(`ttl/${FIRST.join("/")}/inj-sess.json`, legacyBypass);
    await expect(kv.getBySessionId(...FIRST)).resolves.toMatchObject(expected);
    await expect(kv.loadAllInitialized()).resolves.toEqual([
      expect.objectContaining({ state: expect.objectContaining(expected) }),
    ]);

    const redis = new FakeRedis();
    const redisRepo = new RedisSessionRepo(redis as never);
    redis.strings.set(
      `inj:sess:${v2IdentityKey(FIRST)}`,
      JSON.stringify(legacyBypass),
    );
    await expect(redisRepo.getBySessionId(...FIRST)).resolves.toMatchObject(expected);
    await expect(redisRepo.loadAllInitialized()).resolves.toEqual([
      expect.objectContaining({ state: expect.objectContaining(expected) }),
    ]);
  });

  it("strips the sole legacy user credential from canonical adapter reads", async () => {
    const detail = "legacy-user-key-detail-sentinel";
    const legacyState = {
      ...state(FIRST, "legacy-credential-owner"),
      sessionInfo: {
        ...state(FIRST, "legacy-credential-owner").sessionInfo!,
        user_key: detail,
      },
    };
    const assertCredentialFree = (value: unknown): void => {
      expect(JSON.stringify(value)).not.toContain(detail);
    };

    const sqlite = getSessionRepo();
    expect(await sqlite.upsert(...FIRST, state(FIRST, "seed"))).toBe(true);
    getDb()!.prepare("UPDATE sessions SET state_json = ? WHERE session_id = ?")
      .run(JSON.stringify(legacyState), sessionRowId(...FIRST));
    assertCredentialFree(await sqlite.getBySessionId(...FIRST));
    assertCredentialFree(await sqlite.loadAllInitialized());

    const storage = new MemoryStorage();
    const kv = new KvSessionRepo(storage);
    await storage.putJSON(`ttl/${FIRST.join("/")}/inj-sess.json`, legacyState);
    assertCredentialFree(await kv.getBySessionId(...FIRST));
    assertCredentialFree(await kv.loadAllInitialized());

    const redis = new FakeRedis();
    const redisRepo = new RedisSessionRepo(redis as never);
    redis.strings.set(
      `inj:sess:${v2IdentityKey(FIRST)}`,
      JSON.stringify(legacyState),
    );
    assertCredentialFree(await redisRepo.getBySessionId(...FIRST));
    assertCredentialFree(await redisRepo.loadAllInitialized());
  });

  it("rejects present malformed and mismatched canonical KV sessions", async () => {
    const detail = "malformed-kv-session-detail-sentinel";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const storage = new MemoryStorage();
    const sessions = new KvSessionRepo(storage);
    const key = `ttl/${FIRST.join("/")}/inj-sess.json`;

    await storage.putText(key, `{${detail}`);
    await expect(sessions.getBySessionId(...FIRST)).rejects.toMatchObject({
      name: "SessionRepoReadError",
      message: "session repository read failed",
    });
    expect(await storage.getText(key)).toBe(`{${detail}`);

    expect(await sessions.upsert(...FIRST, state(SECOND, "wrong-owner"))).toBe(true);
    await expect(sessions.getBySessionId(...FIRST)).rejects.toMatchObject({
      name: "SessionRepoReadError",
      message: "session repository read failed",
    });

    await storage.putJSON(key, { ...state(FIRST, "owner"), status: detail });
    await expect(sessions.getBySessionId(...FIRST)).rejects.toMatchObject({
      name: "SessionRepoReadError",
      message: "session repository read failed",
    });
    await expect(sessions.loadAllInitialized()).rejects.toMatchObject({
      name: "SessionRepoReadError",
      message: "session repository read failed",
    });

    await storage.putJSON(key, incompleteInitializedState(FIRST));
    await expect(sessions.getBySessionId(...FIRST)).rejects.toMatchObject({
      name: "SessionRepoReadError",
      message: "session repository read failed",
    });
    await expect(sessions.loadAllInitialized()).rejects.toMatchObject({
      name: "SessionRepoReadError",
      message: "session repository read failed",
    });
    expect(await new KvSessionRepo(new MemoryStorage()).getBySessionId(...FIRST)).toBeNull();
    const emitted = [...warn.mock.calls, ...error.mock.calls].flat().join(" ");
    expect(emitted).not.toContain(detail);
  });

  it("rejects present malformed and mismatched canonical KV bindings", async () => {
    const detail = "malformed-kv-binding-detail-sentinel";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const storage = new MemoryStorage();
    const bindings = new KvBindingRepo(storage);
    const key = `nottl/${FIRST.join("/")}/binding.json`;

    await storage.putText(key, `{${detail}`);
    await expect(bindings.getBinding(...FIRST)).rejects.toMatchObject({
      name: "BindingRepoReadError",
      message: "binding repository read failed",
    });
    expect(await storage.getText(key)).toBe(`{${detail}`);

    await storage.putJSON(key, {
      outcome: "bypassed",
      userId: SECOND[1],
      created_at: 1,
      last_seen: 1,
    });
    await expect(bindings.getBinding(...FIRST)).rejects.toMatchObject({
      name: "BindingRepoReadError",
      message: "binding repository read failed",
    });

    await storage.putJSON(key, {
      outcome: detail,
      userId: FIRST[1],
      created_at: 1,
      last_seen: 1,
    });
    await expect(bindings.getBinding(...FIRST)).rejects.toMatchObject({
      name: "BindingRepoReadError",
      message: "binding repository read failed",
    });
    expect(await new KvBindingRepo(new MemoryStorage()).getBinding(...FIRST)).toBeNull();
    const emitted = [...warn.mock.calls, ...error.mock.calls].flat().join(" ");
    expect(emitted).not.toContain(detail);
  });

  it("rejects a present mismatched canonical Redis binding", async () => {
    const detail = "malformed-redis-binding-detail-sentinel";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const redis = new FakeRedis();
    const bindings = new RedisBindingRepo(redis as never);
    redis.hashes.set(`inj:binding:${v2IdentityKey(FIRST)}`, {
      outcome: "bypassed",
      user_id: SECOND[1],
    });

    await expect(bindings.getBinding(...FIRST)).rejects.toMatchObject({
      name: "BindingRepoReadError",
      message: "binding repository read failed",
    });

    redis.hashes.set(`inj:binding:${v2IdentityKey(FIRST)}`, {
      outcome: detail,
      user_id: FIRST[1],
    });
    await expect(bindings.getBinding(...FIRST)).rejects.toMatchObject({
      name: "BindingRepoReadError",
      message: "binding repository read failed",
    });
    const emitted = [...warn.mock.calls, ...error.mock.calls].flat().join(" ");
    expect(emitted).not.toContain(detail);
  });

  it("rejects malformed and mismatched canonical Redis hydrate rows", async () => {
    const detail = "malformed-redis-hydrate-detail-sentinel";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const redis = new FakeRedis();
    const sessions = new RedisSessionRepo(redis as never);
    const key = `inj:sess:${v2IdentityKey(FIRST)}`;

    redis.strings.set(key, `{${detail}`);
    await expect(sessions.loadAllInitialized()).rejects.toMatchObject({
      name: "SessionRepoReadError",
      message: "session repository read failed",
    });
    expect(redis.strings.get(key)).toBe(`{${detail}`);

    redis.strings.set(key, JSON.stringify(state(SECOND, "wrong-owner")));
    await expect(sessions.loadAllInitialized()).rejects.toMatchObject({
      name: "SessionRepoReadError",
      message: "session repository read failed",
    });

    redis.strings.set(key, JSON.stringify({ ...state(FIRST, "owner"), status: detail }));
    await expect(sessions.getBySessionId(...FIRST)).rejects.toMatchObject({
      name: "SessionRepoReadError",
      message: "session repository read failed",
    });
    await expect(sessions.loadAllInitialized()).rejects.toMatchObject({
      name: "SessionRepoReadError",
      message: "session repository read failed",
    });

    redis.strings.set(key, JSON.stringify(incompleteInitializedState(FIRST)));
    await expect(sessions.getBySessionId(...FIRST)).rejects.toMatchObject({
      name: "SessionRepoReadError",
      message: "session repository read failed",
    });
    await expect(sessions.loadAllInitialized()).rejects.toMatchObject({
      name: "SessionRepoReadError",
      message: "session repository read failed",
    });
    const emitted = [...warn.mock.calls, ...error.mock.calls].flat().join(" ");
    expect(emitted).not.toContain(detail);
  });

  it.each(["scan", "mget"] as const)(
    "fails closed when Redis hydrate %s fails",
    async (operation) => {
      const redis = new FakeRedis();
      const sessions = new RedisSessionRepo(redis as never);
      redis.strings.set(`inj:sess:${v2IdentityKey(FIRST)}`, JSON.stringify(state(FIRST, "owner")));
      vi.spyOn(redis, operation).mockRejectedValue(new Error("redis-hydrate-backend-detail"));

      await expect(sessions.loadAllInitialized()).rejects.toMatchObject({
        name: "SessionRepoReadError",
        message: "session repository read failed",
      });
    },
  );

  it("bounds Redis binding and hook legacy reads, TTL, touch, and clear", async () => {
    const redis = new FakeRedis();
    const bindings = new RedisBindingRepo(redis as never, 30);
    const hooks = new RedisHookCacheRepo(redis as never, 999);
    const safe = ["space", "user", "claude-code", "session"] as const;
    const bindingLegacy = `inj:binding:${legacyIdentityKey(safe)}`;
    const hookLegacy = `inj:hook:${legacyIdentityKey(safe)}`;
    redis.hashes.set(bindingLegacy, {
      outcome: "initialized", user_id: safe[1], agent_id: "legacy-agent",
    });
    redis.hashes.set(hookLegacy, {
      memory: JSON.stringify([{ type: "text", content: "legacy-hook" }]),
    });
    redis.ttls.set(bindingLegacy, 123);
    redis.ttls.set(hookLegacy, 234);

    expect((await bindings.getBinding(...safe))?.agentId).toBe("legacy-agent");
    expect((await hooks.getAllForSession(...safe))[0]?.blocks[0]?.content).toBe("legacy-hook");
    expect(redis.hashes.has(`inj:binding:${v2IdentityKey(safe)}`)).toBe(false);
    expect(redis.hashes.has(`inj:hook:${v2IdentityKey(safe)}`)).toBe(false);
    expect(redis.ttls.get(bindingLegacy)).toBe(123);
    expect(redis.ttls.get(hookLegacy)).toBe(234);

    const ghost = ["space", "ghost", "claude-code", "session"] as const;
    await bindings.touchLastSeen(...ghost);
    expect([...redis.hashes.keys()].some((key) => key.includes("ghost"))).toBe(false);

    const unsafe = FIRST;
    const unsafeBinding = `inj:binding:${legacyIdentityKey(unsafe)}`;
    const unsafeHook = `inj:hook:${legacyIdentityKey(unsafe)}`;
    redis.hashes.set(unsafeBinding, {
      outcome: "initialized", user_id: unsafe[1], agent_id: "unsafe",
    });
    redis.hashes.set(unsafeHook, {
      memory: JSON.stringify([{ type: "text", content: "unsafe" }]),
    });
    expect(await bindings.getBinding(...unsafe)).toBeNull();
    expect(await hooks.getAllForSession(...unsafe)).toEqual([]);
    await bindings.deleteBinding(...unsafe);
    hooks.clearBySession(...unsafe);
    await settle();
    expect(redis.hashes.has(unsafeBinding)).toBe(true);
    expect(redis.hashes.has(unsafeHook)).toBe(true);

    const missingOwner = ["space", "ownerless", "claude-code", "session"] as const;
    redis.hashes.set(`inj:binding:${legacyIdentityKey(missingOwner)}`, {
      outcome: "initialized", agent_id: "ownerless",
    });
    expect(await bindings.getBinding(...missingOwner)).toBeNull();

    const emptySpace = ["", "user-empty", "claude-code", "session"] as const;
    const emptyLegacyBinding = `inj:binding:${legacyIdentityKey(emptySpace)}`;
    const emptyLegacyHook = `inj:hook:${legacyIdentityKey(emptySpace)}`;
    redis.hashes.set(emptyLegacyBinding, {
      outcome: "initialized", user_id: emptySpace[1], agent_id: "ambiguous-empty",
    });
    redis.hashes.set(emptyLegacyHook, {
      memory: JSON.stringify([{ type: "text", content: "ambiguous-empty" }]),
    });
    expect(await bindings.getBinding(...emptySpace)).toBeNull();
    expect(await hooks.getAllForSession(...emptySpace)).toEqual([]);
    await bindings.deleteBinding(...emptySpace);
    hooks.clearBySession(...emptySpace);
    await settle();
    expect(redis.hashes.has(emptyLegacyBinding)).toBe(true);
    expect(redis.hashes.has(emptyLegacyHook)).toBe(true);
  });
});

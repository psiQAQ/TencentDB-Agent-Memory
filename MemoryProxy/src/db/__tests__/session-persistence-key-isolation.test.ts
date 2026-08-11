import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { RedisBindingRepo } from "../binding-repo.js";
import {
  __resetHookCacheRepoForTests,
  getHookCacheRepo,
} from "../hookCacheRepo.js";
import { __resetDbForTests, getDb } from "../index.js";
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

interface FakeTransaction {
  hset(
    key: string,
    fieldsOrName: Record<string, string> | string,
    ...rest: string[]
  ): FakeTransaction;
  expire(key: string, ttl: number): FakeTransaction;
  exec(): Promise<unknown[]>;
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
        const results: unknown[] = [];
        for (const operation of operations) {
          if (operation.kind === "hset") {
            results.push(await this.hset(...operation.args));
          } else {
            results.push(await this.expire(...operation.args));
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
    restartedSessions.deleteBySessionId(...FIRST);
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
    sessions.deleteBySessionId(...unsafe);
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

    sessions.deleteBySessionId(...FIRST);
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
    sessions.deleteBySessionId(...unsafe);
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
    sqlite.deleteBySessionId(...identity);
    expect(getDb()!.prepare("SELECT COUNT(*) AS count FROM sessions WHERE session_id = ?")
      .get(legacyIdentityKey(identity))).toEqual({ count: 0 });

    const redis = new FakeRedis();
    const redisRepo = new RedisSessionRepo(redis as never);
    const legacyRedisKey = `inj:sess:${legacyIdentityKey(identity)}`;
    redis.strings.set(legacyRedisKey, JSON.stringify(recoveryState));
    redis.ttls.set(legacyRedisKey, 60);
    expect((await redisRepo.getBySessionId(...identity))?.agentDetail?.id)
      .toBe("legacy-recovery-agent");
    redisRepo.deleteBySessionId(...identity);
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

    expect(await sessions.getBySessionId(...identity)).toBeNull();
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

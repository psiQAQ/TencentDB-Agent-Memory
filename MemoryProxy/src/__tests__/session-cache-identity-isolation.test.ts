import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { initAuth } from "../auth.js";
import { DEFAULT_CONFIG } from "../config.js";
import {
  __resetSessionRepoForTests,
  setSessionRepo,
  type SessionRepo,
} from "../db/sessionRepo.js";
import { setMetadataClient } from "../meta/client.js";
import type { BindingRepo, SessionBinding } from "../db/binding-repo.js";
import { renderTdaiMemoryToolsBlock } from "../injection/injectors/tdai-tools-injector.js";
import { renderSkillToolsBlock } from "../injection/injectors/skill-tools-injector.js";
import { createApp } from "../server.js";
import {
  __resetSessionStoreForTests,
  getSessionStore,
  sessionStoreKey,
  SessionStore,
  type SessionIdentity,
} from "../session/store.js";
import type { SessionInitState } from "../session/types.js";
import type { ProxyConfig } from "../types.js";

const VICTIM = {
  key: "key_victim",
  userId: "user_victim",
  spaceId: "space_victim",
  teamId: "team_victim",
  agentId: "agent_victim",
  taskId: "task_victim",
  sessionId: "session_shared",
  source: "claude-code",
} as const;

const OUTSIDER = {
  key: "key_outsider",
  userId: "user_outsider",
  spaceId: "space_outsider",
  teamId: "team_outsider",
  agentId: "agent_outsider",
  taskId: "task_outsider",
} as const;

const VICTIM_CONTEXT = "victim_context_must_not_cross_identity";

const NULL_SESSION_REPO: SessionRepo = {
  upsert: async () => undefined,
  getBySessionId: async () => null,
  deleteBySessionId: () => undefined,
  loadAllInitialized: async () => [],
};

type FullSessionIdentity = SessionIdentity & {
  teamId?: string;
  agentId?: string;
  taskId?: string;
};

function configForTest(): ProxyConfig {
  const config = structuredClone(DEFAULT_CONFIG);
  config.auth = { enabled: true, url: "https://auth.invalid", timeoutMs: 1_000 };
  config.upstream.url = "https://global.invalid/anthropic/v1";
  config.upstream.apiKey = "global-server-key";
  config.upstream.agents = {
    "claude-code": {
      url: "https://claude.upstream.invalid/anthropic/v1",
      apiKey: "claude-server-key",
    },
  };
  config.sessionInit.enabled = true;
  config.injection.enabled = false;
  config.extraction = { enabled: false, extractors: [] };
  config.rateLimit = { tpm: 0, qpm: 0 };
  config.log.backend = "noop";
  config.tdai.endpoint = "https://tdai.invalid";
  config.coreSkill.endpoint = "https://core.invalid";
  config.coreSkill.serviceToken = "core-server-token";
  config.storage.enabled = false;
  config.redis.enabled = false;
  return config;
}

function victimMetadata() {
  const client = {
    listTeams: vi.fn(async () => [{ team_id: VICTIM.teamId, name: "Victim Team" }]),
    listAgents: vi.fn(async () => [{
      agent_id: VICTIM.agentId,
      team_id: VICTIM.teamId,
      name: "Victim Agent",
      description: VICTIM_CONTEXT,
    }]),
    listTasks: vi.fn(async () => [{
      task_id: VICTIM.taskId,
      team_id: VICTIM.teamId,
      title: "Victim Task",
    }]),
    getAgent: vi.fn(async () => ({
      agent_id: VICTIM.agentId,
      team_id: VICTIM.teamId,
      name: "Victim Agent",
      description: VICTIM_CONTEXT,
    })),
    getTask: vi.fn(async () => ({
      task_id: VICTIM.taskId,
      team_id: VICTIM.teamId,
      title: "Victim Task",
    })),
    appendParticipationLog: vi.fn(async () => undefined),
  };
  return client;
}

function requestBody(): Record<string, unknown> {
  return {
    model: "test-model",
    max_tokens: 32,
    stream: false,
    system: "client system",
    messages: [{ role: "user", content: "hello" }],
  };
}

function mainRequest(
  key: string,
  userHeader: string,
  ids: { teamId: string; agentId: string; taskId: string },
): RequestInit {
  return {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": key,
      "x-user-id": userHeader,
      "x-session-id": VICTIM.sessionId,
      "x-team-id": ids.teamId,
      "x-agent-id": ids.agentId,
      "x-task-id": ids.taskId,
    },
    body: JSON.stringify(requestBody()),
  };
}

function victimState(): SessionInitState {
  return {
    status: "initialized",
    keyId: VICTIM.sessionId,
    startedAt: Date.now(),
    attemptCount: 0,
    userId: VICTIM.userId,
    sessionInfo: {
      session_id: VICTIM.sessionId,
      user_id: VICTIM.userId,
      team_id: VICTIM.teamId,
      agent_id: VICTIM.agentId,
      task_id: VICTIM.taskId,
      space_id: VICTIM.spaceId,
    },
    agentDetail: {
      id: VICTIM.agentId,
      name: "Victim Agent",
      description: VICTIM_CONTEXT,
    },
    taskDetail: { id: VICTIM.taskId, name: "Victim Task" },
  };
}

function victimIdentity(): FullSessionIdentity {
  return {
    userId: VICTIM.userId,
    agentSource: VICTIM.source,
    sessionId: VICTIM.sessionId,
    spaceId: VICTIM.spaceId,
    teamId: VICTIM.teamId,
    agentId: VICTIM.agentId,
    taskId: VICTIM.taskId,
  };
}

function fetchStub(fetchCategories: string[], upstreamBodies: Record<string, unknown>[]) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.endsWith("/v3/meta/auth/verify")) {
      fetchCategories.push("auth");
      const payload = JSON.parse(String(init?.body ?? "{}")) as { user_key?: string };
      const userId = payload.user_key === VICTIM.key
        ? VICTIM.userId
        : payload.user_key === OUTSIDER.key
          ? OUTSIDER.userId
          : "";
      return Response.json({
        code: 0,
        data: { valid: Boolean(userId), user: userId ? { user_id: userId } : undefined },
      });
    }
    if (url.endsWith("/v3/meta/config/user/get")) {
      fetchCategories.push("core-capability");
      return Response.json({ code: 0, data: { items: [] } });
    }
    if (url === "https://claude.upstream.invalid/anthropic/v1/messages") {
      fetchCategories.push("model-upstream");
      upstreamBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json({
        id: "msg-test",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
        model: "test-model",
        stop_reason: "end_turn",
      });
    }
    if (url.startsWith("https://core.invalid/")) {
      fetchCategories.push("core-bridge");
      return Response.json({ code: 0, data: { items: [] } });
    }
    throw new Error(`unexpected fetch category: ${new URL(url).hostname}`);
  });
}

async function warmVictimSession(app: ReturnType<typeof createApp>): Promise<void> {
  const response = await app.request(
    `http://proxy/${VICTIM.source}/${VICTIM.spaceId}/v1/messages`,
    mainRequest(VICTIM.key, VICTIM.userId, VICTIM),
  );
  await response.text();
  expect(response.status).toBe(200);
}

describe("session cache identity isolation", () => {
  beforeEach(() => {
    setSessionRepo(NULL_SESSION_REPO);
    __resetSessionStoreForTests();
  });

  afterEach(() => {
    setMetadataClient(null);
    __resetSessionStoreForTests();
    __resetSessionRepoForTests();
    initAuth(DEFAULT_CONFIG.auth);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each([
    ["claims outsider identity", OUTSIDER.userId, OUTSIDER, OUTSIDER.spaceId],
    ["spoofs the victim identity headers", VICTIM.userId, VICTIM, VICTIM.spaceId],
  ] as const)("fails closed when authenticated outsider %s", async (_label, userHeader, ids, spaceId) => {
    const config = configForTest();
    const metadataClient = victimMetadata();
    const fetchCategories: string[] = [];
    const upstreamBodies: Record<string, unknown>[] = [];
    setMetadataClient(metadataClient as never);
    initAuth(config.auth);
    vi.stubGlobal("fetch", fetchStub(fetchCategories, upstreamBodies));
    const app = createApp(config);

    await warmVictimSession(app);
    fetchCategories.length = 0;
    upstreamBodies.length = 0;
    vi.clearAllMocks();

    const response = await app.request(
      `http://proxy/${VICTIM.source}/${spaceId}/v1/messages`,
      mainRequest(OUTSIDER.key, userHeader, ids),
    );
    const text = await response.text();

    expect(response.status).toBe(403);
    expect(text).not.toContain(VICTIM_CONTEXT);
    expect(fetchCategories).toEqual(["auth"]);
    expect(upstreamBodies).toHaveLength(0);
    expect(JSON.stringify(upstreamBodies)).not.toContain(VICTIM_CONTEXT);
    for (const method of Object.values(metadataClient)) {
      expect(method).not.toHaveBeenCalled();
    }
  });

  it.each([
    ["sidequery", {
      model: "test-model",
      max_tokens: 32,
      stream: false,
      tools: [],
      thinking: { type: "disabled" },
      messages: [{ role: "user", content: "title this session" }],
    }],
    ["fork", {
      model: "test-model",
      max_tokens: 32,
      stream: false,
      messages: [
        {
          role: "user",
          content: [{
            type: "text",
            text: "cached prefix",
            cache_control: { type: "ephemeral" },
          }],
        },
        { role: "user", content: "forked request" },
      ],
    }],
  ] as const)("applies the identity gate to an outsider %s", async (_kind, body) => {
    const config = configForTest();
    config.ccRequestRouting.enabled = true;
    const metadataClient = victimMetadata();
    const fetchCategories: string[] = [];
    const upstreamBodies: Record<string, unknown>[] = [];
    setMetadataClient(metadataClient as never);
    initAuth(config.auth);
    vi.stubGlobal("fetch", fetchStub(fetchCategories, upstreamBodies));
    const app = createApp(config);

    await warmVictimSession(app);
    fetchCategories.length = 0;
    upstreamBodies.length = 0;
    vi.clearAllMocks();

    const init = mainRequest(OUTSIDER.key, VICTIM.userId, VICTIM);
    init.body = JSON.stringify(body);
    const response = await app.request(
      `http://proxy/${VICTIM.source}/${VICTIM.spaceId}/v1/messages`,
      init,
    );
    const text = await response.text();

    expect(response.status).toBe(403);
    expect(text).not.toContain(VICTIM_CONTEXT);
    expect(fetchCategories).toEqual(["auth"]);
    expect(upstreamBodies).toHaveLength(0);
    for (const method of Object.values(metadataClient)) {
      expect(method).not.toHaveBeenCalled();
    }
  });

  it.each([
    ["userId", OUTSIDER.userId],
    ["spaceId", OUTSIDER.spaceId],
    ["teamId", OUTSIDER.teamId],
    ["agentId", OUTSIDER.agentId],
    ["taskId", OUTSIDER.taskId],
    ["agentSource", "opencode"],
    ["sessionId", "session_outsider"],
  ] as const)("rejects an L1 identity conflict in %s", async (field, value) => {
    const store = new SessionStore();
    const identity = victimIdentity();
    const key = sessionStoreKey(identity);
    const state = victimState();
    store.bind(key, identity);
    await store.set(key, state);

    await expect(store.getOrRecover(key, { ...identity, [field]: value }, {}))
      .rejects.toMatchObject({ name: "SessionIdentityConflictError" });
    expect(store.getBoundIdentity(key)).toEqual(identity);
    expect(store.get(key)).toEqual(state);
  });

  it("preserves same-user full-identity L1 recovery", async () => {
    const store = new SessionStore();
    const identity = victimIdentity();
    const key = sessionStoreKey(identity);
    const state = victimState();
    store.bind(key, identity);
    await store.set(key, state);

    await expect(store.getOrRecover(key, { ...identity }, {})).resolves.toEqual(state);
  });

  it("does not expire a stale L1 entry before rejecting a bound identity conflict", async () => {
    let persisted: SessionInitState | null = null;
    const deleteBySessionId = vi.fn(() => { persisted = null; });
    const repo: SessionRepo = {
      upsert: vi.fn(async (_space, _user, _source, _session, state) => {
        persisted = state;
      }),
      getBySessionId: vi.fn(async () => persisted),
      deleteBySessionId,
      loadAllInitialized: async () => [],
    };
    const getBinding = vi.fn(async (): Promise<SessionBinding> => ({
      outcome: "bypassed",
      userId: VICTIM.userId,
      teamId: VICTIM.teamId,
      agentId: VICTIM.agentId,
      taskId: VICTIM.taskId,
    }));
    const touchLastSeen = vi.fn(async () => undefined);
    const bindingRepo: BindingRepo = {
      getBinding,
      putBinding: vi.fn(async () => undefined),
      deleteBinding: vi.fn(async () => undefined),
      touchLastSeen,
    };
    const identity = victimIdentity();
    const key = sessionStoreKey(identity);
    const stale: SessionInitState = {
      ...victimState(),
      status: "pending_task_select",
      startedAt: 0,
    };
    const store = new SessionStore(1, repo, bindingRepo);
    store.bind(key, identity);
    await store.set(key, stale);
    vi.clearAllMocks();

    await expect(store.getOrRecover(key, { ...identity, taskId: OUTSIDER.taskId }, {}))
      .rejects.toMatchObject({ name: "SessionIdentityConflictError" });
    expect(deleteBySessionId).not.toHaveBeenCalled();
    expect(getBinding).not.toHaveBeenCalled();
    expect(touchLastSeen).not.toHaveBeenCalled();
    expect(store.getBoundIdentity(key)).toEqual(identity);

    await expect(store.getOrRecover(key, identity, {})).resolves.toMatchObject({
      status: "initialized",
      bypassed: true,
    });
    expect(deleteBySessionId).toHaveBeenCalled();
    expect(getBinding).toHaveBeenCalledTimes(1);
  });

  it("does not bind a rejected L2a identity and allows the valid caller", async () => {
    const identity = victimIdentity();
    const rejectedIdentity = { ...identity, taskId: OUTSIDER.taskId };
    const key = sessionStoreKey(identity);
    const upsert = vi.fn(async () => undefined);
    const deleteBySessionId = vi.fn(() => undefined);
    const getAgent = vi.fn();
    const getTask = vi.fn();
    const repo: SessionRepo = {
      upsert,
      getBySessionId: async () => victimState(),
      deleteBySessionId,
      loadAllInitialized: async () => [],
    };
    const store = new SessionStore(30 * 60 * 1_000, repo);

    await expect(store.getOrRecover(key, rejectedIdentity, {
      metadataClient: { getAgent, getTask } as never,
    })).rejects.toMatchObject({ name: "SessionIdentityConflictError" });
    expect(store.getBoundIdentity(key)).toBeUndefined();
    expect(store.get(key)).toBeUndefined();
    expect(upsert).not.toHaveBeenCalled();
    expect(deleteBySessionId).not.toHaveBeenCalled();
    expect(getAgent).not.toHaveBeenCalled();
    expect(getTask).not.toHaveBeenCalled();

    await expect(store.getOrRecover(key, identity, {})).resolves.toMatchObject({
      sessionInfo: expect.objectContaining({ task_id: VICTIM.taskId }),
    });
    expect(store.getBoundIdentity(key)).toEqual(identity);
  });

  it("does not delete an expired L2a row before rejecting a binding conflict", async () => {
    const identity = victimIdentity();
    const key = sessionStoreKey(identity);
    const expired: SessionInitState = {
      ...victimState(),
      status: "pending_task_select",
      startedAt: 0,
    };
    let persisted: SessionInitState | null = expired;
    const deleteBySessionId = vi.fn(() => { persisted = null; });
    const repo: SessionRepo = {
      upsert: vi.fn(async (_space, _user, _source, _session, state) => {
        persisted = state;
      }),
      getBySessionId: vi.fn(async () => persisted),
      deleteBySessionId,
      loadAllInitialized: async () => [],
    };
    let binding: SessionBinding = {
      outcome: "bypassed",
      userId: VICTIM.userId,
      teamId: VICTIM.teamId,
      agentId: VICTIM.agentId,
      taskId: OUTSIDER.taskId,
    };
    const touchLastSeen = vi.fn(async () => undefined);
    const bindingRepo: BindingRepo = {
      getBinding: vi.fn(async () => binding),
      putBinding: vi.fn(async () => undefined),
      deleteBinding: vi.fn(async () => undefined),
      touchLastSeen,
    };
    const store = new SessionStore(1, repo, bindingRepo);

    await expect(store.getOrRecover(key, identity, {}))
      .rejects.toMatchObject({ name: "SessionIdentityConflictError" });
    expect(deleteBySessionId).not.toHaveBeenCalled();
    expect(touchLastSeen).not.toHaveBeenCalled();
    expect(store.getBoundIdentity(key)).toBeUndefined();

    binding = { ...binding, taskId: VICTIM.taskId };
    await expect(store.getOrRecover(key, identity, {})).resolves.toMatchObject({
      status: "initialized",
      bypassed: true,
    });
    expect(deleteBySessionId).toHaveBeenCalledTimes(1);
  });

  it("does not bind a rejected raw-session collision or disturb the owner", async () => {
    const store = new SessionStore();
    const identity = victimIdentity();
    const key = sessionStoreKey(identity);
    const state = victimState();
    store.bind(key, identity);
    await store.set(key, state);
    const collidingIdentity: FullSessionIdentity = {
      userId: OUTSIDER.userId,
      spaceId: OUTSIDER.spaceId,
      agentSource: VICTIM.source,
      sessionId: VICTIM.sessionId,
      teamId: OUTSIDER.teamId,
      agentId: OUTSIDER.agentId,
      taskId: OUTSIDER.taskId,
    };
    const collidingKey = sessionStoreKey(collidingIdentity);

    await expect(store.getOrRecover(collidingKey, collidingIdentity, {}))
      .rejects.toMatchObject({ name: "SessionIdentityConflictError" });
    expect(store.getBoundIdentity(collidingKey)).toBeUndefined();
    expect(store.get(collidingKey)).toBeUndefined();
    expect(store.getBoundIdentity(key)).toEqual(identity);
    await expect(store.getOrRecover(key, identity, {})).resolves.toEqual(state);
  });

  it("scans raw-session conflicts without expiring another identity's state", async () => {
    const deleteBySessionId = vi.fn(() => undefined);
    const repo: SessionRepo = {
      upsert: vi.fn(async () => undefined),
      getBySessionId: vi.fn(async () => null),
      deleteBySessionId,
      loadAllInitialized: async () => [],
    };
    const store = new SessionStore(1, repo);
    const expiredIdentity = victimIdentity();
    const expiredKey = sessionStoreKey(expiredIdentity);
    store.bind(expiredKey, expiredIdentity);
    await store.set(expiredKey, {
      ...victimState(),
      status: "pending_task_select",
      startedAt: 0,
    });

    const liveIdentity: FullSessionIdentity = {
      ...expiredIdentity,
      userId: "user_live",
      spaceId: "space_live",
      teamId: "team_live",
      agentId: "agent_live",
      taskId: "task_live",
    };
    const liveKey = sessionStoreKey(liveIdentity);
    const liveState: SessionInitState = {
      ...victimState(),
      userId: liveIdentity.userId,
      sessionInfo: {
        ...victimState().sessionInfo!,
        user_id: liveIdentity.userId,
        space_id: liveIdentity.spaceId,
        team_id: liveIdentity.teamId,
        agent_id: liveIdentity.agentId,
        task_id: liveIdentity.taskId,
      },
    };
    store.bind(liveKey, liveIdentity);
    await store.set(liveKey, liveState);
    vi.clearAllMocks();

    const rejectedIdentity: FullSessionIdentity = {
      ...expiredIdentity,
      userId: OUTSIDER.userId,
      spaceId: OUTSIDER.spaceId,
      teamId: OUTSIDER.teamId,
      agentId: OUTSIDER.agentId,
      taskId: OUTSIDER.taskId,
    };
    await expect(store.getOrRecover(
      sessionStoreKey(rejectedIdentity),
      rejectedIdentity,
      {},
    )).rejects.toMatchObject({ name: "SessionIdentityConflictError" });
    expect(deleteBySessionId).not.toHaveBeenCalled();
    expect(store.getBoundIdentity(expiredKey)).toEqual(expiredIdentity);
    expect(store.getBoundIdentity(liveKey)).toEqual(liveIdentity);
    expect(store.get(liveKey)).toEqual(liveState);

    await expect(store.getOrRecover(liveKey, liveIdentity, {})).resolves.toEqual(liveState);
    expect(deleteBySessionId).not.toHaveBeenCalled();
  });

  it("hydrates both users that share a source and raw session id", async () => {
    const outsiderIdentity: FullSessionIdentity = {
      userId: OUTSIDER.userId,
      agentSource: VICTIM.source,
      sessionId: VICTIM.sessionId,
      spaceId: OUTSIDER.spaceId,
      teamId: OUTSIDER.teamId,
      agentId: OUTSIDER.agentId,
      taskId: OUTSIDER.taskId,
    };
    const outsiderState: SessionInitState = {
      ...victimState(),
      userId: OUTSIDER.userId,
      sessionInfo: {
        ...victimState().sessionInfo!,
        user_id: OUTSIDER.userId,
        space_id: OUTSIDER.spaceId,
        team_id: OUTSIDER.teamId,
        agent_id: OUTSIDER.agentId,
        task_id: OUTSIDER.taskId,
      },
      agentDetail: { id: OUTSIDER.agentId, name: "Outsider Agent" },
      taskDetail: { id: OUTSIDER.taskId, name: "Outsider Task" },
    };
    const repo: SessionRepo = {
      ...NULL_SESSION_REPO,
      loadAllInitialized: async () => [
        {
          spaceId: VICTIM.spaceId,
          userId: VICTIM.userId,
          agentSource: VICTIM.source,
          sessionId: VICTIM.sessionId,
          state: victimState(),
        },
        {
          spaceId: OUTSIDER.spaceId,
          userId: OUTSIDER.userId,
          agentSource: VICTIM.source,
          sessionId: VICTIM.sessionId,
          state: outsiderState,
        },
      ],
    };
    const store = new SessionStore(30 * 60 * 1_000, repo);

    await expect(store.hydrateFromDb()).resolves.toBe(2);
    expect(store.get(sessionStoreKey(victimIdentity()))?.sessionInfo?.user_id)
      .toBe(VICTIM.userId);
    expect(store.get(sessionStoreKey(outsiderIdentity))?.sessionInfo?.user_id)
      .toBe(OUTSIDER.userId);
  });

  it("does not deduplicate concurrent recovery across user and space", async () => {
    const outsiderIdentity: FullSessionIdentity = {
      userId: OUTSIDER.userId,
      agentSource: VICTIM.source,
      sessionId: VICTIM.sessionId,
      spaceId: OUTSIDER.spaceId,
      teamId: OUTSIDER.teamId,
      agentId: OUTSIDER.agentId,
      taskId: OUTSIDER.taskId,
    };
    const bindingRepo: BindingRepo = {
      getBinding: async (_space, userId) => userId === VICTIM.userId
        ? {
            outcome: "initialized",
            userId: VICTIM.userId,
            teamId: VICTIM.teamId,
            agentId: VICTIM.agentId,
            taskId: VICTIM.taskId,
          }
        : {
            outcome: "initialized",
            userId: OUTSIDER.userId,
            teamId: OUTSIDER.teamId,
            agentId: OUTSIDER.agentId,
            taskId: OUTSIDER.taskId,
          },
      putBinding: async () => undefined,
      deleteBinding: async () => undefined,
      touchLastSeen: async () => undefined,
    };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const clientFor = (identity: FullSessionIdentity) => ({
      getAgent: vi.fn(async () => {
        await gate;
        return { agent_id: identity.agentId!, name: identity.agentId! };
      }),
      getTask: vi.fn(async () => ({ task_id: identity.taskId!, title: identity.taskId! })),
    });
    const victimClient = clientFor(victimIdentity());
    const outsiderClient = clientFor(outsiderIdentity);
    const store = new SessionStore(30 * 60 * 1_000, undefined, bindingRepo);

    const victimRecovery = store.getOrRecover(
      sessionStoreKey(victimIdentity()),
      victimIdentity(),
      { metadataClient: victimClient as never },
    );
    await Promise.resolve();
    await Promise.resolve();
    const outsiderRecovery = store.getOrRecover(
      sessionStoreKey(outsiderIdentity),
      outsiderIdentity,
      { metadataClient: outsiderClient as never },
    );
    await Promise.resolve();
    await Promise.resolve();
    release();

    const [victimRecovered, outsiderRecovered] = await Promise.all([
      victimRecovery,
      outsiderRecovery,
    ]);
    expect(victimClient.getAgent).toHaveBeenCalledTimes(1);
    expect(outsiderClient.getAgent).toHaveBeenCalledTimes(1);
    expect(victimRecovered?.sessionInfo).toMatchObject({
      user_id: VICTIM.userId,
      space_id: VICTIM.spaceId,
      agent_id: VICTIM.agentId,
    });
    expect(outsiderRecovered?.sessionInfo).toMatchObject({
      user_id: OUTSIDER.userId,
      space_id: OUTSIDER.spaceId,
      agent_id: OUTSIDER.agentId,
    });
  });

  it("rejects a mismatched bypass binding before touch or cache write", async () => {
    const touchLastSeen = vi.fn(async () => undefined);
    const putBinding = vi.fn(async () => undefined);
    let binding: SessionBinding = {
      outcome: "bypassed",
      userId: VICTIM.userId,
      teamId: VICTIM.teamId,
      agentId: VICTIM.agentId,
      taskId: VICTIM.taskId,
    };
    const bindingRepo: BindingRepo = {
      getBinding: async () => binding,
      putBinding,
      deleteBinding: async () => undefined,
      touchLastSeen,
    };
    const store = new SessionStore(30 * 60 * 1_000, undefined, bindingRepo);
    const identity = victimIdentity();
    const rejectedIdentity = { ...identity, taskId: OUTSIDER.taskId };
    const key = sessionStoreKey(identity);

    await expect(store.getOrRecover(key, rejectedIdentity, {}))
      .rejects.toMatchObject({ name: "SessionIdentityConflictError" });
    expect(touchLastSeen).not.toHaveBeenCalled();
    expect(putBinding).not.toHaveBeenCalled();
    expect(store.getBoundIdentity(key)).toBeUndefined();
    expect(store.get(key)).toBeUndefined();

    binding = { ...binding, outcome: "initialized" };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const getAgent = vi.fn(async () => {
      await gate;
      return { agent_id: VICTIM.agentId, name: "Victim Agent" };
    });
    const getTask = vi.fn(async () => ({ task_id: VICTIM.taskId, title: "Victim Task" }));
    const ctx = { metadataClient: { getAgent, getTask } as never };
    const first = store.getOrRecover(key, identity, ctx);
    const second = store.getOrRecover(key, identity, ctx);
    release();
    const recovered = await Promise.all([first, second]);

    expect(recovered).toHaveLength(2);
    expect(getAgent).toHaveBeenCalledTimes(1);
    expect(getTask).toHaveBeenCalledTimes(1);
    expect(store.getBoundIdentity(key)).toEqual(identity);
    expect(store.get(key)?.sessionInfo?.task_id).toBe(VICTIM.taskId);
  });

  it("accepts and rebinds a legacy bypass binding with no embedded identity", async () => {
    const touchLastSeen = vi.fn(async () => undefined);
    const putBinding = vi.fn(async () => undefined);
    const bindingRepo: BindingRepo = {
      getBinding: async () => ({ outcome: "bypassed" }),
      putBinding,
      deleteBinding: async () => undefined,
      touchLastSeen,
    };
    const store = new SessionStore(30 * 60 * 1_000, undefined, bindingRepo);
    const identity = victimIdentity();
    const key = sessionStoreKey(identity);

    await expect(store.getOrRecover(key, identity, {})).resolves.toMatchObject({
      status: "initialized",
      bypassed: true,
      keyId: VICTIM.sessionId,
      userId: VICTIM.userId,
    });
    await expect(store.getOrRecover(key, identity, {})).resolves.toMatchObject({
      status: "initialized",
      bypassed: true,
      keyId: VICTIM.sessionId,
      userId: VICTIM.userId,
    });
    expect(touchLastSeen).toHaveBeenCalledTimes(1);
    expect(putBinding).toHaveBeenCalledWith(
      VICTIM.spaceId,
      VICTIM.userId,
      VICTIM.source,
      VICTIM.sessionId,
      expect.objectContaining({ outcome: "bypassed", userId: VICTIM.userId }),
    );
  });

  it("recovers a legacy bypass state from L2a after restart", async () => {
    let persistedState: SessionInitState | null = null;
    const repo: SessionRepo = {
      upsert: async (_spaceId, _userId, _source, _sessionId, state) => {
        persistedState = state;
      },
      getBySessionId: async () => persistedState,
      deleteBySessionId: () => undefined,
      loadAllInitialized: async () => [],
    };
    const bindingRepo: BindingRepo = {
      getBinding: async () => ({ outcome: "bypassed" }),
      putBinding: async () => undefined,
      deleteBinding: async () => undefined,
      touchLastSeen: async () => undefined,
    };
    const identity = victimIdentity();
    const key = sessionStoreKey(identity);
    const firstStore = new SessionStore(30 * 60 * 1_000, repo, bindingRepo);

    await expect(firstStore.getOrRecover(key, identity, {})).resolves.toMatchObject({
      status: "initialized",
      bypassed: true,
    });
    expect(persistedState).toMatchObject({ bypassed: true });

    const restartedStore = new SessionStore(30 * 60 * 1_000, repo, bindingRepo);
    await expect(restartedStore.getOrRecover(key, identity, {})).resolves.toMatchObject({
      status: "initialized",
      bypassed: true,
      keyId: VICTIM.sessionId,
      userId: VICTIM.userId,
    });
  });

  it.each([
    ["memory", "/memory-bridge/v3/scenario/read", 403],
    ["skill", "/skill-bridge/v3/skill/list", 401],
  ] as const)("rejects outsider %s bridge access before Core", async (_bridge, path, expectedStatus) => {
    const config = configForTest();
    const metadataClient = victimMetadata();
    const fetchCategories: string[] = [];
    const upstreamBodies: Record<string, unknown>[] = [];
    setMetadataClient(metadataClient as never);
    initAuth(config.auth);
    vi.stubGlobal("fetch", fetchStub(fetchCategories, upstreamBodies));
    const app = createApp(config);

    await warmVictimSession(app);
    fetchCategories.length = 0;
    upstreamBodies.length = 0;

    const response = await app.request(`http://proxy${path}`, {
      method: "POST",
      headers: {
        "authorization": `Bearer ${OUTSIDER.key}`,
        "content-type": "application/json",
        "x-conversation-id": VICTIM.sessionId,
        "x-tdai-service-id": VICTIM.spaceId,
        "x-tdai-agent-source": VICTIM.source,
      },
      body: "{}",
    });
    const text = await response.text();

    expect(response.status).toBe(expectedStatus);
    expect(text).not.toContain(VICTIM_CONTEXT);
    expect(fetchCategories).toEqual(["auth"]);
    expect(upstreamBodies).toHaveLength(0);
  });

  it("rejects a memory bridge task identity override before Core", async () => {
    const config = configForTest();
    const metadataClient = victimMetadata();
    const fetchCategories: string[] = [];
    const upstreamBodies: Record<string, unknown>[] = [];
    setMetadataClient(metadataClient as never);
    initAuth(config.auth);
    vi.stubGlobal("fetch", fetchStub(fetchCategories, upstreamBodies));
    const app = createApp(config);

    await warmVictimSession(app);
    fetchCategories.length = 0;
    upstreamBodies.length = 0;

    const response = await app.request("http://proxy/memory-bridge/v3/scenario/read", {
      method: "POST",
      headers: {
        "authorization": `Bearer ${VICTIM.key}`,
        "content-type": "application/json",
        "x-conversation-id": VICTIM.sessionId,
        "x-tdai-service-id": VICTIM.spaceId,
        "x-tdai-agent-source": VICTIM.source,
      },
      body: JSON.stringify({ task_id: OUTSIDER.taskId }),
    });

    expect(response.status).toBe(403);
    expect(fetchCategories).toEqual(["auth"]);
    expect(upstreamBodies).toHaveLength(0);
  });

  it("rejects a cold L2b task override before recovery metadata or touch", async () => {
    const config = configForTest();
    const metadataClient = victimMetadata();
    const touchLastSeen = vi.fn(async () => undefined);
    const bindingRepo: BindingRepo = {
      getBinding: async () => ({
        outcome: "initialized",
        userId: VICTIM.userId,
        teamId: VICTIM.teamId,
        agentId: VICTIM.agentId,
        taskId: VICTIM.taskId,
      }),
      putBinding: async () => undefined,
      deleteBinding: async () => undefined,
      touchLastSeen,
    };
    const fetchCategories: string[] = [];
    const upstreamBodies: Record<string, unknown>[] = [];
    setMetadataClient(metadataClient as never);
    initAuth(config.auth);
    vi.stubGlobal("fetch", fetchStub(fetchCategories, upstreamBodies));
    getSessionStore().setBindingRepo(bindingRepo);
    const app = createApp(config);

    const response = await app.request("http://proxy/memory-bridge/v3/scenario/read", {
      method: "POST",
      headers: {
        "authorization": `Bearer ${VICTIM.key}`,
        "content-type": "application/json",
        "x-conversation-id": VICTIM.sessionId,
        "x-tdai-service-id": VICTIM.spaceId,
        "x-tdai-agent-source": VICTIM.source,
      },
      body: JSON.stringify({ task_id: OUTSIDER.taskId }),
    });

    expect(response.status).toBe(403);
    expect(fetchCategories).toEqual(["auth"]);
    expect(metadataClient.getAgent).not.toHaveBeenCalled();
    expect(metadataClient.getTask).not.toHaveBeenCalled();
    expect(touchLastSeen).not.toHaveBeenCalled();
    expect(upstreamBodies).toHaveLength(0);
  });

  it("renders bridge credentials as a client environment reference", () => {
    const blocks = [
      renderTdaiMemoryToolsBlock(
        "http://proxy",
        VICTIM.sessionId,
        VICTIM.spaceId,
        VICTIM.source,
      ),
      renderSkillToolsBlock(
        "http://proxy",
        false,
        VICTIM.sessionId,
        VICTIM.spaceId,
        VICTIM.source,
      ),
    ];

    for (const block of blocks) {
      expect(block).toContain("${TDAI_MEMORY_USER_KEY:?");
      expect(block).toContain(`x-tdai-agent-source: ${VICTIM.source}`);
      expect(block).toContain(`x-tdai-service-id: ${VICTIM.spaceId}`);
      expect(block).toContain(`x-conversation-id: ${VICTIM.sessionId}`);
      expect(block).not.toContain(VICTIM.key);
      expect(block).not.toContain(OUTSIDER.key);
    }
  });

  it.each([
    ["memory", "/memory-bridge/v3/scenario/read"],
    ["skill", "/skill-bridge/v3/skill/list"],
  ] as const)("rejects unauthenticated %s bridge access before cache or Core", async (_bridge, path) => {
    const config = configForTest();
    const metadataClient = victimMetadata();
    const fetchCategories: string[] = [];
    const upstreamBodies: Record<string, unknown>[] = [];
    setMetadataClient(metadataClient as never);
    initAuth(config.auth);
    vi.stubGlobal("fetch", fetchStub(fetchCategories, upstreamBodies));
    const app = createApp(config);

    await warmVictimSession(app);
    fetchCategories.length = 0;
    upstreamBodies.length = 0;

    const response = await app.request(`http://proxy${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-conversation-id": VICTIM.sessionId,
        "x-tdai-service-id": VICTIM.spaceId,
        "x-tdai-agent-source": VICTIM.source,
      },
      body: "{}",
    });

    expect(response.status).toBe(401);
    expect(fetchCategories).toEqual([]);
    expect(upstreamBodies).toHaveLength(0);
  });

  it.each([
    ["memory", "/memory-bridge/v3/scenario/read"],
    ["skill", "/skill-bridge/v3/skill/list"],
  ] as const)("rejects an unregistered %s bridge source before auth or cache", async (_bridge, path) => {
    const config = configForTest();
    const fetchCategories: string[] = [];
    const upstreamBodies: Record<string, unknown>[] = [];
    initAuth(config.auth);
    vi.stubGlobal("fetch", fetchStub(fetchCategories, upstreamBodies));
    const app = createApp(config);

    const response = await app.request(`http://proxy${path}`, {
      method: "POST",
      headers: {
        "authorization": `Bearer ${VICTIM.key}`,
        "content-type": "application/json",
        "x-conversation-id": VICTIM.sessionId,
        "x-tdai-service-id": VICTIM.spaceId,
        "x-tdai-agent-source": "unknown-client",
      },
      body: "{}",
    });

    expect(response.status).toBe(400);
    expect(fetchCategories).toEqual([]);
    expect(upstreamBodies).toHaveLength(0);
  });

  it.each([
    ["memory", "/memory-bridge/v3/scenario/read"],
    ["skill", "/skill-bridge/v3/skill/list"],
  ] as const)("preserves authenticated same-user %s bridge access", async (_bridge, path) => {
    const config = configForTest();
    const metadataClient = victimMetadata();
    const fetchCategories: string[] = [];
    const upstreamBodies: Record<string, unknown>[] = [];
    setMetadataClient(metadataClient as never);
    initAuth(config.auth);
    vi.stubGlobal("fetch", fetchStub(fetchCategories, upstreamBodies));
    const app = createApp(config);

    await warmVictimSession(app);
    fetchCategories.length = 0;
    upstreamBodies.length = 0;

    const response = await app.request(`http://proxy${path}`, {
      method: "POST",
      headers: {
        "authorization": `Bearer ${VICTIM.key}`,
        "content-type": "application/json",
        "x-conversation-id": VICTIM.sessionId,
        "x-tdai-service-id": VICTIM.spaceId,
        "x-tdai-agent-source": VICTIM.source,
      },
      body: "{}",
    });
    await response.text();

    expect(response.status).toBe(200);
    expect(fetchCategories).toEqual(["auth", "core-bridge"]);
    expect(upstreamBodies).toHaveLength(0);
  });

  it.each([
    ["memory", "/memory-bridge/v3/scenario/read"],
    ["skill", "/skill-bridge/v3/skill/list"],
  ] as const)("restores authenticated request space for a legacy %s bridge session", async (_bridge, path) => {
    const legacyState = victimState();
    delete legacyState.sessionInfo!.space_id;
    setSessionRepo({
      ...NULL_SESSION_REPO,
      getBySessionId: async () => legacyState,
    });
    __resetSessionStoreForTests();

    const config = configForTest();
    const fetchCategories: string[] = [];
    const upstreamBodies: Record<string, unknown>[] = [];
    initAuth(config.auth);
    vi.stubGlobal("fetch", fetchStub(fetchCategories, upstreamBodies));
    const app = createApp(config);

    const response = await app.request(`http://proxy${path}`, {
      method: "POST",
      headers: {
        "authorization": `Bearer ${VICTIM.key}`,
        "content-type": "application/json",
        "x-conversation-id": VICTIM.sessionId,
        "x-tdai-service-id": VICTIM.spaceId,
        "x-tdai-agent-source": VICTIM.source,
      },
      body: "{}",
    });
    await response.text();

    expect(response.status).toBe(200);
    expect(fetchCategories[0]).toBe("auth");
    expect(fetchCategories.slice(1).length).toBeGreaterThan(0);
    expect(fetchCategories.slice(1).every((category) => category === "core-bridge")).toBe(true);
    expect(upstreamBodies).toHaveLength(0);
  });
});

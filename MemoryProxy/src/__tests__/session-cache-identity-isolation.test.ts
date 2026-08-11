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
  upsert: async () => false,
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
    if (url === "https://codebuddy.upstream.invalid/v1/chat/completions") {
      fetchCategories.push("model-upstream");
      upstreamBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json({
        id: "chatcmpl-test",
        object: "chat.completion",
        model: "test-model",
        choices: [{
          index: 0,
          message: { role: "assistant", content: "ok" },
          finish_reason: "stop",
        }],
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

async function seedVictimSessionForSource(agentSource: string): Promise<void> {
  const identity = { ...victimIdentity(), agentSource };
  const key = sessionStoreKey(identity);
  const store = getSessionStore();
  store.bind(key, identity);
  await store.set(key, victimState());
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
    ["anthropic", VICTIM.source, `/${VICTIM.source}/${VICTIM.spaceId}/v1/messages`],
    ["openai", "codebuddy", `/codebuddy/${VICTIM.spaceId}/v1/chat/completions`],
  ] as const)("rejects a context-suppressed %s session before downstream work", async (
    protocol,
    agentSource,
    path,
  ) => {
    const config = configForTest();
    config.upstream.agents!.codebuddy = {
      url: "https://codebuddy.upstream.invalid/v1",
      apiKey: "codebuddy-server-key",
    };
    config.injection.enabled = true;
    config.injection.injectors = ["skill"];
    config.extraction = { enabled: true, extractors: ["skill", "tdai-memory"] };
    config.tdai.enabled = true;
    config.tdai.memory.enabled = true;
    config.tdai.memory.writeL0 = true;
    const fetchCategories: string[] = [];
    const upstreamBodies: Record<string, unknown>[] = [];
    initAuth(config.auth);
    vi.stubGlobal("fetch", fetchStub(fetchCategories, upstreamBodies));

    const identity = { ...victimIdentity(), agentSource };
    const key = sessionStoreKey(identity);
    const store = getSessionStore();
    store.bind(key, identity);
    await store.set(key, {
      ...victimState(),
      contextSuppressed: true,
    } as SessionInitState);
    const app = createApp(config);
    const request = mainRequest(VICTIM.key, VICTIM.userId, VICTIM);
    if (protocol === "openai") {
      const headers = new Headers(request.headers);
      headers.delete("x-api-key");
      headers.set("authorization", `Bearer ${VICTIM.key}`);
      request.headers = headers;
    }

    const response = await app.request(
      `http://proxy${path}`,
      request,
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "session_context_unavailable" });
    expect(fetchCategories).toEqual(["auth"]);
    expect(upstreamBodies).toHaveLength(0);
  });

  it.each([
    ["anthropic", VICTIM.source, `/${VICTIM.source}/${VICTIM.spaceId}/v1/messages`, "agent-missing"],
    ["openai", "codebuddy", `/codebuddy/${VICTIM.spaceId}/v1/chat/completions`, "task-missing"],
  ] as const)("rejects mixed authoritative-missing %s recovery before the model", async (
    protocol,
    agentSource,
    path,
    missingSide,
  ) => {
    const config = configForTest();
    config.upstream.agents!.codebuddy = {
      url: "https://codebuddy.upstream.invalid/v1",
      apiKey: "codebuddy-server-key",
    };
    const fetchCategories: string[] = [];
    const upstreamBodies: Record<string, unknown>[] = [];
    const metadataClient = {
      getAgent: vi.fn(async () => {
        if (missingSide === "agent-missing") return null;
        throw new Error("metadata transient sentinel");
      }),
      getTask: vi.fn(async () => {
        if (missingSide === "task-missing") return null;
        throw new Error("metadata transient sentinel");
      }),
    };
    const bindingRepo: BindingRepo = {
      getBinding: vi.fn(async (): Promise<SessionBinding> => ({
        outcome: "initialized",
        userId: VICTIM.userId,
        teamId: VICTIM.teamId,
        agentId: VICTIM.agentId,
        taskId: VICTIM.taskId,
      })),
      putBinding: vi.fn(async () => true),
      deleteBinding: vi.fn(async () => undefined),
      touchLastSeen: vi.fn(async () => undefined),
    };
    setMetadataClient(metadataClient as never);
    getSessionStore().setBindingRepo(bindingRepo);
    initAuth(config.auth);
    vi.stubGlobal("fetch", fetchStub(fetchCategories, upstreamBodies));
    const app = createApp(config);
    const request = mainRequest(VICTIM.key, VICTIM.userId, VICTIM);
    if (protocol === "openai") {
      const headers = new Headers(request.headers);
      headers.delete("x-api-key");
      headers.set("authorization", `Bearer ${VICTIM.key}`);
      request.headers = headers;
    }

    const response = await app.request(`http://proxy${path}`, request);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "session_context_unavailable" });
    expect(fetchCategories).toEqual(["auth"]);
    expect(upstreamBodies).toHaveLength(0);

    vi.clearAllMocks();
    fetchCategories.length = 0;
    const secondResponse = await app.request(`http://proxy${path}`, request);
    expect(secondResponse.status).toBe(409);
    expect(fetchCategories).toEqual(["auth"]);
    expect(upstreamBodies).toHaveLength(0);
    expect(metadataClient.getAgent).not.toHaveBeenCalled();
    expect(metadataClient.getTask).not.toHaveBeenCalled();
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

  it("keeps optional identity claims monotonic across bind and L1 recovery", async () => {
    const store = new SessionStore();
    const identity = victimIdentity();
    const key = sessionStoreKey(identity);
    const mandatoryOnly: SessionIdentity = {
      userId: identity.userId,
      agentSource: identity.agentSource,
      sessionId: identity.sessionId,
      spaceId: identity.spaceId,
    };
    const conflicting = { ...identity, taskId: OUTSIDER.taskId };
    const state = victimState();
    store.bind(key, identity);
    await store.set(key, state);

    store.bind(key, mandatoryOnly);
    await expect(store.getOrRecover(key, mandatoryOnly, {})).resolves.toEqual(state);

    expect(store.getBoundIdentity(key)).toEqual(identity);
    expect(store.get(key)).toEqual(state);
    expect(() => store.bind(key, conflicting)).toThrowError("session_identity_conflict");
    await expect(store.getOrRecover(key, conflicting, {}))
      .rejects.toMatchObject({ name: "SessionIdentityConflictError" });
    expect(store.getBoundIdentity(key)).toEqual(identity);
    expect(store.get(key)).toEqual(state);
  });

  it("promotes optional identity from initialized state before a later bind", async () => {
    const fullIdentity = victimIdentity();
    const partialIdentity: FullSessionIdentity = {
      userId: fullIdentity.userId,
      agentSource: fullIdentity.agentSource,
      sessionId: fullIdentity.sessionId,
      spaceId: fullIdentity.spaceId,
    };
    const conflictingIdentity: FullSessionIdentity = {
      ...fullIdentity,
      taskId: OUTSIDER.taskId,
    };
    const key = sessionStoreKey(partialIdentity);
    const state = victimState();
    const store = new SessionStore();

    store.bind(key, partialIdentity);
    await store.set(key, state);

    expect(store.getBoundIdentity(key)).toEqual(fullIdentity);
    expect(() => store.bind(key, conflictingIdentity))
      .toThrowError(expect.objectContaining({ name: "SessionIdentityConflictError" }));
    expect(store.getBoundIdentity(key)).toEqual(fullIdentity);
    expect(store.get(key)).toEqual(state);
    await expect(store.getOrRecover(key, fullIdentity, {})).resolves.toEqual(state);
  });

  it("does not expire a stale L1 entry before rejecting a bound identity conflict", async () => {
    let persisted: SessionInitState | null = null;
    const deleteBySessionId = vi.fn(() => { persisted = null; });
    const repo: SessionRepo = {
      upsert: vi.fn(async (_space, _user, _source, _session, state) => {
        persisted = state;
        return true;
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
      putBinding: vi.fn(async () => true),
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
    expect(deleteBySessionId).not.toHaveBeenCalled();
    expect(getBinding).toHaveBeenCalledTimes(1);
  });

  it("does not bind a rejected L2a identity and allows the valid caller", async () => {
    const identity = victimIdentity();
    const rejectedIdentity = { ...identity, taskId: OUTSIDER.taskId };
    const key = sessionStoreKey(identity);
    const upsert = vi.fn(async () => true);
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
        return true;
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
      putBinding: vi.fn(async () => true),
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
    expect(deleteBySessionId).not.toHaveBeenCalled();
  });

  it("does not delete a newer L2a row written while binding recovery is in flight", async () => {
    const identity = victimIdentity();
    const key = sessionStoreKey(identity);
    const expired: SessionInitState = {
      ...victimState(),
      status: "pending_task_select",
      startedAt: 0,
    };
    const newer = victimState();
    let persisted: SessionInitState | null = expired;
    const deleteBySessionId = vi.fn(() => { persisted = null; });
    const repo: SessionRepo = {
      upsert: vi.fn(async (_space, _user, _source, _session, state) => {
        persisted = state;
        return true;
      }),
      getBySessionId: vi.fn(async () => persisted),
      deleteBySessionId,
      loadAllInitialized: async () => [],
    };
    let releaseBinding!: () => void;
    const bindingReleased = new Promise<void>((resolve) => { releaseBinding = resolve; });
    let signalBindingRead!: () => void;
    const bindingRead = new Promise<void>((resolve) => { signalBindingRead = resolve; });
    const bindingRepo: BindingRepo = {
      getBinding: vi.fn(async (): Promise<SessionBinding | null> => {
        signalBindingRead();
        await bindingReleased;
        return null;
      }),
      putBinding: vi.fn(async () => true),
      deleteBinding: vi.fn(async () => undefined),
      touchLastSeen: vi.fn(async () => undefined),
    };
    const store = new SessionStore(1, repo, bindingRepo);

    const recovery = store.getOrRecover(key, identity, {});
    await bindingRead;
    persisted = newer;
    releaseBinding();

    await expect(recovery).resolves.toBeUndefined();
    expect(deleteBySessionId).not.toHaveBeenCalled();
    expect(persisted).toEqual(newer);

    const observer = new SessionStore(1, repo, bindingRepo);
    await expect(observer.getOrRecover(key, identity, {})).resolves.toEqual(newer);
  });

  it("rechecks a newer identity and state installed while L2a recovery is in flight", async () => {
    let releaseRead!: () => void;
    const readReleased = new Promise<void>((resolve) => { releaseRead = resolve; });
    let signalRead!: () => void;
    const readStarted = new Promise<void>((resolve) => { signalRead = resolve; });
    const upsert = vi.fn(async () => true);
    const repo: SessionRepo = {
      upsert,
      getBySessionId: vi.fn(async () => {
        signalRead();
        await readReleased;
        return null;
      }),
      deleteBySessionId: vi.fn(() => undefined),
      loadAllInitialized: async () => [],
    };
    const identity = victimIdentity();
    const key = sessionStoreKey(identity);
    const mandatoryOnly: SessionIdentity = {
      userId: identity.userId,
      agentSource: identity.agentSource,
      sessionId: identity.sessionId,
      spaceId: identity.spaceId,
    };
    const expired: SessionInitState = {
      ...victimState(),
      status: "pending_task_select",
      startedAt: 0,
    };
    const newer = victimState();
    const store = new SessionStore(1, repo);
    await store.set(key, expired);

    const recovery = store.getOrRecover(key, mandatoryOnly, {});
    await readStarted;
    store.bind(key, identity);
    await store.set(key, newer);
    const writesAfterNewer = upsert.mock.calls.length;
    releaseRead();

    await expect(recovery).resolves.toEqual(newer);
    expect(store.getBoundIdentity(key)).toEqual(identity);
    expect(store.get(key)).toEqual(newer);
    expect(upsert).toHaveBeenCalledTimes(writesAfterNewer);
    await expect(store.getOrRecover(key, identity, {})).resolves.toEqual(newer);
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
    const hydratedRows: Array<{
      spaceId: string;
      userId: string;
      agentSource: string;
      sessionId: string;
      state: SessionInitState;
    }> = [];
    const repo: SessionRepo = {
      upsert: vi.fn(async () => true),
      getBySessionId: vi.fn(async () => null),
      deleteBySessionId,
      loadAllInitialized: async () => hydratedRows,
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
        team_id: liveIdentity.teamId!,
        agent_id: liveIdentity.agentId!,
        task_id: liveIdentity.taskId,
      },
      agentDetail: { id: liveIdentity.agentId!, name: "Live Agent" },
      taskDetail: { id: liveIdentity.taskId!, name: "Live Task" },
    };
    hydratedRows.push({
      spaceId: liveIdentity.spaceId!,
      userId: liveIdentity.userId,
      agentSource: liveIdentity.agentSource,
      sessionId: liveIdentity.sessionId,
      state: liveState,
    });
    await expect(store.hydrateFromDb()).resolves.toBe(1);
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

  it("promotes a successful durable set to a persisted raw owner", async () => {
    const firstIdentity = victimIdentity();
    const secondIdentity: FullSessionIdentity = {
      userId: OUTSIDER.userId,
      agentSource: VICTIM.source,
      sessionId: VICTIM.sessionId,
      spaceId: OUTSIDER.spaceId,
      teamId: OUTSIDER.teamId,
      agentId: OUTSIDER.agentId,
      taskId: OUTSIDER.taskId,
    };
    const secondState: SessionInitState = {
      ...victimState(),
      userId: secondIdentity.userId,
      sessionInfo: {
        ...victimState().sessionInfo!,
        user_id: secondIdentity.userId,
        space_id: secondIdentity.spaceId,
        team_id: secondIdentity.teamId!,
        agent_id: secondIdentity.agentId!,
        task_id: secondIdentity.taskId,
      },
      agentDetail: { id: secondIdentity.agentId!, name: "Second Agent" },
      taskDetail: { id: secondIdentity.taskId!, name: "Second Task" },
    };
    const upsert = vi.fn(async () => true);
    const repo: SessionRepo = {
      upsert,
      getBySessionId: vi.fn(async (_space, userId) => userId === secondIdentity.userId
        ? secondState
        : null),
      deleteBySessionId: vi.fn(() => undefined),
      loadAllInitialized: async () => [],
    };
    const store = new SessionStore(30 * 60 * 1_000, repo);
    const firstKey = sessionStoreKey(firstIdentity);
    const secondKey = sessionStoreKey(secondIdentity);

    store.bind(firstKey, firstIdentity);
    await store.set(firstKey, victimState());
    await expect(store.getOrRecover(secondKey, secondIdentity, {})).resolves.toEqual(secondState);

    expect(upsert).toHaveBeenCalledTimes(1);
    expect(store.getBoundIdentity(firstKey)).toEqual(firstIdentity);
    expect(store.getBoundIdentity(secondKey)).toEqual(secondIdentity);
    expect(store.get(firstKey)).toMatchObject({ userId: firstIdentity.userId });
    expect(store.get(secondKey)).toEqual(secondState);
  });

  it("does not promote a raw owner when its durable set fails", async () => {
    const firstIdentity = victimIdentity();
    const secondIdentity: FullSessionIdentity = {
      userId: OUTSIDER.userId,
      agentSource: VICTIM.source,
      sessionId: VICTIM.sessionId,
      spaceId: OUTSIDER.spaceId,
      teamId: OUTSIDER.teamId,
      agentId: OUTSIDER.agentId,
      taskId: OUTSIDER.taskId,
    };
    const secondState: SessionInitState = {
      ...victimState(),
      userId: secondIdentity.userId,
      sessionInfo: {
        ...victimState().sessionInfo!,
        user_id: secondIdentity.userId,
        space_id: secondIdentity.spaceId,
        team_id: secondIdentity.teamId!,
        agent_id: secondIdentity.agentId!,
        task_id: secondIdentity.taskId,
      },
      agentDetail: { id: secondIdentity.agentId!, name: "Second Agent" },
      taskDetail: { id: secondIdentity.taskId!, name: "Second Task" },
    };
    const repo: SessionRepo = {
      // A real backend reports a handled write failure without throwing.
      upsert: vi.fn(async () => false),
      getBySessionId: vi.fn(async (_space, userId) => userId === secondIdentity.userId
        ? secondState
        : null),
      deleteBySessionId: vi.fn(() => undefined),
      loadAllInitialized: async () => [],
    };
    const store = new SessionStore(30 * 60 * 1_000, repo);
    const firstKey = sessionStoreKey(firstIdentity);
    const secondKey = sessionStoreKey(secondIdentity);

    store.bind(firstKey, firstIdentity);
    await store.set(firstKey, victimState());

    await expect(store.getOrRecover(secondKey, secondIdentity, {}))
      .rejects.toMatchObject({ name: "SessionIdentityConflictError" });
    expect(store.getBoundIdentity(firstKey)).toEqual(firstIdentity);
    expect(store.getBoundIdentity(secondKey)).toBeUndefined();
    expect(store.get(firstKey)).toMatchObject({ userId: firstIdentity.userId });
    expect(store.get(secondKey)).toBeUndefined();
  });

  it("does not promote a raw owner when its binding write reports failure", async () => {
    const firstIdentity = victimIdentity();
    const secondIdentity: FullSessionIdentity = {
      userId: OUTSIDER.userId,
      agentSource: VICTIM.source,
      sessionId: VICTIM.sessionId,
      spaceId: OUTSIDER.spaceId,
      teamId: OUTSIDER.teamId,
      agentId: OUTSIDER.agentId,
      taskId: OUTSIDER.taskId,
    };
    const bindingRepo: BindingRepo = {
      getBinding: vi.fn(async (_space, userId): Promise<SessionBinding | null> => (
        userId === secondIdentity.userId
          ? {
              outcome: "initialized",
              userId: secondIdentity.userId,
              teamId: secondIdentity.teamId,
              agentId: secondIdentity.agentId,
              taskId: secondIdentity.taskId,
            }
          : null
      )),
      // A real backend reports a handled write failure without throwing.
      putBinding: vi.fn(async () => false),
      deleteBinding: vi.fn(async () => undefined),
      touchLastSeen: vi.fn(async () => undefined),
    };
    const store = new SessionStore(30 * 60 * 1_000, undefined, bindingRepo);
    const firstKey = sessionStoreKey(firstIdentity);
    const secondKey = sessionStoreKey(secondIdentity);

    store.bind(firstKey, firstIdentity);
    await store.set(firstKey, victimState());

    await expect(store.getOrRecover(secondKey, secondIdentity, {}))
      .rejects.toMatchObject({ name: "SessionIdentityConflictError" });
    expect(store.getBoundIdentity(firstKey)).toEqual(firstIdentity);
    expect(store.getBoundIdentity(secondKey)).toBeUndefined();
    expect(store.get(secondKey)).toBeUndefined();
  });

  it.each(["handled-failure", "no-session-repo", "no-metadata"] as const)(
    "does not treat a history-derived binding as durable without proof (%s)",
    async (durabilityCase) => {
    const firstIdentity: FullSessionIdentity = {
      userId: VICTIM.userId,
      agentSource: VICTIM.source,
      sessionId: VICTIM.sessionId,
      spaceId: VICTIM.spaceId,
      agentId: VICTIM.agentId,
    };
    const secondIdentity: FullSessionIdentity = {
      userId: OUTSIDER.userId,
      agentSource: firstIdentity.agentSource,
      sessionId: firstIdentity.sessionId,
      spaceId: OUTSIDER.spaceId,
      teamId: OUTSIDER.teamId,
      agentId: OUTSIDER.agentId,
      taskId: OUTSIDER.taskId,
    };
    const secondState: SessionInitState = {
      ...victimState(),
      userId: secondIdentity.userId,
      sessionInfo: {
        ...victimState().sessionInfo!,
        user_id: secondIdentity.userId,
        space_id: secondIdentity.spaceId,
        team_id: secondIdentity.teamId!,
        agent_id: secondIdentity.agentId!,
        task_id: secondIdentity.taskId,
      },
      agentDetail: { id: secondIdentity.agentId!, name: "Second Agent" },
      taskDetail: { id: secondIdentity.taskId!, name: "Second Task" },
    };
    const upsert = vi.fn(async () => false);
    const repo: SessionRepo | undefined = durabilityCase === "handled-failure"
      ? {
          upsert,
          getBySessionId: vi.fn(async (_space, userId) => userId === secondIdentity.userId
            ? secondState
            : null),
          deleteBySessionId: vi.fn(() => undefined),
          loadAllInitialized: async () => [],
        }
      : undefined;
    const bindingRepo: BindingRepo | undefined = durabilityCase !== "handled-failure"
      ? {
          getBinding: vi.fn(async (_space, userId): Promise<SessionBinding | null> => (
            userId === secondIdentity.userId
              ? {
                  outcome: "initialized",
                  userId: secondIdentity.userId,
                  teamId: secondIdentity.teamId,
                  agentId: secondIdentity.agentId,
                  taskId: secondIdentity.taskId,
                }
              : null
          )),
          putBinding: vi.fn(async () => true),
          deleteBinding: vi.fn(async () => undefined),
          touchLastSeen: vi.fn(async () => undefined),
        }
      : undefined;
    const store = new SessionStore(30 * 60 * 1_000, repo, bindingRepo);
    const firstKey = sessionStoreKey(firstIdentity);
    const secondKey = sessionStoreKey(secondIdentity);
    const metadataClient = {
      getAgent: vi.fn(async () => ({
        agent_id: firstIdentity.agentId!,
        name: "History Agent",
      })),
      getTask: vi.fn(async () => null),
    };

    await expect(store.getOrRecover(firstKey, firstIdentity, {
      metadataClient: durabilityCase === "no-metadata" ? undefined : metadataClient as never,
      messages: [
        { role: "user", content: "first turn" },
        {
          role: "assistant",
          content: [{
            type: "tool_use",
            id: "toolu_cc_session_init_history",
            name: "AskUserQuestion",
            input: {
              question: "Select Agent",
              options: [`History Agent (${firstIdentity.agentId})`],
            },
          }],
        },
        { role: "user", content: "selected" },
      ],
    })).resolves.toMatchObject(durabilityCase === "no-metadata"
      ? { bypassed: true, sessionInfo: null }
      : {
          sessionInfo: { agent_id: firstIdentity.agentId },
          agentDetail: { id: firstIdentity.agentId },
        });
    expect(upsert).toHaveBeenCalledTimes(durabilityCase === "handled-failure" ? 1 : 0);

    await expect(store.getOrRecover(secondKey, secondIdentity, {}))
      .rejects.toMatchObject({ name: "SessionIdentityConflictError" });
    expect(store.getBoundIdentity(firstKey)).toMatchObject(firstIdentity);
    expect(store.getBoundIdentity(secondKey)).toBeUndefined();
    expect(store.get(secondKey)).toBeUndefined();
    },
  );

  it("keeps a newer same-identity state installed while metadata recovery waits", async () => {
    let signalMetadata!: () => void;
    let releaseMetadata!: () => void;
    const metadataStarted = new Promise<void>((resolve) => { signalMetadata = resolve; });
    const metadataReleased = new Promise<void>((resolve) => { releaseMetadata = resolve; });
    const identity = victimIdentity();
    const key = sessionStoreKey(identity);
    const touchLastSeen = vi.fn(async () => undefined);
    const putBinding = vi.fn(async () => true);
    const bindingRepo: BindingRepo = {
      getBinding: vi.fn(async (): Promise<SessionBinding> => ({
        outcome: "initialized",
        userId: identity.userId,
        teamId: identity.teamId,
        agentId: identity.agentId,
        taskId: identity.taskId,
      })),
      putBinding,
      deleteBinding: vi.fn(async () => undefined),
      touchLastSeen,
    };
    const metadataClient = {
      getAgent: vi.fn(async () => {
        signalMetadata();
        await metadataReleased;
        return { agent_id: identity.agentId!, name: "Recovered Agent" };
      }),
      getTask: vi.fn(async () => ({ task_id: identity.taskId!, title: "Recovered Task" })),
    };
    const store = new SessionStore(30 * 60 * 1_000, undefined, bindingRepo);

    const recovery = store.getOrRecover(key, identity, { metadataClient: metadataClient as never });
    await metadataStarted;
    const newerState: SessionInitState = {
      ...victimState(),
      agentDetail: { id: identity.agentId!, name: "Newer Agent" },
      taskDetail: { id: identity.taskId!, name: "Newer Task" },
    };
    await store.set(key, newerState);
    const installed = store.get(key);
    vi.clearAllMocks();
    releaseMetadata();

    await expect(recovery).resolves.toBe(installed);
    expect(store.get(key)).toBe(installed);
    expect(store.getBoundIdentity(key)).toEqual(identity);
    expect(touchLastSeen).not.toHaveBeenCalled();
    expect(putBinding).not.toHaveBeenCalled();
  });

  it("preserves a missing agent identity across L1 and restart recovery", async () => {
    const identity = victimIdentity();
    const key = sessionStoreKey(identity);
    let persistedBinding: SessionBinding | null = {
      outcome: "initialized",
      userId: identity.userId,
      teamId: identity.teamId,
      agentId: identity.agentId,
      taskId: identity.taskId,
    };
    const putBinding = vi.fn(async (_space, _user, _source, _session, binding: SessionBinding) => {
      persistedBinding = binding;
      return true;
    });
    const deleteBinding = vi.fn(async () => { persistedBinding = null; });
    const bindingRepo: BindingRepo = {
      getBinding: vi.fn(async () => persistedBinding),
      putBinding,
      deleteBinding,
      touchLastSeen: vi.fn(async () => undefined),
    };
    const metadataClient = {
      getAgent: vi.fn(async () => { throw { notFound: true }; }),
      getTask: vi.fn(async () => ({ task_id: identity.taskId!, title: "Recovered Task" })),
    };
    const store = new SessionStore(30 * 60 * 1_000, undefined, bindingRepo);

    const first = await store.getOrRecover(key, identity, {
      metadataClient: metadataClient as never,
    });
    expect(first).toMatchObject({
      contextSuppressed: true,
      sessionInfo: { agent_id: identity.agentId, task_id: identity.taskId },
      agentDetail: null,
    });
    await expect(store.getOrRecover(key, identity, {})).resolves.toBe(first);
    expect(deleteBinding).not.toHaveBeenCalled();
    expect(putBinding).not.toHaveBeenCalled();
    expect(() => store.bind(key, { ...identity, agentId: OUTSIDER.agentId }))
      .toThrowError(expect.objectContaining({ name: "SessionIdentityConflictError" }));

    const restarted = new SessionStore(30 * 60 * 1_000, undefined, bindingRepo);
    await expect(restarted.getOrRecover(key, identity, {
      metadataClient: metadataClient as never,
    })).resolves.toMatchObject({
      contextSuppressed: true,
      sessionInfo: { agent_id: identity.agentId, task_id: identity.taskId },
      agentDetail: null,
    });
  });

  it.each(["not-found", "null"] as const)(
    "preserves a missing task identity across L1 and restart recovery (%s)",
    async (taskResult) => {
      const identity = victimIdentity();
      const key = sessionStoreKey(identity);
      let persistedBinding: SessionBinding = {
        outcome: "initialized",
        userId: identity.userId,
        teamId: identity.teamId,
        agentId: identity.agentId,
        taskId: identity.taskId,
      };
      const putBinding = vi.fn(async (_space, _user, _source, _session, binding: SessionBinding) => {
        persistedBinding = binding;
        return true;
      });
      const bindingRepo: BindingRepo = {
        getBinding: vi.fn(async () => persistedBinding),
        putBinding,
        deleteBinding: vi.fn(async () => undefined),
        touchLastSeen: vi.fn(async () => undefined),
      };
      const metadataClient = {
        getAgent: vi.fn(async () => ({ agent_id: identity.agentId!, name: "Recovered Agent" })),
        getTask: vi.fn(async () => {
          if (taskResult === "not-found") throw { notFound: true };
          return null;
        }),
      };
      const store = new SessionStore(30 * 60 * 1_000, undefined, bindingRepo);

      const first = await store.getOrRecover(key, identity, {
        metadataClient: metadataClient as never,
      });
      expect(first).toMatchObject({
        contextSuppressed: true,
        sessionInfo: { agent_id: identity.agentId, task_id: identity.taskId },
        agentDetail: { id: identity.agentId },
        taskDetail: null,
      });
      await expect(store.getOrRecover(key, identity, {})).resolves.toBe(first);
      expect(putBinding).not.toHaveBeenCalled();
      expect(() => store.bind(key, { ...identity, taskId: OUTSIDER.taskId }))
        .toThrowError(expect.objectContaining({ name: "SessionIdentityConflictError" }));

      const restarted = new SessionStore(30 * 60 * 1_000, undefined, bindingRepo);
      await expect(restarted.getOrRecover(key, identity, {
        metadataClient: metadataClient as never,
      })).resolves.toMatchObject({
        contextSuppressed: true,
        sessionInfo: { agent_id: identity.agentId, task_id: identity.taskId },
        taskDetail: null,
      });
    },
  );

  it.each(["agent-missing", "task-missing"] as const)(
    "prioritizes authoritative %s over a concurrent metadata error",
    async (missingSide) => {
      const identity = victimIdentity();
      const key = sessionStoreKey(identity);
      const bindingRepo: BindingRepo = {
        getBinding: vi.fn(async (): Promise<SessionBinding> => ({
          outcome: "initialized",
          userId: identity.userId,
          teamId: identity.teamId,
          agentId: identity.agentId,
          taskId: identity.taskId,
        })),
        putBinding: vi.fn(async () => true),
        deleteBinding: vi.fn(async () => undefined),
        touchLastSeen: vi.fn(async () => undefined),
      };
      const metadataClient = {
        getAgent: vi.fn(async () => {
          if (missingSide === "agent-missing") return null;
          throw new Error("metadata transient sentinel");
        }),
        getTask: vi.fn(async () => {
          if (missingSide === "task-missing") return null;
          throw new Error("metadata transient sentinel");
        }),
      };
      const store = new SessionStore(30 * 60 * 1_000, undefined, bindingRepo);

      const first = await store.getOrRecover(key, identity, {
        metadataClient: metadataClient as never,
      });
      expect(first).toMatchObject({
        status: "initialized",
        bypassed: false,
        contextSuppressed: true,
        sessionInfo: { agent_id: identity.agentId, task_id: identity.taskId },
      });
      await expect(store.getOrRecover(key, identity, {})).resolves.toBe(first);

      const restarted = new SessionStore(30 * 60 * 1_000, undefined, bindingRepo);
      await expect(restarted.getOrRecover(key, identity, {
        metadataClient: metadataClient as never,
      })).resolves.toMatchObject({
        status: "initialized",
        bypassed: false,
        contextSuppressed: true,
        sessionInfo: { agent_id: identity.agentId, task_id: identity.taskId },
      });
    },
  );

  it("retains the one-shot bypass when both metadata lookups fail transiently", async () => {
    const identity = victimIdentity();
    const key = sessionStoreKey(identity);
    const bindingRepo: BindingRepo = {
      getBinding: vi.fn(async (): Promise<SessionBinding> => ({
        outcome: "initialized",
        userId: identity.userId,
        teamId: identity.teamId,
        agentId: identity.agentId,
        taskId: identity.taskId,
      })),
      putBinding: vi.fn(async () => true),
      deleteBinding: vi.fn(async () => undefined),
      touchLastSeen: vi.fn(async () => undefined),
    };
    const metadataClient = {
      getAgent: vi.fn(async () => { throw new Error("metadata transient sentinel"); }),
      getTask: vi.fn(async () => { throw new Error("metadata transient sentinel"); }),
    };
    const store = new SessionStore(30 * 60 * 1_000, undefined, bindingRepo);

    await expect(store.getOrRecover(key, identity, {
      metadataClient: metadataClient as never,
    })).resolves.toMatchObject({
      status: "initialized",
      bypassed: true,
      sessionInfo: null,
    });
    expect(store.get(key)).toBeUndefined();
  });

  it("serializes concurrent set persistence so the latest L1 state wins L2", async () => {
    let signalOldWrite!: () => void;
    let releaseOldWrite!: () => void;
    const oldWriteStarted = new Promise<void>((resolve) => { signalOldWrite = resolve; });
    const oldWriteReleased = new Promise<void>((resolve) => { releaseOldWrite = resolve; });
    const identity = victimIdentity();
    const key = sessionStoreKey(identity);
    const oldState: SessionInitState = {
      ...victimState(),
      agentDetail: { id: identity.agentId!, name: "Old Agent" },
    };
    const newerState: SessionInitState = {
      ...victimState(),
      agentDetail: { id: identity.agentId!, name: "Newer Agent" },
    };
    const durable = { state: null as SessionInitState | null };
    const repo: SessionRepo = {
      upsert: vi.fn(async (_space, _user, _source, _session, state) => {
        if (state.agentDetail?.name === "Old Agent") {
          signalOldWrite();
          await oldWriteReleased;
        }
        durable.state = state;
        return true;
      }),
      getBySessionId: vi.fn(async () => durable.state),
      deleteBySessionId: vi.fn(() => undefined),
      loadAllInitialized: async () => [],
    };
    const store = new SessionStore(30 * 60 * 1_000, repo);
    store.bind(key, identity);

    const oldWrite = store.set(key, oldState);
    await oldWriteStarted;
    const newerWrite = store.set(key, newerState);
    await Promise.resolve();
    expect(store.get(key)?.agentDetail?.name).toBe("Newer Agent");
    releaseOldWrite();
    await Promise.all([oldWrite, newerWrite]);

    expect(store.get(key)?.agentDetail?.name).toBe("Newer Agent");
    expect(durable.state?.agentDetail?.name).toBe("Newer Agent");
  });

  it("serializes an asynchronous delete before a later write to the same identity", async () => {
    let signalDelete!: () => void;
    let releaseDelete!: () => void;
    let signalDeleteFinished!: () => void;
    const deleteStarted = new Promise<void>((resolve) => { signalDelete = resolve; });
    const deleteReleased = new Promise<void>((resolve) => { releaseDelete = resolve; });
    const deleteFinished = new Promise<void>((resolve) => { signalDeleteFinished = resolve; });
    const identity = victimIdentity();
    const key = sessionStoreKey(identity);
    const newerState: SessionInitState = {
      ...victimState(),
      agentDetail: { id: identity.agentId!, name: "Newer Agent" },
    };
    const durable = { state: null as SessionInitState | null };
    const upsert = vi.fn(async (_space, _user, _source, _session, state) => {
      durable.state = state;
      return true;
    });
    const repo: SessionRepo = {
      upsert,
      getBySessionId: vi.fn(async () => durable.state),
      deleteBySessionId: vi.fn(async () => {
        signalDelete();
        await deleteReleased;
        durable.state = null;
        signalDeleteFinished();
      }),
      loadAllInitialized: async () => [],
    };
    const deleteBinding = vi.fn(async () => undefined);
    const bindingRepo: BindingRepo = {
      getBinding: vi.fn(async () => null),
      putBinding: vi.fn(async () => true),
      deleteBinding,
      touchLastSeen: vi.fn(async () => undefined),
    };
    const store = new SessionStore(30 * 60 * 1_000, repo, bindingRepo);
    store.bind(key, identity);
    await store.set(key, victimState());

    store.delete(key);
    await deleteStarted;
    const newerWrite = store.set(key, newerState);

    expect(upsert).toHaveBeenCalledTimes(1);
    expect(deleteBinding).not.toHaveBeenCalled();
    releaseDelete();
    await deleteFinished;
    await newerWrite;
    expect(deleteBinding).toHaveBeenCalledTimes(1);
    expect(durable.state?.agentDetail?.name).toBe("Newer Agent");
  });

  it("does not restore a raw owner after delete overtakes an in-flight set", async () => {
    let signalWrite!: () => void;
    let releaseWrite!: () => void;
    let signalDeleteFinished!: () => void;
    const writeStarted = new Promise<void>((resolve) => { signalWrite = resolve; });
    const writeReleased = new Promise<void>((resolve) => { releaseWrite = resolve; });
    const deleteFinished = new Promise<void>((resolve) => { signalDeleteFinished = resolve; });
    const firstIdentity = victimIdentity();
    const secondIdentity: FullSessionIdentity = {
      userId: OUTSIDER.userId,
      agentSource: firstIdentity.agentSource,
      sessionId: firstIdentity.sessionId,
      spaceId: OUTSIDER.spaceId,
      teamId: OUTSIDER.teamId,
      agentId: OUTSIDER.agentId,
      taskId: OUTSIDER.taskId,
    };
    const repo: SessionRepo = {
      upsert: vi.fn(async () => {
        signalWrite();
        await writeReleased;
        return true;
      }),
      getBySessionId: vi.fn(async () => null),
      deleteBySessionId: vi.fn(async () => { signalDeleteFinished(); }),
      loadAllInitialized: async () => [],
    };
    const store = new SessionStore(30 * 60 * 1_000, repo);
    const firstKey = sessionStoreKey(firstIdentity);
    const secondKey = sessionStoreKey(secondIdentity);
    store.bind(firstKey, firstIdentity);

    const write = store.set(firstKey, victimState());
    await writeStarted;
    store.delete(firstKey);
    expect(store.get(firstKey)).toBeUndefined();
    releaseWrite();
    await write;
    await deleteFinished;

    await expect(store.getOrRecover(secondKey, secondIdentity, {})).resolves.toBeUndefined();
    expect(store.getBoundIdentity(secondKey)).toEqual(secondIdentity);
    expect(store.get(secondKey)).toBeUndefined();
  });

  it.each(["before-wait", "after-wait"] as const)(
    "keeps the latest state durable when stale rebuild persistence completes %s",
    async (oldWriteOrder) => {
      let signalOldWrite!: () => void;
      let releaseOldWrite!: () => void;
      const oldWriteStarted = new Promise<void>((resolve) => { signalOldWrite = resolve; });
      const oldWriteReleased = new Promise<void>((resolve) => { releaseOldWrite = resolve; });
      const identity = victimIdentity();
      const key = sessionStoreKey(identity);
      const newerState: SessionInitState = {
        ...victimState(),
        agentDetail: { id: identity.agentId!, name: "Newer Agent" },
        taskDetail: { id: identity.taskId!, name: "Newer Task" },
      };
      const durable = { state: null as SessionInitState | null };
      const repo: SessionRepo = {
        upsert: vi.fn(async (_space, _user, _source, _session, state) => {
          const staleRebuild = state.agentDetail?.name === "Recovered Agent";
          if (staleRebuild && oldWriteOrder === "before-wait") durable.state = state;
          if (staleRebuild) {
            signalOldWrite();
            await oldWriteReleased;
          }
          if (!staleRebuild || oldWriteOrder === "after-wait") durable.state = state;
          return true;
        }),
        getBySessionId: vi.fn(async () => null),
        deleteBySessionId: vi.fn(() => undefined),
        loadAllInitialized: async () => [],
      };
      const bindingRepo: BindingRepo = {
        getBinding: vi.fn(async (): Promise<SessionBinding> => ({
          outcome: "initialized",
          userId: identity.userId,
          teamId: identity.teamId,
          agentId: identity.agentId,
          taskId: identity.taskId,
        })),
        putBinding: vi.fn(async () => true),
        deleteBinding: vi.fn(async () => undefined),
        touchLastSeen: vi.fn(async () => undefined),
      };
      const metadataClient = {
        getAgent: vi.fn(async () => ({ agent_id: identity.agentId!, name: "Recovered Agent" })),
        getTask: vi.fn(async () => ({ task_id: identity.taskId!, title: "Recovered Task" })),
      };
      const store = new SessionStore(30 * 60 * 1_000, repo, bindingRepo);

      const recovery = store.getOrRecover(key, identity, { metadataClient: metadataClient as never });
      await oldWriteStarted;
      const newerWrite = store.set(key, newerState);
      await Promise.resolve();
      const installed = store.get(key);
      releaseOldWrite();

      await expect(recovery).resolves.toBe(installed);
      await newerWrite;
      expect(store.get(key)).toBe(installed);
      expect(durable.state?.agentDetail?.name).toBe("Newer Agent");
      expect(durable.state?.taskDetail?.name).toBe("Newer Task");
    },
  );

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
      putBinding: async () => true,
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
    expect(store.getBoundIdentity(sessionStoreKey(victimIdentity()))).toEqual(victimIdentity());
    expect(store.getBoundIdentity(sessionStoreKey(outsiderIdentity))).toEqual(outsiderIdentity);
  });

  it("reserves a raw session for the first concurrent identity with no persisted owner", async () => {
    const firstIdentity = victimIdentity();
    const secondIdentity: FullSessionIdentity = {
      userId: OUTSIDER.userId,
      agentSource: VICTIM.source,
      sessionId: VICTIM.sessionId,
      spaceId: OUTSIDER.spaceId,
      teamId: OUTSIDER.teamId,
      agentId: OUTSIDER.agentId,
      taskId: OUTSIDER.taskId,
    };
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    let signalFirst!: () => void;
    let signalSecond!: () => void;
    const firstReleased = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const secondReleased = new Promise<void>((resolve) => { releaseSecond = resolve; });
    const firstStarted = new Promise<void>((resolve) => { signalFirst = resolve; });
    const secondStarted = new Promise<void>((resolve) => { signalSecond = resolve; });
    const touchLastSeen = vi.fn(async () => undefined);
    const putBinding = vi.fn(async () => true);
    const bindingRepo: BindingRepo = {
      getBinding: vi.fn(async (_space, userId) => {
        if (userId === firstIdentity.userId) {
          signalFirst();
          await firstReleased;
        } else {
          signalSecond();
          await secondReleased;
        }
        return null;
      }),
      putBinding,
      deleteBinding: vi.fn(async () => undefined),
      touchLastSeen,
    };
    const store = new SessionStore(30 * 60 * 1_000, undefined, bindingRepo);
    const firstKey = sessionStoreKey(firstIdentity);
    const secondKey = sessionStoreKey(secondIdentity);

    const first = store.getOrRecover(firstKey, firstIdentity, {});
    await firstStarted;
    const second = store.getOrRecover(secondKey, secondIdentity, {});
    await secondStarted;
    releaseFirst();
    await expect(first).resolves.toBeUndefined();
    releaseSecond();

    await expect(second).rejects.toMatchObject({ name: "SessionIdentityConflictError" });
    expect(store.getBoundIdentity(firstKey)).toEqual(firstIdentity);
    expect(store.getBoundIdentity(secondKey)).toBeUndefined();
    expect(store.get(firstKey)).toBeUndefined();
    expect(store.get(secondKey)).toBeUndefined();
    expect(touchLastSeen).not.toHaveBeenCalled();
    expect(putBinding).not.toHaveBeenCalled();
  });

  it("allows concurrent cold recovery for the same unpersisted identity", async () => {
    const identity = victimIdentity();
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    let signalFirst!: () => void;
    let signalSecond!: () => void;
    const firstReleased = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const secondReleased = new Promise<void>((resolve) => { releaseSecond = resolve; });
    const firstStarted = new Promise<void>((resolve) => { signalFirst = resolve; });
    const secondStarted = new Promise<void>((resolve) => { signalSecond = resolve; });
    let bindingRead = 0;
    const touchLastSeen = vi.fn(async () => undefined);
    const putBinding = vi.fn(async () => true);
    const bindingRepo: BindingRepo = {
      getBinding: vi.fn(async (): Promise<SessionBinding | null> => {
        const current = bindingRead++;
        if (current === 0) {
          signalFirst();
          await firstReleased;
        } else {
          signalSecond();
          await secondReleased;
        }
        return null;
      }),
      putBinding,
      deleteBinding: vi.fn(async () => undefined),
      touchLastSeen,
    };
    const store = new SessionStore(30 * 60 * 1_000, undefined, bindingRepo);
    const key = sessionStoreKey(identity);

    const first = store.getOrRecover(key, identity, {});
    await firstStarted;
    const second = store.getOrRecover(key, identity, {});
    await secondStarted;
    releaseFirst();
    await expect(first).resolves.toBeUndefined();
    releaseSecond();
    await expect(second).resolves.toBeUndefined();

    expect(store.getBoundIdentity(key)).toEqual(identity);
    expect(store.get(key)).toBeUndefined();
    expect(touchLastSeen).not.toHaveBeenCalled();
    expect(putBinding).not.toHaveBeenCalled();
  });

  it("rejects a mismatched bypass binding before touch or cache write", async () => {
    const touchLastSeen = vi.fn(async () => undefined);
    const putBinding = vi.fn(async () => true);
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
    const putBinding = vi.fn(async () => true);
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
    expect(putBinding).toHaveBeenCalledTimes(1);
    expect(putBinding).toHaveBeenCalledWith(
      VICTIM.spaceId,
      VICTIM.userId,
      VICTIM.source,
      VICTIM.sessionId,
      expect.objectContaining({ outcome: "bypassed", userId: VICTIM.userId }),
    );
    expect(store.getBoundIdentity(key)).toEqual(identity);
    expect(store.get(key)).toMatchObject({ bypassed: true, userId: VICTIM.userId });
  });

  it("allows only the first conflicting optional claim after a shared legacy bypass read", async () => {
    const firstIdentity = victimIdentity();
    const secondIdentity: FullSessionIdentity = {
      ...firstIdentity,
      teamId: OUTSIDER.teamId,
      agentId: OUTSIDER.agentId,
      taskId: OUTSIDER.taskId,
    };
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    let signalFirst!: () => void;
    let signalSecond!: () => void;
    const firstReleased = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const secondReleased = new Promise<void>((resolve) => { releaseSecond = resolve; });
    const firstStarted = new Promise<void>((resolve) => { signalFirst = resolve; });
    const secondStarted = new Promise<void>((resolve) => { signalSecond = resolve; });
    let bindingRead = 0;
    const upsert = vi.fn(async () => true);
    const touchLastSeen = vi.fn(async () => undefined);
    const putBinding = vi.fn(async () => true);
    const repo: SessionRepo = {
      upsert,
      getBySessionId: vi.fn(async () => null),
      deleteBySessionId: vi.fn(() => undefined),
      loadAllInitialized: async () => [],
    };
    const bindingRepo: BindingRepo = {
      getBinding: vi.fn(async (): Promise<SessionBinding | null> => {
        const current = bindingRead++;
        if (current === 0) {
          signalFirst();
          await firstReleased;
        } else {
          signalSecond();
          await secondReleased;
        }
        return { outcome: "bypassed" };
      }),
      putBinding,
      deleteBinding: vi.fn(async () => undefined),
      touchLastSeen,
    };
    const store = new SessionStore(30 * 60 * 1_000, repo, bindingRepo);
    const key = sessionStoreKey(firstIdentity);

    const first = store.getOrRecover(key, firstIdentity, {});
    await firstStarted;
    const second = store.getOrRecover(key, secondIdentity, {});
    await secondStarted;
    releaseFirst();
    await expect(first).resolves.toMatchObject({ bypassed: true, userId: VICTIM.userId });
    const stateAfterFirst = store.get(key);
    const sideEffectsAfterFirst = {
      upsert: upsert.mock.calls.length,
      touch: touchLastSeen.mock.calls.length,
      binding: putBinding.mock.calls.length,
    };
    releaseSecond();

    await expect(second).rejects.toMatchObject({ name: "SessionIdentityConflictError" });
    expect(store.getBoundIdentity(key)).toEqual(firstIdentity);
    expect(store.get(key)).toBe(stateAfterFirst);
    expect(upsert).toHaveBeenCalledTimes(sideEffectsAfterFirst.upsert);
    expect(touchLastSeen).toHaveBeenCalledTimes(sideEffectsAfterFirst.touch);
    expect(putBinding).toHaveBeenCalledTimes(sideEffectsAfterFirst.binding);
    await expect(store.getOrRecover(key, firstIdentity, {})).resolves.toBe(stateAfterFirst);
  });

  it("recovers a legacy bypass state from L2a after restart", async () => {
    let persistedState: SessionInitState | null = null;
    const repo: SessionRepo = {
      upsert: async (_spaceId, _userId, _source, _sessionId, state) => {
        persistedState = state;
        return true;
      },
      getBySessionId: async () => persistedState,
      deleteBySessionId: () => undefined,
      loadAllInitialized: async () => [],
    };
    const bindingRepo: BindingRepo = {
      getBinding: async () => ({ outcome: "bypassed" }),
      putBinding: async () => true,
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
    expect(restartedStore.getBoundIdentity(key)).toEqual(identity);
    expect(restartedStore.get(key)).toMatchObject({ bypassed: true, userId: VICTIM.userId });
  });

  it.each([
    ["memory", "/memory-bridge/v3/scenario/read"],
    ["skill", "/skill-bridge/v3/skill/list"],
  ] as const)("rejects a context-suppressed %s bridge session before Core", async (_bridge, path) => {
    const config = configForTest();
    const fetchCategories: string[] = [];
    const upstreamBodies: Record<string, unknown>[] = [];
    initAuth(config.auth);
    vi.stubGlobal("fetch", fetchStub(fetchCategories, upstreamBodies));
    const identity = victimIdentity();
    const key = sessionStoreKey(identity);
    const store = getSessionStore();
    store.bind(key, identity);
    await store.set(key, {
      ...victimState(),
      contextSuppressed: true,
    } as SessionInitState);
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

    expect(response.status).toBe(401);
    expect(fetchCategories).toEqual(["auth"]);
    expect(upstreamBodies).toHaveLength(0);
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
      putBinding: async () => true,
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
    ["memory", "codebuddy", "/memory-bridge/v3/scenario/read"],
    ["memory", "hermes", "/memory-bridge/v3/scenario/read"],
    ["memory", "openclaw", "/memory-bridge/v3/scenario/read"],
    ["memory", "openai", "/memory-bridge/v3/scenario/read"],
    ["skill", "codebuddy", "/skill-bridge/v3/skill/list"],
    ["skill", "hermes", "/skill-bridge/v3/skill/list"],
    ["skill", "openclaw", "/skill-bridge/v3/skill/list"],
    ["skill", "openai", "/skill-bridge/v3/skill/list"],
  ] as const)(
    "accepts the registered %s bridge source %s",
    async (_bridge, source, path) => {
      const config = configForTest();
      const fetchCategories: string[] = [];
      const upstreamBodies: Record<string, unknown>[] = [];
      initAuth(config.auth);
      vi.stubGlobal("fetch", fetchStub(fetchCategories, upstreamBodies));
      await seedVictimSessionForSource(source);
      const app = createApp(config);

      const response = await app.request(`http://proxy${path}`, {
        method: "POST",
        headers: {
          "authorization": `Bearer ${VICTIM.key}`,
          "content-type": "application/json",
          "x-conversation-id": VICTIM.sessionId,
          "x-tdai-service-id": VICTIM.spaceId,
          "x-tdai-agent-source": source,
        },
        body: "{}",
      });
      await response.text();

      expect(response.status).toBe(200);
      expect(fetchCategories[0]).toBe("auth");
      expect(fetchCategories.slice(1).length).toBeGreaterThan(0);
      expect(fetchCategories.slice(1).every((category) => category === "core-bridge")).toBe(true);
      expect(upstreamBodies).toHaveLength(0);
    },
  );

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

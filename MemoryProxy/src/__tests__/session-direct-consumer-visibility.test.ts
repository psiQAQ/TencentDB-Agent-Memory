import { beforeEach, describe, expect, it, vi } from "vitest";

import { initAuth } from "../auth.js";
import { DEFAULT_CONFIG } from "../config.js";
import type { BindingRepo, SessionBinding } from "../db/binding-repo.js";
import type { SessionRepo } from "../db/sessionRepo.js";
import { refreshSessionCache } from "../routes/session-refresh.js";
import { forceArchiveSkill } from "../routes/session-force-archive.js";
import { createApp } from "../server.js";
import {
  SessionStore,
  sessionStoreKey,
  type SessionIdentity,
} from "../session/store.js";
import type { SessionInitState } from "../session/types.js";
import type { ProxyConfig } from "../types.js";

const mocks = vi.hoisted(() => ({
  prewarmFromConfig: vi.fn(async () => ({ cachedHookIds: [], skipped: [] })),
  forceArchive: vi.fn(async () => ({ status: "empty" as const })),
  getAgent: vi.fn(),
  getTask: vi.fn(),
  recordTdaiTurn: vi.fn(async () => undefined),
  triggerSkillExtractIfReady: vi.fn(async () => undefined),
}));

let activeStore: SessionStore;

vi.mock("../session/store.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../session/store.js")>();
  return {
    ...original,
    getSessionStore: () => activeStore,
  };
});

vi.mock("../injection/index.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../injection/index.js")>();
  return {
    ...original,
    prewarmFromConfig: mocks.prewarmFromConfig,
  };
});

vi.mock("../skill/core-client.js", () => ({
  getCoreSkillClient: () => ({ forceArchive: mocks.forceArchive }),
}));

vi.mock("../meta/client.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../meta/client.js")>();
  return {
    ...original,
    getMetadataClient: () => ({ getAgent: mocks.getAgent, getTask: mocks.getTask }),
  };
});

vi.mock("../tdai/recorder.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../tdai/recorder.js")>();
  return { ...original, recordTdaiTurn: mocks.recordTdaiTurn };
});

vi.mock("../skill/handler-glue.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../skill/handler-glue.js")>();
  return { ...original, triggerSkillExtractIfReady: mocks.triggerSkillExtractIfReady };
});

const IDENTITY: SessionIdentity = {
  userId: "visibility-user",
  spaceId: "visibility-space",
  agentSource: "claude-code",
  sessionId: "visibility-session",
  teamId: "visibility-team",
  agentId: "visibility-agent",
  taskId: "visibility-task",
};

function initializedState(description: string): SessionInitState {
  return {
    status: "initialized",
    keyId: IDENTITY.sessionId,
    startedAt: Date.now(),
    attemptCount: 0,
    userId: IDENTITY.userId,
    sessionInfo: {
      session_id: IDENTITY.sessionId,
      user_id: IDENTITY.userId,
      space_id: IDENTITY.spaceId,
      team_id: IDENTITY.teamId!,
      agent_id: IDENTITY.agentId!,
      task_id: IDENTITY.taskId,
    },
    agentDetail: {
      id: IDENTITY.agentId!,
      name: "Visibility Agent",
      description,
    },
    taskDetail: { id: IDENTITY.taskId!, name: "Visibility Task" },
  };
}

describe("session direct-consumer authoritative visibility", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps settled initialized sessions visible to direct consumers", async () => {
    activeStore = new SessionStore();
    const key = sessionStoreKey(IDENTITY);
    const state = initializedState("settled-state");
    activeStore.bind(key, IDENTITY);
    await activeStore.set(key, state);

    const config = { coreSkill: {} } as ProxyConfig;
    const refresh = await refreshSessionCache({
      sessionKey: IDENTITY.sessionId,
      agentSource: IDENTITY.agentSource,
      userId: IDENTITY.userId,
      spaceId: IDENTITY.spaceId!,
      config,
    });
    const archive = await forceArchiveSkill({
      sessionKey: IDENTITY.sessionId,
      agentSource: IDENTITY.agentSource,
      userId: IDENTITY.userId,
      spaceId: IDENTITY.spaceId!,
      config,
    });

    expect.soft(activeStore.get(key)).toMatchObject(state);
    expect.soft(activeStore.getStatus(key)).toBe("initialized");
    expect.soft(refresh.success).toBe(true);
    expect.soft(archive.success).toBe(true);
    expect.soft(mocks.prewarmFromConfig).toHaveBeenCalledOnce();
    expect(mocks.forceArchive).toHaveBeenCalledOnce();
  });

  it.each(["false", "throw"] as const)(
    "hides a pending delete replacement from direct consumers before a %s rollback",
    async (failureKind) => {
      let signalDeleteStarted!: () => void;
      let releaseDelete!: () => void;
      let signalReplacementStarted!: () => void;
      let resolveReplacement!: (value: boolean) => void;
      let rejectReplacement!: (reason: Error) => void;
      const deleteStarted = new Promise<void>((resolve) => { signalDeleteStarted = resolve; });
      const deleteReleased = new Promise<void>((resolve) => { releaseDelete = resolve; });
      const replacementStarted = new Promise<void>((resolve) => {
        signalReplacementStarted = resolve;
      });
      const replacementResult = new Promise<boolean>((resolve, reject) => {
        resolveReplacement = resolve;
        rejectReplacement = reject;
      });
      let replacementPhase = false;
      const repo: SessionRepo = {
        upsert: vi.fn(async () => {
          if (!replacementPhase) return true;
          signalReplacementStarted();
          return replacementResult;
        }),
        getBySessionId: vi.fn(async () => null),
        deleteBySessionId: vi.fn(async () => {
          signalDeleteStarted();
          await deleteReleased;
          return false;
        }),
        loadAllInitialized: vi.fn(async () => []),
      };
      const binding: SessionBinding = {
        outcome: "initialized",
        userId: IDENTITY.userId,
        teamId: IDENTITY.teamId,
        agentId: IDENTITY.agentId,
        taskId: IDENTITY.taskId,
      };
      const bindingRepo: BindingRepo = {
        getBinding: vi.fn(async () => binding),
        putBinding: vi.fn(async () => true),
        deleteBinding: vi.fn(async () => true),
        touchLastSeen: vi.fn(async () => undefined),
      };
      activeStore = new SessionStore(30 * 60 * 1_000, repo, bindingRepo);
      const key = sessionStoreKey(IDENTITY);
      activeStore.bind(key, IDENTITY);
      await activeStore.set(key, initializedState("old-state"));

      activeStore.delete(key);
      await deleteStarted;
      replacementPhase = true;
      const replacementWrite = activeStore.set(key, initializedState("pending-state"));
      releaseDelete();
      await replacementStarted;

      const config = { coreSkill: {} } as ProxyConfig;
      const refresh = await refreshSessionCache({
        sessionKey: IDENTITY.sessionId,
        agentSource: IDENTITY.agentSource,
        userId: IDENTITY.userId,
        spaceId: IDENTITY.spaceId!,
        config,
      });
      const archive = await forceArchiveSkill({
        sessionKey: IDENTITY.sessionId,
        agentSource: IDENTITY.agentSource,
        userId: IDENTITY.userId,
        spaceId: IDENTITY.spaceId!,
        config,
      });

      expect.soft(activeStore.get(key)).toBeUndefined();
      expect.soft(activeStore.getStatus(key)).toBe("uninitialized");
      expect.soft(refresh.success).toBe(false);
      expect.soft(archive.success).toBe(false);
      expect.soft(mocks.prewarmFromConfig).not.toHaveBeenCalled();
      expect.soft(mocks.forceArchive).not.toHaveBeenCalled();

      if (failureKind === "throw") {
        rejectReplacement(new Error("replacement-write-detail"));
      } else {
        resolveReplacement(false);
      }
      await expect(replacementWrite)
        .rejects.toMatchObject({ name: "SessionIdentityConflictError" });

      expect(activeStore.get(key)).toBeUndefined();
      expect(activeStore.getStatus(key)).toBe("uninitialized");
      expect(mocks.prewarmFromConfig).not.toHaveBeenCalled();
      expect(mocks.forceArchive).not.toHaveBeenCalled();
    },
  );

  it("abandons refresh work when the settled state changes during metadata lookup", async () => {
    let signalMetadataStarted!: () => void;
    let releaseMetadata!: () => void;
    let signalDeleteStarted!: () => void;
    let releaseDelete!: () => void;
    let signalReplacementStarted!: () => void;
    let releaseReplacement!: (value: boolean) => void;
    const metadataStarted = new Promise<void>((resolve) => { signalMetadataStarted = resolve; });
    const metadataReleased = new Promise<void>((resolve) => { releaseMetadata = resolve; });
    const deleteStarted = new Promise<void>((resolve) => { signalDeleteStarted = resolve; });
    const deleteReleased = new Promise<void>((resolve) => { releaseDelete = resolve; });
    const replacementStarted = new Promise<void>((resolve) => {
      signalReplacementStarted = resolve;
    });
    const replacementReleased = new Promise<boolean>((resolve) => {
      releaseReplacement = resolve;
    });
    let replacementPhase = false;
    const repo: SessionRepo = {
      upsert: vi.fn(async () => {
        if (!replacementPhase) return true;
        signalReplacementStarted();
        return replacementReleased;
      }),
      getBySessionId: vi.fn(async () => null),
      deleteBySessionId: vi.fn(async () => {
        signalDeleteStarted();
        await deleteReleased;
        return false;
      }),
      loadAllInitialized: vi.fn(async () => []),
    };
    const bindingRepo: BindingRepo = {
      getBinding: vi.fn(async () => null),
      putBinding: vi.fn(async () => true),
      deleteBinding: vi.fn(async () => true),
      touchLastSeen: vi.fn(async () => undefined),
    };
    activeStore = new SessionStore(30 * 60 * 1_000, repo, bindingRepo);
    const key = sessionStoreKey(IDENTITY);
    activeStore.bind(key, IDENTITY);
    await activeStore.set(key, initializedState("old-state"));
    mocks.getAgent.mockImplementationOnce(async () => {
      signalMetadataStarted();
      await metadataReleased;
      return {
        agent_id: IDENTITY.agentId,
        name: "Refreshed Agent",
        description: "stale-refresh-detail",
      };
    });
    mocks.getTask.mockResolvedValueOnce({
      task_id: IDENTITY.taskId,
      title: "Refreshed Task",
      description: "stale-refresh-task",
    });
    const config = {
      coreSkill: { endpoint: "https://metadata.invalid" },
    } as ProxyConfig;
    const refresh = refreshSessionCache({
      sessionKey: IDENTITY.sessionId,
      agentSource: IDENTITY.agentSource,
      userId: IDENTITY.userId,
      spaceId: IDENTITY.spaceId!,
      callerUserKey: "request-local-test-reference",
      config,
    });
    await metadataStarted;

    activeStore.delete(key);
    await deleteStarted;
    replacementPhase = true;
    const replacementWrite = activeStore.set(key, initializedState("pending-state"));
    releaseDelete();
    await replacementStarted;
    let signalRefreshSet!: () => void;
    const refreshSetCalled = new Promise<void>((resolve) => { signalRefreshSet = resolve; });
    const originalSet = activeStore.set.bind(activeStore);
    const set = vi.spyOn(activeStore, "set").mockImplementation((...args) => {
      signalRefreshSet();
      return originalSet(...args);
    });
    releaseMetadata();
    await Promise.race([refresh.then(() => undefined), refreshSetCalled]);
    releaseReplacement(false);

    await expect.soft(replacementWrite)
      .rejects.toMatchObject({ name: "SessionIdentityConflictError" });
    const result = await refresh;
    expect.soft(result.success).toBe(false);
    expect.soft(set).not.toHaveBeenCalled();
    expect.soft(mocks.prewarmFromConfig).not.toHaveBeenCalled();
    expect(activeStore.get(key)).toBeUndefined();
    expect(activeStore.getStatus(key)).toBe("uninitialized");
  });

  it.each(["openai", "anthropic"] as const)(
    "skips %s mem-command extraction after an unsuccessful action",
    async (protocol) => {
      activeStore = new SessionStore();
      vi.spyOn(activeStore, "getOrRecover").mockResolvedValue(initializedState("mem-state"));
      const config = structuredClone(DEFAULT_CONFIG);
      config.memCommand = { enabled: true, allowedCommands: [] };
      config.sessionInit.enabled = true;
      config.injection.enabled = false;
      config.extraction = { enabled: true, extractors: ["tdai-memory", "skill"] };
      config.tdai.enabled = true;
      config.tdai.endpoint = "https://tdai.invalid";
      config.tdai.memory.enabled = true;
      config.tdai.memory.writeL0 = true;
      config.creditReport.url = "";
      config.log.backend = "noop";
      initAuth(config.auth);
      const app = createApp(config);
      const isOpenAI = protocol === "openai";
      const response = await app.request(
        isOpenAI
          ? "http://proxy/codebuddy/visibility-space/v1/chat/completions"
          : "http://proxy/claude-code/visibility-space/v1/messages",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(isOpenAI
              ? { authorization: "Bearer test-memory-reference" }
              : { "x-api-key": "test-memory-reference" }),
            "x-session-id": IDENTITY.sessionId,
          },
          body: JSON.stringify(isOpenAI
            ? {
                model: "test-model",
                messages: [{ role: "user", content: "mem:unknown" }],
              }
            : {
                model: "test-model",
                max_tokens: 16,
                messages: [{
                  role: "user",
                  content: [{ type: "text", text: "mem:unknown" }],
                }],
              }),
        },
      );

      expect(response.status).toBe(200);
      expect.soft(mocks.recordTdaiTurn).not.toHaveBeenCalled();
      expect.soft(mocks.triggerSkillExtractIfReady).not.toHaveBeenCalled();
    },
  );
});

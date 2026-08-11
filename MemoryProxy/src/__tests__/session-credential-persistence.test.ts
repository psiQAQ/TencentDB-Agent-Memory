import { describe, expect, it, vi } from "vitest";

import type { HydratedSessionRow, SessionRepo } from "../db/sessionRepo.js";
import { log } from "../report/log.js";
import { buildSessionInfo } from "../session/registrar.js";
import {
  SessionStore,
  sessionStoreKey,
  type SessionIdentity,
} from "../session/store.js";
import type { SessionInitState } from "../session/types.js";
import { checkAclOrDeny, type TdaiClient } from "../tdai/client.js";

const CREDENTIAL = "credential-must-remain-request-local";
const ERROR_DETAIL = "acl-error-detail-must-not-reach-diagnostics";

function identity(): SessionIdentity {
  return {
    spaceId: "space-a",
    userId: "user-a",
    agentSource: "claude-code",
    sessionId: "session-a",
  };
}

function legacyState(): SessionInitState {
  return {
    status: "initialized",
    keyId: "session-a",
    startedAt: 1,
    attemptCount: 0,
    userId: "user-a",
    bypassed: false,
    sessionInfo: {
      session_id: "session-a",
      team_id: "team-a",
      agent_id: "agent-a",
      user_id: "user-a",
      space_id: "space-a",
      user_key: CREDENTIAL,
    },
    agentDetail: { id: "agent-a", name: "Agent A" },
    taskDetail: null,
  };
}

function repo(overrides: Partial<SessionRepo> = {}): SessionRepo {
  return {
    upsert: vi.fn(async () => true),
    getBySessionId: vi.fn(async () => null),
    deleteBySessionId: vi.fn(async () => true),
    loadAllInitialized: vi.fn(async () => []),
    ...overrides,
  };
}

describe("session credential persistence", () => {
  it("does not put a caller credential in newly registered session state", () => {
    const info = buildSessionInfo({
      session_id: "session-a",
      team_id: "team-a",
      agent_id: "agent-a",
      user_id: "user-a",
    }, CREDENTIAL, "space-a");

    expect(info.user_key).toBeUndefined();
    expect(JSON.stringify(info)).not.toContain(CREDENTIAL);
  });

  it("strips a legacy credential before writing L1 or L2", async () => {
    const storage = repo();
    const store = new SessionStore(30_000, storage);
    const id = identity();
    const key = sessionStoreKey(id);
    store.bind(key, id);

    await store.set(key, legacyState());

    expect(JSON.stringify(store.get(key))).not.toContain(CREDENTIAL);
    const persisted = vi.mocked(storage.upsert).mock.calls[0]?.[4];
    expect(JSON.stringify(persisted)).not.toContain(CREDENTIAL);
  });

  it("sanitizes and lazily rewrites a legacy L2 credential", async () => {
    const storage = repo({
      getBySessionId: vi.fn(async () => legacyState()),
    });
    const id = identity();
    const key = sessionStoreKey(id);
    const store = new SessionStore(30_000, storage);

    const recovered = await store.getOrRecover(key, id, {});

    expect(JSON.stringify(recovered)).not.toContain(CREDENTIAL);
    expect(JSON.stringify(store.get(key))).not.toContain(CREDENTIAL);
    expect(storage.upsert).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(vi.mocked(storage.upsert).mock.calls[0]?.[4])).not.toContain(CREDENTIAL);
  });

  it("sanitizes and rewrites legacy credentials during startup hydration", async () => {
    const hydrated: HydratedSessionRow = {
      spaceId: "space-a",
      userId: "user-a",
      agentSource: "claude-code",
      sessionId: "session-a",
      state: legacyState(),
    };
    const storage = repo({
      loadAllInitialized: vi.fn(async () => [hydrated]),
    });
    const store = new SessionStore(30_000, storage);

    await expect(store.hydrateFromDb()).resolves.toBe(1);

    expect(JSON.stringify(store.get(sessionStoreKey(identity())))).not.toContain(CREDENTIAL);
    expect(storage.upsert).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(vi.mocked(storage.upsert).mock.calls[0]?.[4])).not.toContain(CREDENTIAL);
  });

  it("keeps request-local ACL credentials and error details out of diagnostics", async () => {
    const errorLog = vi.spyOn(log, "error").mockImplementation(() => undefined);
    const client = {
      checkAcl: vi.fn(async () => { throw new Error(ERROR_DETAIL); }),
    } as unknown as TdaiClient;

    await expect(checkAclOrDeny(client, {
      user_key: CREDENTIAL,
      asset_id: "asset-a",
      action: "read",
    })).resolves.toEqual({ allowed: false, reason: "acl_check_error" });

    const diagnostics = JSON.stringify(errorLog.mock.calls);
    expect(diagnostics).not.toContain(CREDENTIAL);
    expect(diagnostics).not.toContain(CREDENTIAL.slice(0, 6));
    expect(diagnostics).not.toContain(CREDENTIAL.slice(-4));
    expect(diagnostics).not.toContain(ERROR_DETAIL);
    expect(errorLog).toHaveBeenCalledWith(
      "[tdai-acl] check_failed",
      { category: "upstream_error" },
    );
  });
});

/**
 * SessionStore — L1 in-memory cache for session initialization state.
 *
 * Two-layer persistence:
 *   - L2a: `SessionRepo` — full SessionInitState (30 min pending TTL)
 *   - L2b: `BindingRepo` — minimal id-group binding, used for waking sleeping
 *          conversations (currently permanent under nottl/ prefix)
 *
 * See docs/design/2026-07-10-cos-ttl-nottl-split-plan.md §4.3.
 *
 * ── Identity binding ──────────────────────────────────────────────────────
 * Public API keeps a single `keyId: string` as the L1 map key. The key is a
 * collision-safe serialization of `(spaceId, userId, agentSource, sessionId)`;
 * the raw session id remains in `SessionInitState.keyId` and external APIs.
 * Repo calls require the same identity tuple. To avoid rippling it through
 * every `store.set(...)` call site in the session-init state machine, the
 * store maintains a keyId → identity map (`identities`):
 * callers invoke `bind(keyId, identity)` **once** when they have identity in
 * hand, and subsequent `set` / `delete` / `getOrRecover` pull the identity
 * back out. When no identity has been bound (e.g. anonymous / systemUser
 * requests that never rendezvous with auth), repo writes silently no-op.
 *
 * `getOrRecover` also takes an explicit identity param — it's the primary
 * entry point on every turn, so binding-through-that-path is guaranteed.
 */

import type { SessionInitState, SessionInitStatus, SessionInfo, AgentDetail, TaskDetail } from "./types.js";
import { getSessionRepo, type SessionRepo } from "../db/sessionRepo.js";
import type { BindingRepo, SessionBinding } from "../db/binding-repo.js";
import type { MetadataClient } from "../meta/client.js";
import { withoutPersistedCredential } from "./state-sanitize.js";

const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Identity tuple used by every Repo call (SessionRepo / BindingRepo).
 *
 * `spaceId` 是 P4 (kernel-sts) 新增字段，用于 STS 权限按 space 隔离时的 key 拼接。
 * 老 caller 不传时视作 `""`（空串），Repo 内部会用 `_default` 兜底段处理。
 */
export interface SessionIdentity {
  userId: string;
  agentSource: string;
  sessionId: string;
  spaceId?: string;
  teamId?: string;
  agentId?: string;
  taskId?: string;
}

export class SessionIdentityConflictError extends Error {
  constructor() {
    super("session_identity_conflict");
    this.name = "SessionIdentityConflictError";
  }
}

function compatibleOptionalIdentity(left?: string, right?: string): boolean {
  return !left || !right || left === right;
}

function mergeOptionalIdentity(bound?: string, incoming?: string): string | undefined {
  if (bound && incoming && bound !== incoming) {
    throw new SessionIdentityConflictError();
  }
  return bound || incoming;
}

function mergeIdentityValues(...values: Array<string | undefined>): string | undefined {
  return values.reduce<string | undefined>(
    (merged, value) => mergeOptionalIdentity(merged, value),
    undefined,
  );
}

function mergeIdentityClaim(
  bound: SessionIdentity | undefined,
  incoming: SessionIdentity,
): SessionIdentity {
  if (!bound) return { ...incoming };
  if (
    bound.userId !== incoming.userId
    || bound.agentSource !== incoming.agentSource
    || bound.sessionId !== incoming.sessionId
    || spaceOf(bound) !== spaceOf(incoming)
  ) {
    throw new SessionIdentityConflictError();
  }
  return {
    ...bound,
    teamId: mergeOptionalIdentity(bound.teamId, incoming.teamId),
    agentId: mergeOptionalIdentity(bound.agentId, incoming.agentId),
    taskId: mergeOptionalIdentity(bound.taskId, incoming.taskId),
  };
}

function boundIdentityMatchesIdentity(
  bound: SessionIdentity,
  incoming: SessionIdentity,
): boolean {
  return bound.userId === incoming.userId
    && bound.agentSource === incoming.agentSource
    && bound.sessionId === incoming.sessionId
    && spaceOf(bound) === spaceOf(incoming)
    && compatibleOptionalIdentity(bound.teamId, incoming.teamId)
    && compatibleOptionalIdentity(bound.agentId, incoming.agentId)
    && compatibleOptionalIdentity(bound.taskId, incoming.taskId);
}

function claimedIdentityMatchesStored(claimed?: string, stored?: string): boolean {
  return !claimed || claimed === stored;
}

/** Collision-safe L1 key; never expose this internal serialization to clients. */
export function sessionStoreKey(identity: SessionIdentity): string {
  return JSON.stringify([
    spaceOf(identity),
    identity.userId,
    identity.agentSource,
    identity.sessionId,
  ]);
}

function assertIdentityScopedKey(keyId: string, identity: SessionIdentity): void {
  if (keyId !== sessionStoreKey(identity)) {
    throw new SessionIdentityConflictError();
  }
}

/** Validate every identity field available on a recovered state. */
export function persistedStateMatchesIdentity(
  state: SessionInitState,
  identity: SessionIdentity,
): boolean {
  const session = state.sessionInfo;
  if (state.userId && state.userId !== identity.userId) return false;
  // Older recovery-only states used `${source}:${session}` here. Accept that
  // exact identity-bound representation during read, then normalize it before
  // promoting to L1; arbitrary or cross-source keys still fail closed.
  if (
    state.keyId
    && state.keyId !== identity.sessionId
    && state.keyId !== `${identity.agentSource}:${identity.sessionId}`
  ) return false;
  if (session?.user_id && session.user_id !== identity.userId) return false;
  if (session?.session_id && session.session_id !== identity.sessionId) return false;
  if (session?.space_id && identity.spaceId && session.space_id !== identity.spaceId) return false;

  const storedTeamId = session?.team_id ?? state.selectedTeamId;
  const storedAgentId = session?.agent_id ?? state.selectedAgentId ?? state.agentDetail?.id;
  const storedTaskId = session?.task_id ?? state.taskDetail?.id;
  // A legacy bypass state has no injectable team/agent/task context. Its
  // authenticated user/space/source/session tuple remains strict, while a
  // missing optional value is compatible with the same caller claims used to
  // accept its binding. Initialized states must still prove every claim.
  const optionalClaimMatches = state.bypassed
    ? compatibleOptionalIdentity
    : claimedIdentityMatchesStored;
  return optionalClaimMatches(identity.teamId, storedTeamId)
    && optionalClaimMatches(identity.agentId, storedAgentId)
    && optionalClaimMatches(identity.taskId, storedTaskId);
}

function bindingMatchesIdentity(binding: SessionBinding, identity: SessionIdentity): boolean {
  // Legacy bindings may omit fields. Their repository key is already scoped by
  // authenticated user/space/source/session. A bypass binding carries no
  // injectable team/agent/task context, so missing legacy fields remain safe;
  // initialized bindings must prove every explicit optional claim before Core.
  const optionalClaimMatches = binding.outcome === "bypassed"
    ? compatibleOptionalIdentity
    : claimedIdentityMatchesStored;
  return compatibleOptionalIdentity(identity.userId, binding.userId)
    && optionalClaimMatches(identity.teamId, binding.teamId)
    && optionalClaimMatches(identity.agentId, binding.agentId)
    && optionalClaimMatches(identity.taskId, binding.taskId);
}

function identityClaimFromBinding(
  identity: SessionIdentity,
  binding: SessionBinding,
): SessionIdentity {
  if (binding.userId && binding.userId !== identity.userId) {
    throw new SessionIdentityConflictError();
  }
  return {
    ...identity,
    teamId: mergeIdentityValues(identity.teamId, binding.teamId),
    agentId: mergeIdentityValues(identity.agentId, binding.agentId),
    taskId: mergeIdentityValues(identity.taskId, binding.taskId),
  };
}

/** Merge every identity field proved by a state before it can enter L1. */
function identityClaimFromState(
  identity: SessionIdentity,
  state: SessionInitState,
): SessionIdentity {
  const session = state.sessionInfo;
  if (
    (state.userId && state.userId !== identity.userId)
    || (
      state.keyId
      && state.keyId !== identity.sessionId
      && state.keyId !== `${identity.agentSource}:${identity.sessionId}`
    )
    || (session?.user_id && session.user_id !== identity.userId)
    || (session?.session_id && session.session_id !== identity.sessionId)
    || (session?.space_id && session.space_id !== spaceOf(identity))
  ) {
    throw new SessionIdentityConflictError();
  }
  return {
    ...identity,
    teamId: mergeIdentityValues(identity.teamId, session?.team_id, state.selectedTeamId),
    agentId: mergeIdentityValues(
      identity.agentId,
      session?.agent_id,
      state.selectedAgentId,
      state.agentDetail?.id,
    ),
    taskId: mergeIdentityValues(identity.taskId, session?.task_id, state.taskDetail?.id),
  };
}

function recoveryIdentityKey(
  keyId: string,
  identity: SessionIdentity,
  bindingClaim: RawSessionClaim,
): string {
  return JSON.stringify([
    keyId,
    identity.userId,
    identity.agentSource,
    identity.sessionId,
    identity.spaceId ?? "",
    identity.teamId ?? "",
    identity.agentId ?? "",
    identity.taskId ?? "",
    bindingClaim,
  ]);
}

function rawSessionKey(identity: SessionIdentity): string {
  return JSON.stringify([identity.agentSource, identity.sessionId]);
}

/** Extract spaceId from identity, defaulting to `""` for repo helpers. */
function spaceOf(id: SessionIdentity): string {
  return id.spaceId ?? "";
}

/** Context passed to getOrRecover for recovery. */
export interface RecoveryContext {
  /** MetadataClient for kernel agent/task get during recovery. */
  metadataClient?: MetadataClient;
  /** Full message history for fallback recovery via form-envelope scan. */
  messages?: Record<string, unknown>[];
}

interface L2aProbeResult {
  state?: SessionInitState;
  needsMigration?: boolean;
}

interface StateSnapshot {
  generation: number;
  state?: SessionInitState;
}

interface AwaitedStateResult {
  changed: boolean;
  state?: SessionInitState;
}

type RawSessionClaim = "exclusive" | "persisted";

export class SessionStore {
  private states = new Map<string, SessionInitState>();
  private stateGenerations = new Map<string, number>();
  /** keyId → identity map — populated via {@link bind} to keep repo/binding writes user-namespaced. */
  private identities = new Map<string, SessionIdentity>();
  /** Raw source/session ownership: new sessions are exclusive; persisted owners may coexist. */
  private rawSessionClaims = new Map<string, Map<string, RawSessionClaim>>();
  private ttlMs: number;
  private repo?: SessionRepo;
  private bindingRepo?: BindingRepo;
  private recoveryInFlight = new Map<string, Promise<SessionInitState | undefined>>();
  private persistenceTails = new Map<string, Promise<void>>();

  constructor(
    ttlMs: number = DEFAULT_TTL_MS,
    repo?: SessionRepo,
    bindingRepo?: BindingRepo,
  ) {
    this.ttlMs = ttlMs;
    this.repo = repo;
    this.bindingRepo = bindingRepo;
  }

  /** Attach BindingRepo late (called after Redis / storage activation). */
  setBindingRepo(repo: BindingRepo): void {
    this.bindingRepo = repo;
  }

  /**
   * Associate a keyId with a full (userId, agentSource, sessionId) identity so
   * that later {@link set} / {@link delete} / {@link getOrRecover} calls can
   * route writes to `SessionRepo` / `BindingRepo` in the correct namespace.
   *
   * Callers with identity in hand (handler.ts, session-init entry points,
   * hydrateFromDb) invoke this once per keyId. Anonymous callers or L1-only
   * consumers (e.g. skill-bridge's `store.get`) can skip binding — the store
   * silently degrades to memory-only for such keys.
   */
  bind(keyId: string, identity: SessionIdentity): void {
    const current = this.states.get(keyId);
    const claim = current && !this.isExpired(current)
      ? identityClaimFromState(identity, current)
      : identity;
    this.claimIdentity(keyId, claim, "exclusive");
  }

  /** Test-only helper: expose the identity map for assertions. */
  getBoundIdentity(keyId: string): SessionIdentity | undefined {
    return this.identities.get(keyId);
  }

  private snapshotState(keyId: string): StateSnapshot {
    return {
      generation: this.stateGenerations.get(keyId) ?? 0,
      state: this.states.get(keyId),
    };
  }

  private commitState(keyId: string, state: SessionInitState): number {
    const generation = (this.stateGenerations.get(keyId) ?? 0) + 1;
    this.states.set(keyId, state);
    this.stateGenerations.set(keyId, generation);
    return generation;
  }

  private isCurrentState(
    keyId: string,
    generation: number,
    state: SessionInitState,
  ): boolean {
    return this.stateGenerations.get(keyId) === generation && this.states.get(keyId) === state;
  }

  private removeState(keyId: string, expected?: SessionInitState): boolean {
    const current = this.states.get(keyId);
    if (expected && current !== expected) return false;
    if (current) this.states.delete(keyId);
    this.stateGenerations.set(keyId, (this.stateGenerations.get(keyId) ?? 0) + 1);
    return true;
  }

  private stateAfterAwait(
    keyId: string,
    before: StateSnapshot,
    identity: SessionIdentity,
  ): AwaitedStateResult {
    if ((this.stateGenerations.get(keyId) ?? 0) === before.generation) {
      return { changed: false };
    }
    const current = this.states.get(keyId);
    if (!current || this.isExpired(current)) return { changed: true };
    const merged = identityClaimFromState(this.previewIdentityClaim(keyId, identity), current);
    // A concurrent L1 winner is not itself durable proof. Preserve an existing
    // persisted claim, but do not upgrade an exclusive claim until its writer
    // completes a SessionRepo or BindingRepo operation successfully.
    this.claimIdentity(keyId, merged, "exclusive");
    return { changed: true, state: current };
  }

  private enqueuePersistence<T>(keyId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.persistenceTails.get(keyId) ?? Promise.resolve();
    const current = previous.then(work);
    const tail = current.then(() => undefined, () => undefined);
    this.persistenceTails.set(keyId, tail);
    void tail.then(() => {
      if (this.persistenceTails.get(keyId) === tail) this.persistenceTails.delete(keyId);
    });
    return current;
  }

  private previewIdentityClaim(keyId: string, identity: SessionIdentity): SessionIdentity {
    assertIdentityScopedKey(keyId, identity);
    return mergeIdentityClaim(this.identities.get(keyId), identity);
  }

  /**
   * Synchronously claim the scoped identity and raw conversation ownership.
   * Every validation completes before either map is mutated, so no competing
   * request can observe a partial claim between JavaScript turns.
   */
  private claimIdentity(
    keyId: string,
    identity: SessionIdentity,
    requestedRawClaim: RawSessionClaim,
  ): SessionIdentity {
    const merged = this.previewIdentityClaim(keyId, identity);
    const rawKey = rawSessionKey(merged);
    const nextRawClaims = new Map(this.rawSessionClaims.get(rawKey));

    // An expired exclusive owner no longer blocks reuse. Do not evict its L1
    // state here: rejected claim checks must remain side-effect free.
    for (const [ownerKey, claim] of nextRawClaims) {
      const ownerState = this.states.get(ownerKey);
      if (claim === "exclusive" && ownerState && this.isExpired(ownerState)) {
        nextRawClaims.delete(ownerKey);
      }
    }

    const existingClaim = nextRawClaims.get(keyId);
    const effectiveClaim = existingClaim === "persisted" ? "persisted" : requestedRawClaim;
    for (const [ownerKey, claim] of nextRawClaims) {
      if (ownerKey === keyId) continue;
      if (effectiveClaim === "exclusive" || claim === "exclusive") {
        throw new SessionIdentityConflictError();
      }
    }
    if (effectiveClaim === "exclusive" && this.hasRawSessionConflict(keyId, merged)) {
      throw new SessionIdentityConflictError();
    }

    nextRawClaims.set(keyId, effectiveClaim);
    this.identities.set(keyId, merged);
    this.rawSessionClaims.set(rawKey, nextRawClaims);
    return merged;
  }

  private releaseRawSessionClaim(keyId: string): void {
    const identity = this.identities.get(keyId);
    if (!identity) return;
    const rawKey = rawSessionKey(identity);
    const claims = this.rawSessionClaims.get(rawKey);
    if (!claims?.delete(keyId)) return;
    if (claims.size === 0) this.rawSessionClaims.delete(rawKey);
  }

  get(keyId: string): SessionInitState | undefined {
    const state = this.states.get(keyId);
    if (!state) return undefined;

    if (this.isExpired(state)) {
      this.discardExpiredState(keyId, state);
      return undefined;
    }

    return state;
  }

  /**
   * L1 write + L2a await write-through + L2b fire-and-forget binding。
   *
   * ⚠ 契约：`await store.set(...)` 完成时，L2a repo 已被 await（成功或静默失败）。
   * 见 2026-07-13 修复：原来 fire-and-forget 语义在多节点部署下会让 pod A
   * 关流时 COS PUT 还在飞，pod B 的 turn-2 因 L2a miss 直接掉进 tryHistoryScan
   * 兜底 → bypass → 请求透传 LLM。
   *
   * L2a/L2b writes for one full identity are serialized in invocation order,
   * so an older await cannot become the final durable writer after a newer L1.
   */
  async set(keyId: string, state: SessionInitState): Promise<void> {
    const credentialSafeState = withoutPersistedCredential(state);
    let id = this.identities.get(keyId);
    if (id) {
      id = this.claimIdentity(
        keyId,
        identityClaimFromState(id, credentialSafeState),
        "exclusive",
      );
    }
    const normalizedState = id
      ? { ...credentialSafeState, keyId: id.sessionId, userId: id.userId }
      : credentialSafeState;
    const writeGeneration = this.commitState(keyId, normalizedState);
    if (!id) {
      // No identity bound → this keyId is L1-only (anonymous session, tests
      // that bypass bind, etc.). Skip repo/binding persistence rather than
      // fabricating a partial identity.
      return;
    }
    // L2b: only write binding on terminal states
    // await 而非 fire-and-forget，保持与 L2a 一致的契约：
    // `await store.set(...)` return 时，L1 / L2a / L2b 三层都已 durable。
    // 每个 session 只会在初始化终态触发一次，成本可控。
    const binding: SessionBinding | undefined = normalizedState.status === "initialized"
      && this.bindingRepo
      ? normalizedState.bypassed
        ? { outcome: "bypassed", userId: normalizedState.userId, teamId: normalizedState.sessionInfo?.team_id, agentId: normalizedState.sessionInfo?.agent_id, taskId: normalizedState.sessionInfo?.task_id }
        : {
            outcome: "initialized",
            userId: normalizedState.sessionInfo?.user_id || normalizedState.userId,
            teamId: normalizedState.sessionInfo?.team_id,
            agentId: normalizedState.sessionInfo?.agent_id,
            taskId: normalizedState.sessionInfo?.task_id,
          }
      : undefined;
    if (!this.repo && !binding) return;

    // Serialize every state-backed durable write for this full identity. L1 is
    // still updated synchronously, while L2 observes the same invocation order.
    await this.enqueuePersistence(keyId, async () => {
      if (!this.isCurrentState(keyId, writeGeneration, normalizedState)) return;
      let durableIdentity = id!;
      if (this.repo) {
        let persisted = false;
        try {
          persisted = await this.repo.upsert(
            spaceOf(durableIdentity),
            durableIdentity.userId,
            durableIdentity.agentSource,
            durableIdentity.sessionId,
            normalizedState,
          );
        } catch {
          console.warn("[session] L2a upsert failed");
        }
        if (!this.isCurrentState(keyId, writeGeneration, normalizedState)) return;
        if (persisted) {
          durableIdentity = this.claimIdentity(keyId, durableIdentity, "persisted");
        }
      }
      if (binding && this.bindingRepo) {
        let persisted = false;
        try {
          persisted = await this.bindingRepo.putBinding(
            spaceOf(durableIdentity),
            durableIdentity.userId,
            durableIdentity.agentSource,
            durableIdentity.sessionId,
            binding,
          );
        } catch {
          console.warn("[session] L2b binding write failed");
        }
        if (
          persisted
          && this.isCurrentState(keyId, writeGeneration, normalizedState)
        ) this.claimIdentity(keyId, durableIdentity, "persisted");
      }
    });
  }

  delete(keyId: string): void {
    this.removeState(keyId);
    const id = this.identities.get(keyId);
    if (!id) return;
    this.releaseRawSessionClaim(keyId);
    void this.enqueuePersistence(keyId, async () => {
      await this.repo?.deleteBySessionId(spaceOf(id), id.userId, id.agentSource, id.sessionId);
      await this.bindingRepo
        ?.deleteBinding(spaceOf(id), id.userId, id.agentSource, id.sessionId)
        .catch(() => {});
    }).catch(() => {});
  }

  getStatus(keyId: string): SessionInitStatus {
    return this.get(keyId)?.status ?? "uninitialized";
  }

  /**
   * Detect an already-live raw conversation owned by a different user/space.
   * A persisted row for the incoming full identity may still prove that the
   * collision is legitimate, so callers use this only after their own L2
   * probes miss.
   */
  private hasRawSessionConflict(keyId: string, identity: SessionIdentity): boolean {
    for (const [otherKey, state] of this.states) {
      if (otherKey === keyId || this.isExpired(state)) continue;
      const other = this.identities.get(otherKey);
      if (
        other
        && other.agentSource === identity.agentSource
        && other.sessionId === identity.sessionId
      ) {
        return true;
      }
    }
    return false;
  }

  private isExpired(state: SessionInitState): boolean {
    return state.status !== "initialized" && Date.now() - state.startedAt > this.ttlMs;
  }

  private discardExpiredState(keyId: string, state: SessionInitState): void {
    // Recovery can await L2 reads before reaching this point. Do not delete a
    // newer state installed by another request while those reads were in flight.
    if (this.states.get(keyId) !== state || !this.isExpired(state)) return;
    this.removeState(keyId, state);
    this.releaseRawSessionClaim(keyId);
  }

  private discardExpiredRecovery(
    keyId: string,
    cachedState: SessionInitState | undefined,
  ): void {
    if (cachedState) {
      this.discardExpiredState(keyId, cachedState);
    }
  }

  cleanup(): void {
    const now = Date.now();
    for (const [keyId, state] of this.states) {
      if (state.status !== "initialized" && now - state.startedAt > this.ttlMs) {
        this.removeState(keyId, state);
        this.releaseRawSessionClaim(keyId);
      }
    }
  }

  async hydrateFromDb(): Promise<number> {
    if (!this.repo) return 0;
    try {
      const rows = await this.repo.loadAllInitialized();
      let loaded = 0;
      for (const row of rows) {
        // L1 keys use the same full identity tuple as handler/init entry sites.
        // Also bind full identity so subsequent set() persists back through
        // the correct (userId, agentSource, sessionId) key path.
        const safeState = withoutPersistedCredential(row.state);
        const normalizedState = safeState.keyId === row.sessionId
          ? safeState
          : { ...safeState, keyId: row.sessionId };
        const identity: SessionIdentity = {
          userId: row.userId,
          agentSource: row.agentSource,
          sessionId: row.sessionId,
          spaceId: row.spaceId || undefined,
          teamId: normalizedState.sessionInfo?.team_id ?? normalizedState.selectedTeamId,
          agentId: normalizedState.sessionInfo?.agent_id
            ?? normalizedState.selectedAgentId
            ?? normalizedState.agentDetail?.id,
          taskId: normalizedState.sessionInfo?.task_id ?? normalizedState.taskDetail?.id,
        };
        if (!persistedStateMatchesIdentity(row.state, identity)) {
          console.warn("[session-db] skipped session with identity conflict");
          continue;
        }
        const keyId = sessionStoreKey(identity);
        if (!this.states.has(keyId)) {
          this.claimIdentity(keyId, identity, "persisted");
          this.commitState(keyId, normalizedState);
          if (normalizedState !== row.state) {
            try {
              await this.enqueuePersistence(keyId, () => this.repo!.upsert(
                row.spaceId, row.userId, row.agentSource, row.sessionId, normalizedState,
              ));
            } catch {
              // Best-effort lazy migration; L1 is already credential-free.
            }
          }
          loaded++;
        }
      }
      if (loaded > 0) {
        console.log(`[session-db] hydrated ${loaded} initialized session(s) from disk`);
      }
      return loaded;
    } catch {
      console.warn("[session-db] hydrateFromDb failed");
      return 0;
    }
  }

  // ── Recovery layer ──────────────────────────────────────────────────────────

  /**
   * Get session state, or attempt recovery from L2b binding if hot cache missed.
   *
   * Returns undefined when the session should be treated as truly new
   * (caller then invokes handleSessionInit to pop the form).
   *
   * Recovery chain: L1 → L2a → L2b (kernel fetch) → history-scan fallback.
   */
  async getOrRecover(
    keyId: string,
    identity: SessionIdentity,
    ctx: RecoveryContext,
  ): Promise<SessionInitState | undefined> {
    // Validate before any L1 read or identity binding. Reusing a raw
    // source/session key here would let one authenticated user receive another
    // user's terminal state and would redirect later write-through persistence.
    assertIdentityScopedKey(keyId, identity);
    // Step 1: L1
    //
    // ⚠ Terminal 状态（`initialized`，含 `bypassed`）L1 才权威 —— 一旦定型
    // 不会再改；pending_* 状态**不能**在 L1 命中就短路，否则会踩到多节点跨
    // pod 陈旧读 bug（2026-07-14）：
    //   turn-1 打 pod A → 写 L1(A)=pending_asset_confirm + L2a
    //   turn-2 打 pod B → L2a probe 读到 pending_asset_confirm → advance 到
    //                     pending_agent_select → 写 L1(B) + L2a
    //   turn-3 又打 pod A → L1(A) 仍然是 pending_asset_confirm（pod 间无
    //                       cache-invalidation 通知）→ 若这里短路就用陈旧
    //                       state 去处理 turn-3 的 agent 答复 → extract 拿
    //                       "agent 选项文本" 去 asset_confirm 分支 →
    //                       unrecognized → session bypass → 请求原样透传给
    //                       LLM（用户观感：不选 task 就走了）。
    //
    // 修法：pending_* 无论 L1 是否命中，都必须走 probeL2a 拿权威值；caller
    // 在同步 identity claim 后 promote 覆盖 L1，之后 init.ts 的 `store.get(compositeKey)` 就能
    // 读到最新状态。L1 pending 命中作为 L2a 失败/miss 时的 last-resort fallback
    // 保留（见 Step 2 后的分支），保证同 pod 场景下 L2a 尚未落盘时不倒退。
    //
    // 代价：pending_* 每轮多一次 storage GET（~1-2ms Redis / ~50ms COS）。
    // pending 轮次只在初始化 form 阶段出现，每个 session 顶多 2-4 次，可接受；
    // initialized 快路径仍是纯内存零 IO。
    const initialSnapshot = this.snapshotState(keyId);
    const cachedState = initialSnapshot.state;
    const boundIdentity = this.identities.get(keyId);
    if (
      (boundIdentity && !boundIdentityMatchesIdentity(boundIdentity, identity))
      || (cachedState && !persistedStateMatchesIdentity(cachedState, identity))
    ) {
      throw new SessionIdentityConflictError();
    }
    // Inspect expiry without deleting anything. A later raw/L2 binding conflict
    // must reject without letting the caller mutate this or another identity's
    // cache entry as a side effect of the conflict check.
    const l1 = cachedState && !this.isExpired(cachedState) ? cachedState : undefined;
    if (l1 && l1.status === "initialized") {
      const merged = identityClaimFromState(this.previewIdentityClaim(keyId, identity), l1);
      if (!persistedStateMatchesIdentity(l1, merged)) {
        throw new SessionIdentityConflictError();
      }
      this.claimIdentity(keyId, merged, "exclusive");
      console.log("[cache] session=<redacted> L1 hit (terminal)");
      return l1;
    }

    // Step 2: L2a SessionRepo (Redis / SQLite / ProxyStorage) — full SessionInitState.
    // Startup `hydrateFromDb()` covers the single-node case, but in multi-node
    // deployments a session initialized on node A won't be in node B's L1.
    // Without this probe every such request falls through to L2b + a fresh
    // `metadataClient.getAgent/getTask` roundtrip, even though the full
    // agentDetail/taskDetail is sitting in the storage layer. Pending 状态也
    // 必须命中就返回 —— 见上面 Step 1 的多节点陈旧 L1 注释。
    if (this.repo) {
      const beforeL2a = this.snapshotState(keyId);
      const l2a = await this.probeL2a(identity);
      const afterL2a = this.stateAfterAwait(keyId, beforeL2a, identity);
      if (afterL2a.changed) return afterL2a.state;
      if (l2a.state) {
        const merged = identityClaimFromState(
          this.previewIdentityClaim(keyId, identity),
          l2a.state,
        );
        if (!persistedStateMatchesIdentity(l2a.state, merged)) {
          throw new SessionIdentityConflictError();
        }
        const claimed = this.claimIdentity(keyId, merged, "persisted");
        this.commitState(keyId, l2a.state);
        if (l2a.needsMigration) {
          const beforeMigration = this.snapshotState(keyId);
          try {
            await this.enqueuePersistence(keyId, () => this.repo!.upsert(
              spaceOf(claimed), claimed.userId, claimed.agentSource, claimed.sessionId, l2a.state!,
            ));
          } catch {
            // Best-effort lazy migration; L1 is already credential-free.
          }
          const stateAfterMigration = this.stateAfterAwait(keyId, beforeMigration, claimed);
          if (stateAfterMigration.changed) return stateAfterMigration.state;
          this.claimIdentity(keyId, claimed, "persisted");
        }
        console.log(`[cache] session=<redacted> L2a hit → promote L1${l1 ? " (override stale L1)" : ""}`);
        return l2a.state;
      }
    }

    // Step 2.5: L1 pending 命中 + L2a miss 的兜底。
    //
    // 触发路径：同 pod 内 pending_* 轮次之间 —— L2a 已经在上一轮 `set()` 里
    // await 落盘，probeL2a 应该命中；但若 L2a 真的 miss（storage 抖动 / 后端
    // 短暂不可用 / 极端时序），继续走 L2b 只会拿到 undefined（binding 只在
    // initialized 写），最终 `tryHistoryScan` 无条件 bypass —— 反而更糟。
    // 这里回退到 L1 pending 是 "宁可用略旧但合理的状态" 的取舍。
    //
    // zombie / user-mismatch 已在 `this.get()` 与 `probeL2a` 内部各自 invalidate，
    // 走到这里的 l1 一定是 fresh + user 匹配的。
    if (l1) {
      const merged = identityClaimFromState(this.previewIdentityClaim(keyId, identity), l1);
      if (!persistedStateMatchesIdentity(l1, merged)) {
        throw new SessionIdentityConflictError();
      }
      this.claimIdentity(keyId, merged, "exclusive");
      console.log("[cache] session=<redacted> L1 hit (pending, L2a miss fallback)");
      return l1;
    }

    // Step 3: L2b Binding
    if (!this.bindingRepo) {
      let claimed = this.claimIdentity(keyId, identity, "exclusive");
      this.discardExpiredRecovery(keyId, cachedState);
      claimed = this.claimIdentity(keyId, claimed, "exclusive");
      console.log("[cache] session=<redacted> miss (no bindingRepo) → history-scan");
      return this.tryHistoryScan(keyId, claimed, ctx);
    }
    const stateBeforeBinding = this.snapshotState(keyId);
    let binding: SessionBinding | null;
    try {
      binding = await this.bindingRepo.getBinding(
        spaceOf(identity),
        identity.userId,
        identity.agentSource,
        identity.sessionId,
      );
    } catch {
      binding = null;
    }
    const stateAfterBinding = this.stateAfterAwait(keyId, stateBeforeBinding, identity);
    if (stateAfterBinding.changed) return stateAfterBinding.state;
    if (!binding) {
      let claimed = this.claimIdentity(keyId, identity, "exclusive");
      this.discardExpiredRecovery(keyId, this.states.get(keyId));
      claimed = this.claimIdentity(keyId, claimed, "exclusive");
      console.log("[cache] session=<redacted> miss (no binding) → history-scan");
      return this.tryHistoryScan(keyId, claimed, ctx);
    }
    const merged = this.previewIdentityClaim(keyId, identity);
    if (!bindingMatchesIdentity(binding, merged)) {
      throw new SessionIdentityConflictError();
    }
    let claimed = this.claimIdentity(
      keyId,
      identityClaimFromBinding(merged, binding),
      "persisted",
    );
    this.discardExpiredRecovery(keyId, this.states.get(keyId));
    claimed = this.claimIdentity(keyId, claimed, "persisted");
    // Bind only after all applicable L1, L2a, raw-session and L2b identity
    // checks pass. A rejected caller must never poison a later recovery.
    console.log(`[cache] session=<redacted> L2b binding hit outcome=${binding.outcome} → rebuild`);

    // Async touch (refresh 30d TTL, don't await)
    void this.bindingRepo
      .touchLastSeen(spaceOf(claimed), claimed.userId, claimed.agentSource, claimed.sessionId)
      .catch(() => {});

    // Step 3.1: bypassed outcome → construct bypass state
    if (binding.outcome === "bypassed") {
      const state: SessionInitState = {
        status: "initialized",
        keyId: claimed.sessionId,
        startedAt: Date.now(),
        attemptCount: 0,
        userId: claimed.userId,
        bypassed: true,
        sessionInfo: null,
        agentDetail: null,
        taskDetail: null,
      };
      await this.set(keyId, state);
      return state;
    }

    // Step 3.2: initialized outcome → rebuild via kernel
    return this.rebuildFromBinding(keyId, claimed, binding, "persisted", ctx);
  }

  /**
   * L2a probe: read and validate the full SessionInitState (agentDetail /
   * taskDetail included). Promotion and migration happen only after the caller
   * synchronously claims identity ownership.
   *
   * Returns undefined (caller should fall through to L2b) when:
   *   - the repo has no row for this key,
   *   - the stored userId disagrees with the current caller (cached identity
   *     no longer applies — same policy as L2b invalidation; row is dropped),
   *   - the row is a stale pending state past ttl (zombie session from a
   *     crashed node; ignored here because passive recovery has no repo CAS),
   *   - the underlying storage errored (degrade silently, same as elsewhere).
   *
   * Non-terminal statuses (`pending_*`) are ALSO returned so a form flow
   * started on node A can continue on node B.
   */
  private async probeL2a(
    identity: SessionIdentity,
  ): Promise<L2aProbeResult> {
    let row: SessionInitState | null;
    try {
      row = await this.repo!.getBySessionId(
        spaceOf(identity),
        identity.userId,
        identity.agentSource,
        identity.sessionId,
      );
    } catch {
      return {};
    }
    if (!row) return {};
    const persistedRow = row;
    row = withoutPersistedCredential(row);

    if (!persistedStateMatchesIdentity(row, identity)) {
      throw new SessionIdentityConflictError();
    }

    // Zombie guard: pending forms past ttl are dropped (mirrors get()'s
    // in-memory ttl policy). Only pending — initialized sessions have no
    // ttl concept (users legitimately come back to old conversations).
    if (
      row.status !== "initialized" &&
      Date.now() - row.startedAt > this.ttlMs
    ) {
      console.log(
        `[session-recover] session=<redacted> L2a pending expired (status=${row.status}), deferring invalidation`,
      );
      return {};
    }

    // Promote back to L1 so subsequent turns don't hit the repo at all.
    const normalizedRow = row.keyId === identity.sessionId
      ? row
      : { ...row, keyId: identity.sessionId };
    console.log(
      `[session-recover] session=<redacted> L2a hit status=${row.status} agent=${row.sessionInfo?.agent_id ? "present" : "none"} task=${row.sessionInfo?.task_id ? "present" : "none"}`,
    );
    return { state: normalizedRow, needsMigration: normalizedRow !== persistedRow };
  }

  /** In-flight promise deduplication: same keyId → same rebuild promise. */
  private rebuildFromBinding(
    keyId: string,
    identity: SessionIdentity,
    binding: SessionBinding,
    bindingClaim: RawSessionClaim,
    ctx: RecoveryContext,
  ): Promise<SessionInitState | undefined> {
    const inFlightKey = recoveryIdentityKey(keyId, identity, bindingClaim);
    const inFlight = this.recoveryInFlight.get(inFlightKey);
    if (inFlight) return inFlight;
    const p = this.doRebuild(keyId, identity, binding, bindingClaim, ctx)
      .finally(() => this.recoveryInFlight.delete(inFlightKey));
    this.recoveryInFlight.set(inFlightKey, p);
    return p;
  }

  private async doRebuild(
    keyId: string,
    identity: SessionIdentity,
    binding: SessionBinding,
    bindingClaim: RawSessionClaim,
    ctx: RecoveryContext,
  ): Promise<SessionInitState | undefined> {
    // Step 4.1: never rebuild a binding under a conflicting caller identity.
    let claimed = this.previewIdentityClaim(keyId, identity);
    if (!bindingMatchesIdentity(binding, claimed)) {
      throw new SessionIdentityConflictError();
    }
    claimed = this.claimIdentity(
      keyId,
      identityClaimFromBinding(claimed, binding),
      bindingClaim,
    );

    if (!ctx.metadataClient) {
      // No client → can't recover, degrade to one-shot bypass
      console.warn("[session-recover] session=<redacted> no metadataClient, one-shot bypass");
      return {
        status: "initialized", keyId: claimed.sessionId, startedAt: Date.now(),
        attemptCount: 0, bypassed: true,
        sessionInfo: null, agentDetail: null, taskDetail: null,
      };
    }

    // Step 4.2: fetch details in parallel
    const beforeMetadata = this.snapshotState(keyId);
    const [agentR, taskR] = await Promise.allSettled([
      binding.agentId ? ctx.metadataClient.getAgent(binding.agentId) : Promise.resolve(null),
      binding.taskId ? ctx.metadataClient.getTask(binding.taskId) : Promise.resolve(null),
    ]);
    const stateAfterMetadata = this.stateAfterAwait(keyId, beforeMetadata, claimed);
    if (stateAfterMetadata.changed) return stateAfterMetadata.state;
    claimed = this.previewIdentityClaim(keyId, claimed);
    if (!bindingMatchesIdentity(binding, claimed)) {
      throw new SessionIdentityConflictError();
    }
    claimed = this.claimIdentity(
      keyId,
      identityClaimFromBinding(claimed, binding),
      bindingClaim,
    );

    const isNotFound = (e: unknown): boolean =>
      typeof e === "object" && e !== null && (e as { notFound?: boolean }).notFound === true;

    let agentDetail: AgentDetail | null = null;
    let taskDetail: TaskDetail | null = null;
    let agentNotFound = false;
    let taskNotFound = false;
    let anyKernelError = false;

    if (agentR.status === "fulfilled") {
      if (agentR.value) {
        agentDetail = {
          id: agentR.value.agent_id,
          name: agentR.value.name,
          description: agentR.value.description ?? undefined,
          prompt: agentR.value.prompt ?? undefined,
        };
      } else if (binding.agentId) agentNotFound = true;
    } else {
      if (isNotFound(agentR.reason)) agentNotFound = true;
      else anyKernelError = true;
    }
    if (taskR.status === "fulfilled") {
      if (taskR.value) {
        taskDetail = {
          id: taskR.value.task_id,
          name: taskR.value.title,
          description: taskR.value.description ?? undefined,
        };
      } else if (binding.taskId) taskNotFound = true;
    } else {
      if (isNotFound(taskR.reason)) taskNotFound = true;
      else anyKernelError = true;
    }

    // Step 4.3: dispatch
    if (agentNotFound) {
      console.log("[session-recover] session=<redacted> agent not found, retaining identity without context");
      agentDetail = null;
      taskDetail = null;
    }
    if (anyKernelError) {
      console.warn("[session-recover] session=<redacted> kernel unavailable, one-shot bypass");
      // Don't delete binding; return one-shot bypass to serve this request
      return {
        status: "initialized", keyId: claimed.sessionId, startedAt: Date.now(),
        attemptCount: 0, bypassed: true,
        sessionInfo: null, agentDetail: null, taskDetail: null,
      };
    }
    if (taskNotFound) {
      console.log("[session-recover] session=<redacted> task not found, retaining identity without task context");
      taskDetail = null;
    }

    // Step 4.4: construct rebuilt state
    const sessionInfo: SessionInfo = {
      session_id: claimed.sessionId,
      user_id: binding.userId || claimed.userId,
      team_id: binding.teamId || "",
      agent_id: binding.agentId || "",
      task_id: binding.taskId,
      space_id: claimed.spaceId,
      created_at: new Date().toISOString(),
    };

    const rebuilt: SessionInitState = {
      status: "initialized",
      keyId: claimed.sessionId,
      startedAt: Date.now(),
      attemptCount: 0,
      bypassed: false,
      sessionInfo,
      userId: binding.userId,
      agentDetail,
      taskDetail,
      ...(agentNotFound || taskNotFound ? { contextSuppressed: true } : {}),
    };

    // Step 4.5: write back to L1 + L2a
    this.commitState(keyId, rebuilt);
    // await write-through 与 SessionStore.set 保持一致契约（见其头注释）：
    // 让恢复出的 rebuilt 状态在返回前已落 L2a，避免同 session 后续轮次
    // 若又打到别的 pod 时再走一次 rebuildFromBinding 的开销。
    // 防御性 catch 见 `set()` 头注释。
    if (this.repo) {
      const beforePersist = this.snapshotState(keyId);
      let statePersisted = false;
      try {
        statePersisted = await this.enqueuePersistence(keyId, () => this.repo!.upsert(
          spaceOf(claimed), claimed.userId, claimed.agentSource, claimed.sessionId, rebuilt,
        ));
      } catch {
        console.warn("[session-recover] L2a upsert failed during rebuild");
      }
      const stateAfterPersist = this.stateAfterAwait(keyId, beforePersist, claimed);
      if (stateAfterPersist.changed) return stateAfterPersist.state;
      if (statePersisted) this.claimIdentity(keyId, claimed, "persisted");
    }

    console.log(`[session-recover] session=<redacted> rebuilt from binding agent=${binding.agentId ? "present" : "none"} task=${binding.taskId ? "present" : "none"}`);

    return rebuilt;
  }

  /**
   * Last-resort fallback: when L2b binding is also missing but the conversation
   * has multiple user messages, scan the history for session-init form envelopes
   * to determine whether this was a bypassed session or had chosen agent/task.
   *
   * - 0-1 user messages + no assistant/tool → truly new
   * - has form markers → attempt to extract agent/task from them
   * - has history but no markers → one-shot bypass (don't re-pop the form)
   */
  private async tryHistoryScan(
    keyId: string,
    identity: SessionIdentity,
    ctx: RecoveryContext,
  ): Promise<SessionInitState | undefined> {
    const messages = ctx.messages ?? [];
    if (messages.length === 0) return undefined;

    // Count user messages and check for assistant/tool existence
    let userCount = 0;
    let hasAssistantOrTool = false;
    for (const m of messages) {
      const role = (m.role as string) ?? "";
      if (role === "user") userCount++;
      if (role === "assistant" || role === "tool") hasAssistantOrTool = true;
    }

    // Truly fresh: only one user message, no conversation yet
    if (userCount <= 1 && !hasAssistantOrTool) return undefined;

    // Has conversation history — try to scan for form envelope
    let foundBypass = false;
    let foundAgentId: string | undefined;
    let foundTaskId: string | undefined;

    for (const m of messages) {
      if (m.role !== "assistant") continue;
      const content = m.content;
      if (typeof content !== "string") {
        // Anthropic: content array
        if (Array.isArray(content)) {
          for (const block of content as any[]) {
            if (block.type !== "tool_use") continue;
            if (typeof block.name !== "string") continue;
            // Look for AskUserQuestion with our session-init prefix
            if ((block.id as string)?.startsWith?.("toolu_cc_session_init_")) {
              const input = block.input as Record<string, unknown> | undefined;
              const question = (input?.question as string) ?? "";
              const options = input?.options as string[] | undefined;
              if (question.includes("关联") || question.includes("资产")) {
                // asset_confirm form — check if the next user message said "否"
                continue; // defer to extractAssetConfirm logic via bypass detection
              }
              if (options?.includes("否，本次不关联") || options?.includes("跳过") || question.includes("SKIP")) {
                foundBypass = true;
              }
              if (question.includes("agent") || question.includes("Agent")) {
                for (const o of options ?? []) {
                  const m = o.match(/^(.+)\s\(([^)]+)\)$/);
                  if (m) foundAgentId = m[2];
                }
              }
            }
          }
        }
        continue;
      }
      // CodeBuddy: <question_answer> XML in string content
      if (!content.includes("<question_answer")) continue;
      // Check for asset_confirm bypass markers in the assistant form message
      if (content.includes("否，本次不关联") || content.includes("本次不关联")) {
        foundBypass = true;
      }
      // Extract agent_id from <question_item id="agent">
      const agentIdMatch = content.match(/<question_item\s+id="agent"[^>]*>[^<]*<\/question_item>/);
      if (agentIdMatch) {
        const valueMatch = agentIdMatch[0].match(/<value>([^<]+)<\/value>/);
        if (valueMatch) foundAgentId = valueMatch[1];
      }
    }

    if (foundBypass && !foundAgentId) {
      // User chose bypass: construct bypass state
      const state: SessionInitState = {
        status: "initialized",
        keyId: identity.sessionId,
        startedAt: Date.now(),
        attemptCount: 0,
        bypassed: true,
        sessionInfo: null,
        agentDetail: null,
        taskDetail: null,
      };
      this.commitState(keyId, state);
      console.log("[session-recover] session=<redacted> history scan → bypass (form found, no agent selected)");
      return state;
    }

    if (!foundAgentId) {
      // Has history but can't extract anything → one-shot bypass, don't re-pop form
      console.log("[session-recover] session=<redacted> history scan → one-shot bypass (conversation exists but no form markers found)");
      const state: SessionInitState = {
        status: "initialized",
        keyId: identity.sessionId,
        startedAt: Date.now(),
        attemptCount: 0,
        bypassed: true,
        sessionInfo: null,
        agentDetail: null,
        taskDetail: null,
      };
      return state;
    }

    // Found agent_id in history — try kernel rebuild (same as L2b hit path)
    console.log("[session-recover] session=<redacted> history scan → agent=present, attempting rebuild");
    const binding: SessionBinding = {
      outcome: "initialized",
      userId: identity.userId,
      agentId: foundAgentId,
      taskId: foundTaskId,
    };
    return this.rebuildFromBinding(keyId, identity, binding, "exclusive", ctx);
  }
}

/** Global singleton (reset on process restart). */
let _store: SessionStore | null = null;

export function getSessionStore(): SessionStore {
  if (!_store) {
    let repo: SessionRepo | undefined;
    try {
      repo = getSessionRepo();
    } catch {
      console.warn("[session-db] session repo unavailable, running memory-only");
    }
    _store = new SessionStore(DEFAULT_TTL_MS, repo);
    void _store.hydrateFromDb();
  }
  return _store;
}

/** Reset the singleton — tests only. */
export function __resetSessionStoreForTests(): void {
  _store = null;
}

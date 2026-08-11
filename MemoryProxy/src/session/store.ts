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

function boundIdentityMatchesIdentity(
  bound: SessionIdentity,
  incoming: SessionIdentity,
): boolean {
  return bound.userId === incoming.userId
    && bound.agentSource === incoming.agentSource
    && bound.sessionId === incoming.sessionId
    && compatibleOptionalIdentity(bound.spaceId, incoming.spaceId)
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

function recoveryIdentityKey(keyId: string, identity: SessionIdentity): string {
  return JSON.stringify([
    keyId,
    identity.userId,
    identity.agentSource,
    identity.sessionId,
    identity.spaceId ?? "",
    identity.teamId ?? "",
    identity.agentId ?? "",
    identity.taskId ?? "",
  ]);
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

export class SessionStore {
  private states = new Map<string, SessionInitState>();
  /** keyId → identity map — populated via {@link bind} to keep repo/binding writes user-namespaced. */
  private identities = new Map<string, SessionIdentity>();
  private ttlMs: number;
  private repo?: SessionRepo;
  private bindingRepo?: BindingRepo;
  private recoveryInFlight = new Map<string, Promise<SessionInitState | undefined>>();

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
    assertIdentityScopedKey(keyId, identity);
    const bound = this.identities.get(keyId);
    if (bound && !boundIdentityMatchesIdentity(bound, identity)) {
      throw new SessionIdentityConflictError();
    }
    this.identities.set(keyId, identity);
  }

  /** Test-only helper: expose the identity map for assertions. */
  getBoundIdentity(keyId: string): SessionIdentity | undefined {
    return this.identities.get(keyId);
  }

  get(keyId: string): SessionInitState | undefined {
    const state = this.states.get(keyId);
    if (!state) return undefined;

    if (state.status !== "initialized" && Date.now() - state.startedAt > this.ttlMs) {
      this.states.delete(keyId);
      const id = this.identities.get(keyId);
      if (id) this.repo?.deleteBySessionId(spaceOf(id), id.userId, id.agentSource, id.sessionId);
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
   * L2b binding 仍是 fire-and-forget —— 只在 `initialized` 状态写入，属于
   * "小纸条"型持久化，用于长睡对话唤醒；写延迟不影响 pending 状态跨节点恢复。
   */
  async set(keyId: string, state: SessionInitState): Promise<void> {
    const id = this.identities.get(keyId);
    const credentialSafeState = withoutPersistedCredential(state);
    const normalizedState = id
      ? { ...credentialSafeState, keyId: id.sessionId, userId: id.userId }
      : credentialSafeState;
    this.states.set(keyId, normalizedState);
    if (!id) {
      // No identity bound → this keyId is L1-only (anonymous session, tests
      // that bypass bind, etc.). Skip repo/binding persistence rather than
      // fabricating a partial identity.
      return;
    }
    // L2a write-through —— MUST await；见方法头注释。
    // 二次防御性 catch：契约要求实现方（KvSessionRepo / RedisSessionRepo /
    // SqliteSessionRepo）内部静默降级不抛，但接口层再兜一层，保证任何后来
    // 新增的 repo 或 test-mock 都不会把异常泄给 44 处 `await store.set(...)`
    // caller —— L1 已成功写入，主流程不因 L2a 写失败挂掉。
    if (this.repo) {
      try {
        await this.repo.upsert(spaceOf(id), id.userId, id.agentSource, id.sessionId, normalizedState);
      } catch {
        console.warn("[session] L2a upsert failed");
      }
    }
    // L2b: only write binding on terminal states
    // await 而非 fire-and-forget，保持与 L2a 一致的契约：
    // `await store.set(...)` return 时，L1 / L2a / L2b 三层都已 durable。
    // 每个 session 只会在初始化终态触发一次，成本可控。
    if (normalizedState.status === "initialized" && this.bindingRepo) {
      const binding: SessionBinding = normalizedState.bypassed
        ? { outcome: "bypassed", userId: normalizedState.userId, teamId: normalizedState.sessionInfo?.team_id, agentId: normalizedState.sessionInfo?.agent_id, taskId: normalizedState.sessionInfo?.task_id }
        : {
            outcome: "initialized",
            userId: normalizedState.sessionInfo?.user_id || normalizedState.userId,
            teamId: normalizedState.sessionInfo?.team_id,
            agentId: normalizedState.sessionInfo?.agent_id,
            taskId: normalizedState.sessionInfo?.task_id,
          };
      try {
        await this.bindingRepo.putBinding(spaceOf(id), id.userId, id.agentSource, id.sessionId, binding);
      } catch {
        console.warn("[session] L2b binding write failed");
      }
    }
  }

  delete(keyId: string): void {
    this.states.delete(keyId);
    const id = this.identities.get(keyId);
    if (!id) return;
    this.repo?.deleteBySessionId(spaceOf(id), id.userId, id.agentSource, id.sessionId);
    void this.bindingRepo
      ?.deleteBinding(spaceOf(id), id.userId, id.agentSource, id.sessionId)
      .catch(() => {});
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
    for (const [otherKey] of this.states) {
      if (otherKey === keyId || !this.get(otherKey)) continue;
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

  cleanup(): void {
    const now = Date.now();
    for (const [keyId, state] of this.states) {
      if (state.status !== "initialized" && now - state.startedAt > this.ttlMs) {
        this.states.delete(keyId);
        const id = this.identities.get(keyId);
        if (id) this.repo?.deleteBySessionId(spaceOf(id), id.userId, id.agentSource, id.sessionId);
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
          this.states.set(keyId, normalizedState);
          this.identities.set(keyId, identity);
          if (normalizedState !== row.state) {
            try {
              await this.repo.upsert(
                row.spaceId,
                row.userId,
                row.agentSource,
                row.sessionId,
                normalizedState,
              );
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
    // 修法：pending_* 无论 L1 是否命中，都必须走 probeL2a 拿权威值；probeL2a
    // 内部会 promote 覆盖 L1，之后 init.ts 的 `store.get(compositeKey)` 就能
    // 读到最新状态。L1 pending 命中作为 L2a 失败/miss 时的 last-resort fallback
    // 保留（见 Step 2 后的分支），保证同 pod 场景下 L2a 尚未落盘时不倒退。
    //
    // 代价：pending_* 每轮多一次 storage GET（~1-2ms Redis / ~50ms COS）。
    // pending 轮次只在初始化 form 阶段出现，每个 session 顶多 2-4 次，可接受；
    // initialized 快路径仍是纯内存零 IO。
    const l1 = this.get(keyId);
    const boundIdentity = this.identities.get(keyId);
    const rawSessionConflict = !l1 && this.hasRawSessionConflict(keyId, identity);
    if (
      (boundIdentity && !boundIdentityMatchesIdentity(boundIdentity, identity))
      || (l1 && !persistedStateMatchesIdentity(l1, identity))
    ) {
      throw new SessionIdentityConflictError();
    }

    if (l1 && l1.status === "initialized") {
      this.identities.set(keyId, identity);
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
      const l2a = await this.probeL2a(keyId, identity);
      if (l2a) {
        this.identities.set(keyId, identity);
        console.log(`[cache] session=<redacted> L2a hit → promote L1${l1 ? " (override stale L1)" : ""}`);
        return l2a;
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
      this.identities.set(keyId, identity);
      console.log("[cache] session=<redacted> L1 hit (pending, L2a miss fallback)");
      return l1;
    }

    // Step 3: L2b Binding
    if (!this.bindingRepo) {
      if (rawSessionConflict) throw new SessionIdentityConflictError();
      this.identities.set(keyId, identity);
      console.log("[cache] session=<redacted> miss (no bindingRepo) → history-scan");
      return this.tryHistoryScan(keyId, identity, ctx);
    }
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
    if (!binding) {
      if (rawSessionConflict) throw new SessionIdentityConflictError();
      this.identities.set(keyId, identity);
      console.log("[cache] session=<redacted> miss (no binding) → history-scan");
      return this.tryHistoryScan(keyId, identity, ctx);
    }
    if (!bindingMatchesIdentity(binding, identity)) {
      throw new SessionIdentityConflictError();
    }
    // Bind only after all applicable L1, L2a, raw-session and L2b identity
    // checks pass. A rejected caller must never poison a later recovery.
    this.identities.set(keyId, identity);
    console.log(`[cache] session=<redacted> L2b binding hit outcome=${binding.outcome} → rebuild`);

    // Async touch (refresh 30d TTL, don't await)
    void this.bindingRepo
      .touchLastSeen(spaceOf(identity), identity.userId, identity.agentSource, identity.sessionId)
      .catch(() => {});

    // Step 3.1: bypassed outcome → construct bypass state
    if (binding.outcome === "bypassed") {
      const state: SessionInitState = {
        status: "initialized",
        keyId: identity.sessionId,
        startedAt: Date.now(),
        attemptCount: 0,
        userId: identity.userId,
        bypassed: true,
        sessionInfo: null,
        agentDetail: null,
        taskDetail: null,
      };
      await this.set(keyId, state);
      return state;
    }

    // Step 3.2: initialized outcome → rebuild via kernel
    return this.rebuildFromBinding(keyId, identity, binding, ctx);
  }

  /**
   * L2a probe: read the full SessionInitState (agentDetail / taskDetail
   * included) from `SessionRepo` and, if valid, promote it back to L1.
   *
   * Returns undefined (caller should fall through to L2b) when:
   *   - the repo has no row for this key,
   *   - the stored userId disagrees with the current caller (cached identity
   *     no longer applies — same policy as L2b invalidation; row is dropped),
   *   - the row is a stale pending state past ttl (zombie session from a
   *     crashed node),
   *   - the underlying storage errored (degrade silently, same as elsewhere).
   *
   * Non-terminal statuses (`pending_*`) are ALSO returned so a form flow
   * started on node A can continue on node B.
   */
  private async probeL2a(
    keyId: string,
    identity: SessionIdentity,
  ): Promise<SessionInitState | undefined> {
    let row: SessionInitState | null;
    try {
      row = await this.repo!.getBySessionId(
        spaceOf(identity),
        identity.userId,
        identity.agentSource,
        identity.sessionId,
      );
    } catch {
      return undefined;
    }
    if (!row) return undefined;
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
        `[session-recover] session=<redacted> L2a pending expired (status=${row.status}), invalidating`,
      );
      try {
        this.repo!.deleteBySessionId(spaceOf(identity), identity.userId, identity.agentSource, identity.sessionId);
      } catch {
        /* best-effort */
      }
      return undefined;
    }

    // Promote back to L1 so subsequent turns don't hit the repo at all.
    const normalizedRow = row.keyId === identity.sessionId
      ? row
      : { ...row, keyId: identity.sessionId };
    if (normalizedRow !== persistedRow) {
      try {
        await this.repo!.upsert(
          spaceOf(identity),
          identity.userId,
          identity.agentSource,
          identity.sessionId,
          normalizedRow,
        );
      } catch {
        // Best-effort lazy migration; returned state is already sanitized.
      }
    }
    this.states.set(keyId, normalizedRow);
    console.log(
      `[session-recover] session=<redacted> L2a hit status=${row.status} agent=${row.sessionInfo?.agent_id ? "present" : "none"} task=${row.sessionInfo?.task_id ? "present" : "none"}`,
    );
    return normalizedRow;
  }

  /** In-flight promise deduplication: same keyId → same rebuild promise. */
  private rebuildFromBinding(
    keyId: string,
    identity: SessionIdentity,
    binding: SessionBinding,
    ctx: RecoveryContext,
  ): Promise<SessionInitState | undefined> {
    const inFlightKey = recoveryIdentityKey(keyId, identity);
    const inFlight = this.recoveryInFlight.get(inFlightKey);
    if (inFlight) return inFlight;
    const p = this.doRebuild(keyId, identity, binding, ctx)
      .finally(() => this.recoveryInFlight.delete(inFlightKey));
    this.recoveryInFlight.set(inFlightKey, p);
    return p;
  }

  private async doRebuild(
    keyId: string,
    identity: SessionIdentity,
    binding: SessionBinding,
    ctx: RecoveryContext,
  ): Promise<SessionInitState | undefined> {
    // Step 4.1: never rebuild a binding under a conflicting caller identity.
    if (!bindingMatchesIdentity(binding, identity)) {
      throw new SessionIdentityConflictError();
    }

    if (!ctx.metadataClient) {
      // No client → can't recover, degrade to one-shot bypass
      console.warn("[session-recover] session=<redacted> no metadataClient, one-shot bypass");
      return {
        status: "initialized", keyId: identity.sessionId, startedAt: Date.now(),
        attemptCount: 0, bypassed: true,
        sessionInfo: null, agentDetail: null, taskDetail: null,
      };
    }

    // Step 4.2: fetch details in parallel
    const [agentR, taskR] = await Promise.allSettled([
      binding.agentId ? ctx.metadataClient.getAgent(binding.agentId) : Promise.resolve(null),
      binding.taskId ? ctx.metadataClient.getTask(binding.taskId) : Promise.resolve(null),
    ]);

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
      }
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
      }
    } else {
      if (isNotFound(taskR.reason)) taskNotFound = true;
      else anyKernelError = true;
    }

    // Step 4.3: dispatch
    if (agentNotFound) {
      console.log("[session-recover] session=<redacted> agent not found, deleting binding");
      await this.bindingRepo?.deleteBinding(spaceOf(identity), identity.userId, identity.agentSource, identity.sessionId);
      return undefined;
    }
    if (anyKernelError) {
      console.warn("[session-recover] session=<redacted> kernel unavailable, one-shot bypass");
      // Don't delete binding; return one-shot bypass to serve this request
      return {
        status: "initialized", keyId: identity.sessionId, startedAt: Date.now(),
        attemptCount: 0, bypassed: true,
        sessionInfo: null, agentDetail: null, taskDetail: null,
      };
    }
    if (taskNotFound) {
      console.log("[session-recover] session=<redacted> task not found, keeping agent");
      // Update binding to drop taskId
      await this.bindingRepo?.putBinding(
        spaceOf(identity),
        identity.userId,
        identity.agentSource,
        identity.sessionId,
        { ...binding, taskId: undefined },
      );
      taskDetail = null;
    }

    // Step 4.4: construct rebuilt state
    const sessionInfo: SessionInfo = {
      session_id: identity.sessionId,
      user_id: binding.userId || identity.userId,
      team_id: binding.teamId || "",
      agent_id: binding.agentId || "",
      task_id: taskDetail ? binding.taskId : undefined,
      space_id: identity.spaceId,
      created_at: new Date().toISOString(),
    };

    const rebuilt: SessionInitState = {
      status: "initialized",
      keyId: identity.sessionId,
      startedAt: Date.now(),
      attemptCount: 0,
      bypassed: false,
      sessionInfo,
      userId: binding.userId,
      agentDetail,
      taskDetail,
    };

    // Step 4.5: write back to L1 + L2a
    this.states.set(keyId, rebuilt);
    // await write-through 与 SessionStore.set 保持一致契约（见其头注释）：
    // 让恢复出的 rebuilt 状态在返回前已落 L2a，避免同 session 后续轮次
    // 若又打到别的 pod 时再走一次 rebuildFromBinding 的开销。
    // 防御性 catch 见 `set()` 头注释。
    if (this.repo) {
      try {
        await this.repo.upsert(spaceOf(identity), identity.userId, identity.agentSource, identity.sessionId, rebuilt);
      } catch {
        console.warn("[session-recover] L2a upsert failed during rebuild");
      }
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
      this.states.set(keyId, state);
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
    return this.rebuildFromBinding(keyId, identity, binding, ctx);
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

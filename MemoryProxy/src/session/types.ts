/**
 * Session initialization types.
 */

/**
 * 用于 `config.defaultTaskId` 兜底关联时，fetchTeamsAndAgents 在每个 team 的
 * tasks 列表头部注入的虚拟条目 label。
 *
 * 通过在源头注入而不是在 form / extractor 侧加分支，让分页 total、auto-select
 * 级联、extractor 匹配全部走既有 tasks.length 路径，避免"分页真相分散"型 bug
 * （见 docs 里 defaultTaskId 相关记录 & 2026-07-29 issue）。
 */
export const DEFAULT_TASK_LABEL = "本次不关联任务";

/**
 * Session-init 状态机：
 *   uninitialized           → 第一次进来，控制面拉 teams[]
 *   pending_asset_confirm   → 已发轮0 form（是否关联团队资产），等用户答
 *   pending_team_select     → 已选"是"，已发轮1 form（只问 team），等用户答
 *   pending_agent_task      → 已选 team，已发轮2 form（agent + task），等用户答
 *   initialized             → 已识别完整三元组，登记完成
 *
 * 当 teams.length === 1 时跳过 pending_team_select，直接进入 pending_agent_task。
 * 用户在 pending_asset_confirm 阶段选"否"时直接 bypass。
 */
export type SessionInitStatus =
  | "uninitialized"
  | "pending_asset_confirm"
  | "pending_team_select"
  | "pending_agent_task"     // legacy
  | "pending_agent_select"  // CC: selecting agent (with pagination)
  | "pending_task_select"   // CC: selecting task (with pagination)
  | "initialized"
  // legacy（一期单 form），保留以兼容旧测试 / 旧 store 数据
  | "pending_form";

export function isSessionInitStatus(value: unknown): value is SessionInitStatus {
  return value === "uninitialized"
    || value === "pending_asset_confirm"
    || value === "pending_team_select"
    || value === "pending_agent_task"
    || value === "pending_agent_select"
    || value === "pending_task_select"
    || value === "initialized"
    || value === "pending_form";
}

export interface SessionInitState {
  status: SessionInitStatus;
  keyId: string;
  startedAt: number;
  attemptCount: number;
  sessionInfo?: SessionInfo | null;
  /** User ID from auth/verify (not from header). */
  userId?: string;
  /**
   * Durable optional identity ownership for bypass states. This is never
   * injectable session context; bypass states keep `sessionInfo` null.
   */
  identityClaim?: {
    teamId?: string;
    agentId?: string;
    taskId?: string;
  };
  /** Durable layers that must receive `identityClaim` before it is accepted. */
  identityClaimPending?: {
    l2a?: true;
    l2b?: true;
  };
  /** 内核 /teams 返回的嵌套结构，用于渲染 form 与解析用户答复。 */
  cachedTeams?: TeamOption[];
  /**
   * 用户已在轮1 选定的 team_id（pending_agent_task 阶段才有意义）。
   * 轮2 form 仅渲染该 team 下的 agents/tasks；extractor 也只在该 team 内匹配。
   */
  selectedTeamId?: string;
  /**
   * Claude Code 分页模式下的当前 agent 页码（0-based）。
   *
   * 背景：Claude Code 的 AskUserQuestion 单 question 限制 2–4 选项，当某 team
   * 下 agent 数量超过 3 个时无法一次性铺开。我们沿用现有"多轮拦截"机制，每
   * 渲染 3 个 agent + 1 个"更多→"或"本次不关联"槽位，用户点"更多"则 pageIndex++
   * 再发下一页 form。详见 docs/reports/2026-06-19-cc-form-mode-experiment.md §4.4。
   *
   * - 仅 Claude Code（agentSource="claude-code"）使用，CodeBuddy 走 ask_followup_question
   *   没有 4 选项限制，无需分页。
   * - 仅在 status="pending_agent_task" 期间有效。
   * - 默认 0（首页）；每次用户选"更多"，handler 把它 +1 重发 form。
   */
  agentPageIndex?: number;
  /** CC: 用户在 agent_select 阶段选定的 agent_id（用于 pending_task_select 阶段）。 */
  selectedAgentId?: string;
  /** Resolved agent detail (cached after selection), used to inject context every request. */
  agentDetail?: AgentDetail | null;
  /** Resolved task detail (cached after selection), used to inject context every request. */
  taskDetail?: TaskDetail | null;
  /**
   * The bound identity remains monotonic, but Core authoritatively reported
   * that its Agent or Task no longer exists. Consumers must fail closed before
   * capability, injection, extraction, bridge, or model work; `sessionInfo`
   * is retained only as an ownership claim for conflict checks and restart.
   */
  contextSuppressed?: boolean;
  /**
   * 用户明确选择了"跳过"（本次不关联）。状态设为 initialized 防止重复弹窗，
   * 但 agentDetail/taskDetail 为 null，后续请求只 strip 不 inject。
   */
  bypassed?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isOptionalId(value: unknown): boolean {
  return value === undefined || (typeof value === "string" && value.length > 0);
}

function isPersistedIdentityClaim(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return isOptionalId(value.teamId)
    && isOptionalId(value.agentId)
    && isOptionalId(value.taskId);
}

function isPersistedIdentityClaimPending(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const l2a = value.l2a;
  const l2b = value.l2b;
  return (l2a === undefined || l2a === true)
    && (l2b === undefined || l2b === true)
    && (l2a === true || l2b === true);
}

function isPersistedSessionInfo(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return typeof value.session_id === "string"
    && value.session_id.length > 0
    && typeof value.team_id === "string"
    && value.team_id.length > 0
    && typeof value.agent_id === "string"
    && value.agent_id.length > 0
    && typeof value.user_id === "string"
    && value.user_id.length > 0
    && isOptionalId(value.task_id)
    && isOptionalId(value.space_id)
    && value.user_key === undefined;
}

function isPersistedAgentDetail(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (!isRecord(value)) return false;
  return typeof value.id === "string"
    && value.id.length > 0
    && typeof value.name === "string"
    && isOptionalString(value.description)
    && isOptionalString(value.prompt);
}

function isPersistedTaskDetail(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (!isRecord(value)) return false;
  return typeof value.id === "string"
    && value.id.length > 0
    && typeof value.name === "string"
    && isOptionalString(value.description)
    && isOptionalString(value.goal);
}

function isPersistedCachedTeams(value: unknown): boolean {
  if (value === undefined) return true;
  if (!Array.isArray(value)) return false;
  return value.every((team) => {
    if (!isRecord(team)) return false;
    return typeof team.team_id === "string"
      && team.team_id.length > 0
      && typeof team.team_name === "string"
      && Array.isArray(team.agents)
      && team.agents.every((agent) => isRecord(agent)
        && typeof agent.agent_id === "string"
        && agent.agent_id.length > 0
        && typeof agent.agent_name === "string"
        && isOptionalString(agent.description))
      && Array.isArray(team.tasks)
      && team.tasks.every((task) => isRecord(task)
        && typeof task.task_id === "string"
        && task.task_id.length > 0
        && typeof task.task_name === "string"
        && (task.isDefault === undefined || typeof task.isDefault === "boolean"));
  });
}

/** Shallow ownership proof used only to bound deletion of a pre-v2 row. */
export function isLegacyPersistedSessionOwnershipProof(
  value: unknown,
): value is SessionInitState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  return isSessionInitStatus(state.status)
    && (state.keyId === undefined || typeof state.keyId === "string")
    && (state.startedAt === undefined
      || (typeof state.startedAt === "number" && Number.isFinite(state.startedAt)))
    && (state.attemptCount === undefined
      || (typeof state.attemptCount === "number"
        && Number.isInteger(state.attemptCount)
        && state.attemptCount >= 0))
    && (state.userId === undefined || typeof state.userId === "string")
    && (state.sessionInfo === undefined
      || state.sessionInfo === null
      || (typeof state.sessionInfo === "object" && !Array.isArray(state.sessionInfo)))
    && (state.bypassed === undefined || typeof state.bypassed === "boolean")
    && (state.contextSuppressed === undefined || typeof state.contextSuppressed === "boolean");
}

const persistedSessionMigrations = new WeakSet<SessionInitState>();

function markPersistedSessionMigration(state: SessionInitState): SessionInitState {
  persistedSessionMigrations.add(state);
  return state;
}

/** Non-persisted provenance consumed by SessionStore for a lazy safe rewrite. */
export function persistedSessionNeedsMigration(state: SessionInitState): boolean {
  return persistedSessionMigrations.has(state);
}

/** Strict runtime boundary for canonical v2 state before identity checks. */
export function isPersistedSessionInitState(value: unknown): value is SessionInitState {
  if (!isRecord(value)) return false;
  const state = value;
  if (
    !isSessionInitStatus(state.status)
    || typeof state.keyId !== "string"
    || state.keyId.length === 0
    || typeof state.startedAt !== "number"
    || !Number.isFinite(state.startedAt)
    || typeof state.attemptCount !== "number"
    || !Number.isSafeInteger(state.attemptCount)
    || state.attemptCount < 0
    || typeof state.userId !== "string"
    || state.userId.length === 0
    || (state.bypassed !== undefined && typeof state.bypassed !== "boolean")
    || (state.contextSuppressed !== undefined && typeof state.contextSuppressed !== "boolean")
    || !isOptionalId(state.selectedTeamId)
    || !isOptionalId(state.selectedAgentId)
    || !isPersistedCachedTeams(state.cachedTeams)
    || (state.agentPageIndex !== undefined
      && (typeof state.agentPageIndex !== "number"
        || !Number.isSafeInteger(state.agentPageIndex)
        || state.agentPageIndex < 0))
    || !isPersistedAgentDetail(state.agentDetail)
    || !isPersistedTaskDetail(state.taskDetail)
    || (state.identityClaim !== undefined && !isPersistedIdentityClaim(state.identityClaim))
    || (state.identityClaimPending !== undefined
      && (!isPersistedIdentityClaimPending(state.identityClaimPending)
        || !isPersistedIdentityClaim(state.identityClaim)))
  ) return false;

  if (state.status !== "initialized") {
    return state.contextSuppressed !== true
      && state.bypassed !== true
      && (state.sessionInfo === undefined || state.sessionInfo === null)
      && (state.agentDetail === undefined || state.agentDetail === null)
      && (state.taskDetail === undefined || state.taskDetail === null)
      && state.identityClaim === undefined
      && state.identityClaimPending === undefined;
  }
  if (state.bypassed === true) {
    return state.sessionInfo === null
      && state.agentDetail === null
      && state.taskDetail === null
      && state.contextSuppressed !== true;
  }
  return state.identityClaim === undefined
    && state.identityClaimPending === undefined
    && isPersistedSessionInfo(state.sessionInfo);
}

/**
 * Normalize the one pre-schema canonical shape that is safe to migrate: an
 * initialized bypass carrying no injectable session, agent, or task context.
 */
export function normalizePersistedSessionInitState(
  value: unknown,
): SessionInitState | null {
  if (isPersistedSessionInitState(value)) return value;
  if (
    isRecord(value)
    && isRecord(value.sessionInfo)
    && typeof value.sessionInfo.user_key === "string"
  ) {
    const { user_key: _credential, ...safeSessionInfo } = value.sessionInfo;
    const safeState = { ...value, sessionInfo: safeSessionInfo };
    if (isPersistedSessionInitState(safeState)) {
      return markPersistedSessionMigration(safeState);
    }
  }
  if (!isLegacyPersistedSessionOwnershipProof(value)) return null;
  const state = value as SessionInitState;
  if (
    state.status !== "initialized"
    || state.bypassed !== true
    || typeof state.keyId !== "string"
    || state.keyId.length === 0
    || typeof state.userId !== "string"
    || state.userId.length === 0
    || (state.sessionInfo !== undefined && state.sessionInfo !== null)
    || (state.agentDetail !== undefined && state.agentDetail !== null)
    || (state.taskDetail !== undefined && state.taskDetail !== null)
    || state.contextSuppressed === true
    || !isOptionalId(state.selectedTeamId)
    || !isOptionalId(state.selectedAgentId)
    || !isPersistedCachedTeams(state.cachedTeams)
    || (state.agentPageIndex !== undefined
      && (typeof state.agentPageIndex !== "number"
        || !Number.isSafeInteger(state.agentPageIndex)
        || state.agentPageIndex < 0))
    || (state.identityClaim !== undefined && !isPersistedIdentityClaim(state.identityClaim))
    || (state.identityClaimPending !== undefined
      && (!isPersistedIdentityClaimPending(state.identityClaimPending)
        || !isPersistedIdentityClaim(state.identityClaim)))
  ) return null;
  return markPersistedSessionMigration({
    ...state,
    startedAt: typeof state.startedAt === "number" && Number.isFinite(state.startedAt)
      ? state.startedAt
      : 0,
    attemptCount: typeof state.attemptCount === "number"
      && Number.isSafeInteger(state.attemptCount)
      && state.attemptCount >= 0
      ? state.attemptCount
      : 0,
    sessionInfo: null,
    agentDetail: null,
    taskDetail: null,
  });
}

/**
 * 来自控制面 `/api/v1/proxy/resources` 的嵌套结构：
 *   teams[] → agents[]  +  tasks[]
 *
 * agents 和 tasks 是该 team 下的完整列表，平级展示。
 * session init 时用户自由选择 agent + task，task_agents 关联关系
 * 在 init 完成后由页面管理，不影响 init 时的选项列表。
 */
export interface TaskInTeam {
  task_id: string;
  task_name: string;
  /**
   * 标识该条目是 `config.defaultTaskId` 兜底注入的虚拟 task（source: proxy）
   * 而非内核里真实存在的 task。form 侧看到该字段会跳过 `(id-suffix)` 的拼接，
   * 显示更干净的 label —— 反正虚拟 task 只有一个，不存在重名歧义。
   */
  isDefault?: boolean;
}

export interface AgentInTeam {
  agent_id: string;
  agent_name: string;
  description?: string;
}

export interface TeamOption {
  team_id: string;
  team_name: string;
  agents: AgentInTeam[];
  tasks: TaskInTeam[];
}

/** @deprecated 旧扁平结构，保留以兼容旧测试；新代码用 TeamOption。 */
export interface AgentOption {
  id: string;
  name: string;
  description?: string;
  team_id?: string;
}

/** @deprecated 旧扁平结构，保留以兼容旧测试；新代码用 TaskInTeam。 */
export interface TaskOption {
  id: string;
  name: string;
  description?: string;
}

/** Full Agent detail (fetched after selection) — content injected into system prompt. */
export interface AgentDetail {
  id: string;
  name: string;
  description?: string;
  /** The Agent's system-level prompt / persona, appended to system message. */
  prompt?: string;
}

/** Full Task detail (fetched after selection) — content injected into system prompt. */
export interface TaskDetail {
  id: string;
  name: string;
  description?: string;
  /** Optional structured goal/acceptance criteria text. */
  goal?: string;
}

/**
 * User-facing init data — agent + task selection (from dropdown).
 * team_id and user_id are sourced from the selected agent and the request
 * header respectively; not part of the user-facing form.
 */
export interface SessionInitData {
  agent_id: string;
  /** User-selected task (index into cachedTasks, or raw task_id string). */
  task_id?: string;
}

/** Full init data sent to register session. */
export interface SessionRegistrationData {
  team_id: string;
  agent_id: string;
  user_id: string;
  task_id?: string;
  session_id: string;
}

/**
 * Subset of the `POST /agent-sessions` response we consume.
 * The real backend returns more (created_at, updated_at, …) — we keep the
 * shape loose with `permissions` etc. optional so future fields don't break us.
 */
export interface SessionInfo {
  session_id: string;
  team_id: string;
  agent_id: string;
  user_id: string;
  task_id?: string;
  /** @deprecated Legacy persisted field. New state uses request-local custom.userKey. */
  user_key?: string;
  /**
   * Kernel instance / space ID (e.g. `mem-example001`) extracted from the request
   * URL path `/proxy/<spaceId>/...`. Stored so injectors can build a
   * MetadataClient with the correct `x-tdai-service-id` header (kernel routes
   * tenants by this header — a static config value would return `invalid_user_key`).
   */
  space_id?: string;
  created_at?: string;
  expires_at?: string;
  identity_verified?: boolean;
  permissions?: {
    user_in_team?: boolean;
    user_in_task?: boolean;
    agent_assigned_to_task?: boolean;
    repo_in_team?: boolean;
  };
  fixed_asset_summary?: {
    count: number;
    total_est_tokens: number;
  };
}

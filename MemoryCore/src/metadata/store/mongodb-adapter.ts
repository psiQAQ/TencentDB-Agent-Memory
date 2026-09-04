/**
 * MongoDB 实现的 IMetadataStore。
 *
 * 对应设计文档 §6.1 / §6.4（MongoDB 事务处理）。
 * 复合写入（createTeam + admin、createTask + linkAgents、setAgentFixedAssets 全量替换、
 * deleteAssets 级联）使用 multi-document transaction（需副本集）保证原子性。
 *
 * 集合命名与 SQLite 表对齐（meta_*）。读操作统一投影掉 `_id`。
 */

import type {
  MongoClient,
  Db,
  Collection,
  ClientSession,
  Document,
} from "mongodb";
import { createHash } from "node:crypto";
import { mapTeamMemberWithProfile } from "./team-member-view.js";
import { generateId, generateRelationId, ID_PREFIX } from "../utils/id-generator.js";
import {
  isMongoRelationIdCollision,
  runWithGeneratedRelationId,
  RELATION_ID_RETRY_LIMIT,
} from "./relation-id-insert.js";
import { generateUserKey } from "../utils/crypto.js";
import { isUserKeyExpired } from "../utils/user-key.js";
import type {
  UserEntity,
  UserKeyEntity,
  TeamEntity,
  TeamMemberEntity,
  TeamMemberView,
  AgentEntity,
  TaskEntity,
  TaskAgentEntity,
  ParticipationLogEntity,
  AppendParticipationLogInput,
  ParticipationLogFilter,
  AssetEntity,
  FixedAssetBindingEntity,
  AclEntity,
  CreateUserInput,
  CreateUserKeyInput,
  CreateTeamInput,
  AddTeamMemberInput,
  CreateAgentInput,
  CreateTaskInput,
  CreateAssetInput,
  FixedAssetBindingInput,
  GrantAclInput,
  AgentFilter,
  TaskFilter,
  AssetFilter,
  BatchDeleteResult,
  UserOwnedResourceCounts,
  UserOwnedAssetCounts,
  MemberRemovalResult,
  SafeUserDeleteResult,
  TeamDeletePreview,
  OwnershipTransferInput,
  SkillOwnershipTransferInput,
  OwnershipTransferResult,
  IntegrityFinding,
  UserOwnedResourceDependency,
  UserOwnedResourceFilter,
  ListPage,
  PaginationParams,
  InstanceUserListFilter,
  AgentFixedAssetCountRow,
  AssetType,
  ConfigParamEntity,
  UpsertConfigParamInput,
  ListConfigParamsFilter,
} from "../types.js";
import { DEFAULT_PAGINATION } from "../pagination.js";
import { buildChatMemoryAssetId } from "../utils/chat-memory-asset.js";
import { DuplicateUserKeyError, LifecycleTransactionsRequiredError } from "./interface.js";

function nowIso(): string {
  return new Date().toISOString();
}

const PK_RETRY_LIMIT = 3;

/** Returns true if the error is a MongoDB E11000 duplicate key on a primary key (xxx_id) field. */
function isPkCollision(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: number; keyPattern?: Record<string, unknown> };
  if (e.code !== 11000) return false;
  const keys = e.keyPattern ? Object.keys(e.keyPattern) : [];
  return keys.some((k) => k.endsWith("_id") && k !== "_id");
}

function isStorePkCollision(err: unknown): boolean {
  return isPkCollision(err) || isMongoRelationIdCollision(err);
}

/** E11000 on meta_user_keys.key_value (调用方显式指定 default_key_value 时并发命中)。 */
function isUserKeyValueCollision(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: number; keyPattern?: Record<string, unknown> };
  return e.code === 11000 && !!e.keyPattern && "key_value" in e.keyPattern;
}

const PROJECT_NO_ID = { projection: { _id: 0 } } as const;

export interface MongoMetadataStoreOptions {
  /** 是否启用多文档事务（需副本集）。默认 true。 */
  useTransactions?: boolean;
  /** false 时 close() 不关闭 client（MetadataStorePool 共享连接）。 */
  ownsClient?: boolean;
}

export class MongoMetadataStore implements IMetadataStore {
  private readonly client: MongoClient;
  private readonly db: Db;
  private readonly useTransactions: boolean;
  private readonly ownsClient: boolean;

  constructor(client: MongoClient, dbName: string, opts: MongoMetadataStoreOptions = {}) {
    this.client = client;
    this.db = client.db(dbName);
    this.useTransactions = opts.useTransactions ?? true;
    this.ownsClient = opts.ownsClient ?? true;
    if (!this.useTransactions) {
      console.warn(
        "[META-STORE] WARNING: MongoDB transactions disabled (useTransactions=false). " +
        "Composite writes (createTeam, createTask+linkAgents, setFixedAssets) will NOT be atomic. " +
        "Production deployments MUST use a replica set with transactions enabled.",
      );
    }
  }

  private col<T extends Document = Document>(name: string): Collection<T> {
    return this.db.collection<T>(name);
  }

  private async paginatedFind<T>(
    col: string,
    filter: Document,
    pagination: PaginationParams | null | undefined,
    sort: Document,
    mapper: (doc: Document) => T,
  ): Promise<ListPage<T>> {
    const c = this.col(col);
    const total = await c.countDocuments(filter);
    const p = pagination ?? DEFAULT_PAGINATION;
    let cursor = c.find(filter, PROJECT_NO_ID).sort(sort).skip(p.offset).limit(p.limit);
    const docs = await cursor.toArray();
    return { items: docs.map(mapper), total };
  }

  private async paginatedJoin<T>(
    fromCol: string,
    match: Document,
    lookupFrom: string,
    localField: string,
    foreignField: string,
    sort: Document,
    pagination: PaginationParams | null | undefined,
    joinedMatch?: Document,
  ): Promise<ListPage<T>> {
    const base: Document[] = [
      { $match: match },
      { $lookup: { from: lookupFrom, localField, foreignField, as: "_joined" } },
      { $unwind: "$_joined" },
      { $replaceRoot: { newRoot: "$_joined" } },
      { $project: { _id: 0 } },
    ];
    if (joinedMatch && Object.keys(joinedMatch).length > 0) {
      base.push({ $match: joinedMatch });
    }
    const c = this.col(fromCol);
    const countResult = await c.aggregate([...base, { $count: "total" }]).toArray();
    const total = (countResult[0] as { total?: number })?.total ?? 0;
    const p = pagination ?? DEFAULT_PAGINATION;
    const pipeline: Document[] = [...base, { $sort: sort }, { $skip: p.offset }, { $limit: p.limit }];
    const docs = await c.aggregate(pipeline).toArray();
    return { items: docs as T[], total };
  }

  async init(): Promise<void> {
    // ── meta_users ──
    await this.ensureIndex("meta_users", { user_id: 1 }, { unique: true });
    await this.ensureIndex("meta_users",
      { user_type: 1 },
      { unique: true, partialFilterExpression: { user_type: "system_admin" } },
    );
    await this.ensureIndex("meta_users", { auth_provider: 1, username: 1 });
    await this.ensureIndex("meta_users",
      { auth_provider: 1, external_id: 1 },
      { sparse: true },
    );
    await this.ensureIndex("meta_users", { email: 1 }, { sparse: true });
    await this.ensureIndex("meta_users", { created_at: -1 });

    // ── meta_user_keys ──
    await this.ensureIndex("meta_user_keys", { key_id: 1 }, { unique: true });
    await this.ensureIndex("meta_user_keys", { key_value: 1 }, { unique: true });
    await this.ensureIndex("meta_user_keys", { user_id: 1, status: 1 });
    await this.ensureIndex("meta_user_keys", { user_id: 1, created_at: -1 });

    // ── meta_teams ──
    await this.ensureIndex("meta_teams", { team_id: 1 }, { unique: true });
    await this.ensureIndex("meta_teams", { created_at: -1 });

    // ── meta_team_members ──
    await this.ensureIndex("meta_team_members", { team_id: 1, user_id: 1 }, { unique: true });
    await this.ensureIndex("meta_team_members", { team_id: 1, status: 1, joined_at: -1 });
    await this.ensureIndex("meta_team_members", { user_id: 1, status: 1 });

    // ── meta_agents ──
    await this.ensureIndex("meta_agents", { agent_id: 1 }, { unique: true });
    await this.ensureIndex("meta_agents", { team_id: 1, status: 1, created_at: -1 });
    await this.ensureIndex("meta_agents", { owner_user_id: 1, status: 1, created_at: -1 });

    // ── meta_tasks ──
    await this.ensureIndex("meta_tasks", { task_id: 1 }, { unique: true });
    await this.ensureIndex("meta_tasks", { team_id: 1, status: 1, created_at: -1 });
    await this.ensureIndex("meta_tasks", { creator_user_id: 1, status: 1, created_at: -1 });
    await this.ensureIndex("meta_tasks", { owner_user_id: 1, status: 1, created_at: -1 });
    await this.ensureIndex("meta_lifecycle_operations", { idempotency_key: 1, resource_type: 1, resource_id: 1 }, { unique: true });
    await this.ensureIndex("meta_integrity_findings", { fingerprint: 1 }, { unique: true });
    await this.ensureIndex("meta_tombstones", { entity_type: 1, entity_id: 1 }, { unique: true });
    await this.col("meta_tasks").updateMany(
      { $or: [{ owner_user_id: { $exists: false } }, { owner_user_id: null }, { owner_user_id: "" }] } as Document,
      [{ $set: { owner_user_id: "$creator_user_id" } }] as Document[],
    );

    // ── meta_task_agents ──
    await this.ensureIndex("meta_task_agents", { task_id: 1, agent_id: 1 }, { unique: true });
    await this.ensureIndex("meta_task_agents", { task_id: 1, status: 1, created_at: -1 });

    // ── meta_participation_logs ──
    await this.ensureIndex("meta_participation_logs", { team_id: 1, created_at: -1 }, { name: "ix_pl_team_created" });
    await this.ensureIndex(
      "meta_participation_logs",
      { team_id: 1, task_id: 1, agent_id: 1, created_at: -1 },
      { name: "ix_pl_team_task_agent_created" },
    );
    await this.ensureIndex(
      "meta_participation_logs",
      { team_id: 1, user_id: 1, created_at: -1 },
      { name: "ix_pl_team_user_created" },
    );
    await this.ensureIndex(
      "meta_participation_logs",
      { team_id: 1, task_id: 1, agent_id: 1, user_id: 1, created_at: -1 },
      { name: "ix_pl_team_dims_created" },
    );

    // ── meta_assets ──
    await this.ensureIndex("meta_assets", { asset_id: 1 }, { unique: true });
    await this.ensureIndex("meta_assets", { team_id: 1, status: 1, created_at: -1 });

    // ── meta_agent_fixed_assets ──
    await this.ensureIndex("meta_agent_fixed_assets", { agent_id: 1, asset_id: 1 }, { unique: true });
    await this.ensureIndex("meta_agent_fixed_assets", { agent_id: 1, priority: -1, created_at: -1 });

    // ── meta_asset_acl ──
    await this.ensureIndex("meta_asset_acl",
      { asset_id: 1, subject_type: 1, subject_id: 1, permission: 1 },
      { unique: true },
    );
    await this.ensureIndex("meta_asset_acl", { id: 1 }, { unique: true });
    await this.ensureIndex("meta_asset_acl", { asset_id: 1, created_at: -1 });
    await this.ensureIndex("meta_asset_acl", { subject_type: 1, subject_id: 1, created_at: -1 });

    // ── meta_config_params ──
    await this.ensureIndex("meta_config_params",
      { scope: 1, user_id: 1, module: 1, param_name: 1 },
      { unique: true },
    );
    await this.ensureIndex("meta_config_params", { module: 1 });
    await this.ensureIndex("meta_config_params",
      { user_id: 1, module: 1 },
      { partialFilterExpression: { scope: "user" } },
    );

    await this.migrateLegacyUserKeys();
  }

  /**
   * 安全创建索引：索引创建失败不会中断初始化流程，但会记录日志便于线上排查。
   */
  private async ensureIndex(
    colName: string,
    spec: Record<string, number>,
    options?: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.col(colName).createIndex(spec, options);
    } catch (err: unknown) {
      const code = (err as { code?: number })?.code;
      const msg = (err as { errmsg?: string })?.errmsg
        ?? (err instanceof Error ? err.message : String(err));
      const specStr = `${colName}(${JSON.stringify(spec)})`;
      if (code === 85 || code === 86) {
        // 索引已存在但定义不同（如 options 变化），索引创建被跳过，功能不受影响
        console.warn(`[mongodb-adapter] ensureIndex skipped (index exists with different options) ${specStr}: ${msg}`);
      } else if (code === 11000) {
        // 存量数据违反 unique 约束，索引创建失败，该字段的唯一性校验无法生效
        console.warn(`[mongodb-adapter] ensureIndex skipped (duplicate data violates unique constraint) ${specStr}: ${msg}`);
      } else {
        // 非预期错误（网络超时、权限不足等），需要人工排查
        console.warn(`[mongodb-adapter] ensureIndex failed (unexpected error, code=${code}) ${specStr}: ${msg}`);
      }
    }
  }

  private async migrateLegacyUserKeys(): Promise<void> {
    const users = await this.col<UserEntity & { user_key?: string }>("meta_users").find({}, PROJECT_NO_ID).toArray();
    for (const u of users) {
      const existing = await this.col<UserKeyEntity>("meta_user_keys").findOne({ user_id: u.user_id } as Document, PROJECT_NO_ID);
      if (existing) continue;
      const legacyKey = (u as { user_key?: string }).user_key;
      if (!legacyKey) continue;
      await this.insertUserKeyDoc({
        user_id: u.user_id,
        key_value: legacyKey,
        is_default: true,
        created_at: u.created_at,
      });
    }
  }

  private async insertUserKeyDoc(input: {
    user_id: string;
    key_value: string;
    name?: string | null;
    is_default?: boolean;
    expires_at?: string | null;
    created_at?: string;
    metadata_json?: string;
  }): Promise<UserKeyEntity> {
    const now = input.created_at ?? nowIso();
    for (let attempt = 0; attempt < PK_RETRY_LIMIT; attempt++) {
      const doc: UserKeyEntity = {
        key_id: generateId(ID_PREFIX.userKey),
        user_id: input.user_id,
        key_value: input.key_value,
        name: input.name ?? null,
        status: "active",
        is_default: input.is_default ?? false,
        last_used_at: null,
        expires_at: input.expires_at ?? null,
        created_at: now,
        revoked_at: null,
        metadata_json: input.metadata_json ?? "{}",
      };
      try {
        await this.col("meta_user_keys").insertOne({ ...doc });
        return doc;
      } catch (err) {
        if (isPkCollision(err)) continue;
        throw err;
      }
    }
    throw new Error("user key PK collision after max retries");
  }

  async close(): Promise<void> {
    if (this.ownsClient) {
      await this.client.close();
    }
  }

  private async withTx<T>(fn: (session?: ClientSession) => Promise<T>): Promise<T> {
    if (!this.useTransactions) return fn(undefined);
    const session = this.client.startSession();
    try {
      let result!: T;
      await session.withTransaction(async () => {
        result = await fn(session);
      });
      return result;
    } finally {
      await session.endSession();
    }
  }

  // ============================================================
  // User
  // ============================================================
  async createUser(input: CreateUserInput): Promise<UserEntity> {
    const now = nowIso();
    const defaultKeyValue = input.default_key_value ?? generateUserKey();
    for (let attempt = 0; attempt < PK_RETRY_LIMIT; attempt++) {
      const doc: UserEntity = {
        user_id: input.user_id ?? generateId(ID_PREFIX.user),
        password: input.password ?? null,
        auth_provider: input.auth_provider,
        external_id: input.external_id,
        username: input.username,
        display_name: input.display_name ?? null,
        raw_profile_json: input.raw_profile_json ?? "{}",
        status: input.status ?? "active",
        user_type: input.user_type ?? "normal",
        created_at: now,
        updated_at: now,
        metadata_json: input.metadata_json ?? "{}",
      };
      if (input.email) {
        doc.email = input.email;
      }
      try {
        await this.col("meta_users").insertOne({ ...doc });
        await this.insertUserKeyDoc({
          user_id: doc.user_id,
          key_value: defaultKeyValue,
          is_default: true,
          created_at: now,
        });
        return doc;
      } catch (err) {
        // 调用方显式指定 default_key_value 命中 UNIQUE:翻译业务错(HTTP 409),不 retry。
        if (isUserKeyValueCollision(err)) {
          throw new DuplicateUserKeyError(defaultKeyValue);
        }
        if (isPkCollision(err) && !input.user_id) continue;
        throw err;
      }
    }
    throw new Error("PK collision after max retries");
  }

  async getUserById(userId: string): Promise<UserEntity | null> {
    return this.col<UserEntity>("meta_users").findOne({ user_id: userId } as Document, PROJECT_NO_ID) as Promise<UserEntity | null>;
  }

  async getUserByKey(userKey: string): Promise<UserEntity | null> {
    const keyDoc = await this.col<UserKeyEntity>("meta_user_keys").findOne(
      { key_value: userKey, status: "active" } as Document,
      PROJECT_NO_ID,
    ) as UserKeyEntity | null;
    if (!keyDoc || isUserKeyExpired(keyDoc.expires_at)) return null;
    await this.touchUserKeyUsage(keyDoc.key_id);
    return this.getUserById(keyDoc.user_id);
  }

  async getDefaultUserKey(userId: string): Promise<UserKeyEntity | null> {
    return this.col<UserKeyEntity>("meta_user_keys").findOne(
      { user_id: userId, is_default: true, status: "active" } as Document,
      PROJECT_NO_ID,
    ) as Promise<UserKeyEntity | null>;
  }

  async getUserByUsername(authProvider: string, username: string): Promise<UserEntity | null> {
    return this.col<UserEntity>("meta_users").findOne(
      { auth_provider: authProvider, username } as Document,
      PROJECT_NO_ID,
    ) as Promise<UserEntity | null>;
  }

  async getUserByEmail(email: string): Promise<UserEntity | null> {
    return this.col<UserEntity>("meta_users").findOne({ email } as Document, PROJECT_NO_ID) as Promise<UserEntity | null>;
  }

  async getUserByExternalId(authProvider: string, externalId: string): Promise<UserEntity | null> {
    return this.col<UserEntity>("meta_users").findOne(
      { auth_provider: authProvider, external_id: externalId } as Document,
      PROJECT_NO_ID,
    ) as Promise<UserEntity | null>;
  }

  async updateUser(userId: string, patch: Partial<UserEntity>): Promise<UserEntity | null> {
    const allowed = ["password", "display_name", "email", "raw_profile_json", "status", "metadata_json", "username"];
    await this.patchOne("meta_users", { user_id: userId }, patch, allowed, true);
    return this.getUserById(userId);
  }

  async deleteUsers(userIds: string[]): Promise<BatchDeleteResult> {
    const result = await this.batchDelete("meta_users", "user_id", userIds);
    if (result.deleted_ids.length > 0) {
      await this.col("meta_user_keys").deleteMany({ user_id: { $in: result.deleted_ids } } as Document);
      await this.col("meta_team_members").deleteMany({ user_id: { $in: result.deleted_ids } } as Document);
      await this.col("meta_asset_acl").deleteMany({ subject_type: "user", subject_id: { $in: result.deleted_ids } } as Document);
    }
    return result;
  }

  async deleteUsersSafely(userIds: string[]): Promise<SafeUserDeleteResult> {
    if (!this.useTransactions) throw new LifecycleTransactionsRequiredError();
    const uniqueIds = [...new Set(userIds)];
    return this.withTx(async (session) => {
      const users = await this.col<UserEntity>("meta_users").find(
        { user_id: { $in: uniqueIds } } as Document,
        { ...PROJECT_NO_ID, session },
      ).toArray();
      const adminCount = await this.col("meta_users").countDocuments({ user_type: "system_admin" }, { session });
      const memberships = await this.col<TeamMemberEntity>("meta_team_members").find(
        { user_id: { $in: uniqueIds } } as Document,
        { ...PROJECT_NO_ID, session },
      ).toArray();
      const deletingAdmins = users.filter((user) => user.user_type === "system_admin").length;
      if (deletingAdmins > 0 && adminCount - deletingAdmins < 1) {
        return { deleted: null, blockers: [], last_system_admin: true };
      }
      const blockers: SafeUserDeleteResult["blockers"] = [];
      for (const user of users) {
        const q = { owner_user_id: user.user_id };
        const teams = await this.col("meta_teams").countDocuments(q, { session });
        const agents = await this.col("meta_agents").countDocuments(q, { session });
        const tasks = await this.col("meta_tasks").countDocuments(q, { session });
        const assets = await this.col("meta_assets").countDocuments(q, { session });
        if (teams || agents || tasks || assets) blockers.push({
          user_id: user.user_id, counts: { teams, agents, tasks, assets },
        });
      }
      if (blockers.length > 0) return { deleted: null, blockers, last_system_admin: false };

      const now = nowIso();
      await this.col("meta_users").updateMany(
        { user_id: { $in: users.map((user) => user.user_id) } }, { $set: { updated_at: now } }, { session },
      );
      const teamIds = [...new Set(memberships.map((member) => member.team_id))];
      if (teamIds.length > 0) {
        await this.col("meta_teams").updateMany(
          { team_id: { $in: teamIds } }, { $set: { updated_at: now } }, { session },
        );
      }
      const existingIds = users.map((user) => user.user_id);
      await this.col("meta_user_keys").deleteMany({ user_id: { $in: existingIds } }, { session });
      await this.col("meta_team_members").deleteMany({ user_id: { $in: existingIds } }, { session });
      await this.col("meta_asset_acl").deleteMany({ subject_type: "user", subject_id: { $in: existingIds } }, { session });
      await this.col("meta_users").deleteMany({ user_id: { $in: existingIds } }, { session });
      const failed = uniqueIds.filter((id) => !existingIds.includes(id)).map((id) => ({ id, reason: "not_found" }));
      return {
        deleted: { deleted_ids: existingIds, failed },
        blockers: [],
        last_system_admin: false,
      };
    });
  }

  async listUsersByTeam(
    teamId: string,
    pagination?: PaginationParams | null,
    filter?: InstanceUserListFilter,
  ): Promise<ListPage<UserEntity>> {
    const joinedMatch: Document = {};
    if (filter?.user_ids?.length) joinedMatch.user_id = { $in: filter.user_ids };
    if (filter?.username) {
      joinedMatch.username = filter.username;
    }
    return this.paginatedJoin<UserEntity>(
      "meta_team_members",
      { team_id: teamId, status: "active" },
      "meta_users",
      "user_id",
      "user_id",
      { created_at: -1 },
      pagination,
      joinedMatch,
    );
  }

  async listUsers(
    pagination?: PaginationParams | null,
    filter?: InstanceUserListFilter,
  ): Promise<ListPage<UserEntity>> {
    const q: Document = {};
    if (filter?.status) q.status = filter.status;
    if (filter?.user_type) q.user_type = filter.user_type;
    if (filter?.user_ids?.length) q.user_id = { $in: filter.user_ids };
    if (filter?.username) {
      q.username = filter.username;
    }
    return this.paginatedFind("meta_users", q, pagination, { created_at: -1 }, (d) => d as UserEntity);
  }

  async countUsers(): Promise<number> {
    return this.col("meta_users").countDocuments({});
  }

  async countSystemAdmins(): Promise<number> {
    return this.col("meta_users").countDocuments({ user_type: "system_admin" } as Document);
  }

  async countTeams(): Promise<number> {
    return this.col("meta_teams").countDocuments({});
  }

  async getUserOwnedResourceCounts(userId: string, teamId?: string): Promise<UserOwnedResourceCounts> {
    const scoped = (ownerField: "owner_user_id"): Document => ({
      [ownerField]: userId,
      ...(teamId ? { team_id: teamId } : {}),
    });
    const [teams, agents, tasks, assets] = await Promise.all([
      this.col("meta_teams").countDocuments(scoped("owner_user_id")),
      this.col("meta_agents").countDocuments(scoped("owner_user_id")),
      this.col("meta_tasks").countDocuments(scoped("owner_user_id")),
      this.col("meta_assets").countDocuments(scoped("owner_user_id")),
    ]);
    return { teams, agents, tasks, assets };
  }

  async getUserOwnedAssetCounts(userId: string, teamId?: string): Promise<UserOwnedAssetCounts> {
    const rows = await this.col("meta_assets").aggregate([
      { $match: { owner_user_id: userId, ...(teamId ? { team_id: teamId } : {}) } },
      { $group: { _id: "$asset_type", c: { $sum: 1 } } },
    ]).toArray();
    const result: UserOwnedAssetCounts = { skill: 0, llm_wiki: 0, code_graph: 0, chat_memory: 0, other: 0 };
    for (const row of rows) {
      const key = String(row._id);
      if (key in result) result[key as keyof UserOwnedAssetCounts] = Number(row.c);
      else result.other += Number(row.c);
    }
    return result;
  }

  async listUserOwnedResources(
    userId: string,
    pagination?: PaginationParams | null,
    filter?: UserOwnedResourceFilter,
  ): Promise<ListPage<UserOwnedResourceDependency>> {
    const scope = filter?.team_id ? { team_id: filter.team_id } : {};
    const [teams, agents, tasks, assets] = await Promise.all([
      this.col<TeamEntity>("meta_teams").find({ owner_user_id: userId, ...scope }, { projection: PROJECT_NO_ID }).toArray(),
      this.col<AgentEntity>("meta_agents").find({ owner_user_id: userId, ...scope }, { projection: PROJECT_NO_ID }).toArray(),
      this.col<TaskEntity>("meta_tasks").find({ owner_user_id: userId, ...scope }, { projection: PROJECT_NO_ID }).toArray(),
      this.col<AssetEntity>("meta_assets").find({ owner_user_id: userId, ...scope }, { projection: PROJECT_NO_ID }).toArray(),
    ]);
    const raw = [
      ...teams.map((item) => ({
        resource_type: "team" as const,
        resource_id: item.team_id,
        team_id: item.team_id,
        name: item.name,
        status: item.status,
        asset_type: null,
        created_at: item.created_at,
      })),
      ...agents.map((item) => ({
        resource_type: "agent" as const,
        resource_id: item.agent_id,
        team_id: item.team_id,
        name: item.name,
        status: item.status,
        asset_type: null,
        created_at: item.created_at,
      })),
      ...tasks.map((item) => ({
        resource_type: "task" as const,
        resource_id: item.task_id,
        team_id: item.team_id,
        name: item.title,
        status: item.status,
        asset_type: null,
        created_at: item.created_at,
      })),
      ...assets.map((item) => ({
        resource_type: "asset" as const,
        resource_id: item.asset_id,
        team_id: item.team_id,
        name: item.name,
        status: item.status,
        asset_type: item.asset_type,
        created_at: item.created_at,
      })),
    ].filter((item) => (!filter?.resource_type || item.resource_type === filter.resource_type)
      && (!filter?.status || item.status === filter.status)
      && (!filter?.asset_type || item.asset_type === filter.asset_type));

    const teamIds = [...new Set(raw.map((item) => item.team_id))];
    const [teamRows, memberships] = await Promise.all([
      this.col<TeamEntity>("meta_teams").find({ team_id: { $in: teamIds } } as Document, { projection: PROJECT_NO_ID }).toArray(),
      this.col<TeamMemberEntity>("meta_team_members").find(
        { team_id: { $in: teamIds }, user_id: userId } as Document,
        { projection: PROJECT_NO_ID },
      ).toArray(),
    ]);
    const teamNames = new Map(teamRows.map((team) => [team.team_id, team.name]));
    const membershipByTeam = new Map(memberships.map((member) => [member.team_id, member]));
    const rows: UserOwnedResourceDependency[] = raw
      .map((item) => {
        const membership = membershipByTeam.get(item.team_id);
        return {
          ...item,
          team_name: teamNames.get(item.team_id) ?? item.team_id,
          membership_role: membership?.role ?? null,
          membership_status: (membership?.status ?? "absent") as UserOwnedResourceDependency["membership_status"],
          team_status: teamNames.has(item.team_id)
            ? (teamRows.find((team) => team.team_id === item.team_id)?.status ?? "active")
            : "missing",
        };
      })
      .sort((a, b) => b.created_at.localeCompare(a.created_at)
        || a.resource_type.localeCompare(b.resource_type)
        || a.resource_id.localeCompare(b.resource_id));
    const p = pagination ?? DEFAULT_PAGINATION;
    return { items: rows.slice(p.offset, p.offset + p.limit), total: rows.length };
  }

  // ============================================================
  // UserKey
  // ============================================================
  async createUserKey(input: CreateUserKeyInput): Promise<UserKeyEntity> {
    if (input.is_default) {
      await this.col("meta_user_keys").updateMany(
        { user_id: input.user_id, status: "active" } as Document,
        { $set: { is_default: false } },
      );
    }
    return this.insertUserKeyDoc({
      user_id: input.user_id,
      key_value: input.key_value ?? generateUserKey(),
      name: input.name,
      is_default: input.is_default,
      expires_at: input.expires_at,
      metadata_json: input.metadata_json,
    });
  }

  async getUserKeyById(keyId: string): Promise<UserKeyEntity | null> {
    return this.col<UserKeyEntity>("meta_user_keys").findOne({ key_id: keyId } as Document, PROJECT_NO_ID) as Promise<UserKeyEntity | null>;
  }

  async listUserKeys(userId: string, pagination?: PaginationParams | null): Promise<ListPage<UserKeyEntity>> {
    return this.paginatedFind(
      "meta_user_keys",
      { user_id: userId },
      pagination,
      { created_at: -1 },
      (d) => d as UserKeyEntity,
    );
  }

  async countActiveUserKeys(userId: string): Promise<number> {
    return this.col("meta_user_keys").countDocuments({ user_id: userId, status: "active" } as Document);
  }

  async revokeUserKey(keyId: string, options?: { promoteNextDefault?: boolean }): Promise<UserKeyEntity | null> {
    const promoteNextDefault = options?.promoteNextDefault ?? true;
    const existing = await this.getUserKeyById(keyId);
    if (!existing) return null;

    if (existing.is_default && promoteNextDefault) {
      const next = await this.col<UserKeyEntity>("meta_user_keys")
        .find({ user_id: existing.user_id, status: "active", key_id: { $ne: keyId } } as Document, PROJECT_NO_ID)
        .sort({ created_at: 1 })
        .limit(1)
        .next();
      if (next) {
        await this.col("meta_user_keys").updateOne({ key_id: next.key_id } as Document, { $set: { is_default: true } });
      }
    }

    await this.col("meta_user_keys").deleteOne({ key_id: keyId } as Document);
    return existing;
  }

  async updateUserKey(
    keyId: string,
    patch: Partial<Pick<UserKeyEntity, "name" | "expires_at" | "is_default" | "metadata_json">>,
  ): Promise<UserKeyEntity | null> {
    const existing = await this.getUserKeyById(keyId);
    if (!existing) return null;
    if (patch.is_default === true) {
      await this.col("meta_user_keys").updateMany(
        { user_id: existing.user_id, status: "active" } as Document,
        { $set: { is_default: false } },
      );
    }
    const $set: Record<string, unknown> = {};
    if (patch.name !== undefined) $set.name = patch.name;
    if (patch.expires_at !== undefined) $set.expires_at = patch.expires_at;
    if (patch.is_default !== undefined) $set.is_default = patch.is_default;
    if (patch.metadata_json !== undefined) $set.metadata_json = patch.metadata_json;
    if (Object.keys($set).length > 0) {
      await this.col("meta_user_keys").updateOne({ key_id: keyId } as Document, { $set });
    }
    return this.getUserKeyById(keyId);
  }

  async touchUserKeyUsage(keyId: string): Promise<void> {
    await this.col("meta_user_keys").updateOne({ key_id: keyId } as Document, { $set: { last_used_at: nowIso() } });
  }

  async revokeAllUserKeysForUser(userId: string): Promise<void> {
    await this.col("meta_user_keys").deleteMany(
      { user_id: userId, status: "active" } as Document,
    );
  }

  // ============================================================
  // Team
  // ============================================================
  async createTeam(input: CreateTeamInput): Promise<TeamEntity> {
    if (!this.useTransactions) throw new LifecycleTransactionsRequiredError();
    const now = nowIso();
    for (let attempt = 0; attempt < PK_RETRY_LIMIT; attempt++) {
      const team: TeamEntity = {
        team_id: input.team_id ?? generateId(ID_PREFIX.team),
        name: input.name,
        description: input.description ?? null,
        owner_user_id: input.owner_user_id,
        status: input.status ?? "active",
        created_at: now,
        updated_at: now,
        metadata_json: input.metadata_json ?? "{}",
      };
      try {
        await this.withTx(async (session) => {
          const owner = await this.col("meta_users").findOne(
            { user_id: input.owner_user_id, status: "active" }, { session },
          );
          if (!owner) throw new Error("active_owner_user_required");
          await this.col("meta_users").updateOne(
            { user_id: input.owner_user_id }, { $set: { updated_at: now } }, { session },
          );
          await this.col("meta_teams").insertOne({ ...team }, { session });
          await this.col("meta_team_members").insertOne(
            {
              id: generateRelationId(),
              team_id: team.team_id,
              user_id: team.owner_user_id,
              role: "admin",
              joined_at: now,
              status: "active",
            },
            { session },
          );
        });
        return team;
      } catch (err) {
        if (isStorePkCollision(err) && !input.team_id) continue;
        if (isMongoRelationIdCollision(err)) continue;
        throw err;
      }
    }
    throw new Error("PK collision after max retries");
  }

  async getTeamById(teamId: string): Promise<TeamEntity | null> {
    return this.col<TeamEntity>("meta_teams").findOne({ team_id: teamId } as Document, PROJECT_NO_ID) as Promise<TeamEntity | null>;
  }

  async updateTeam(teamId: string, patch: Partial<TeamEntity>): Promise<TeamEntity | null> {
    await this.patchOne("meta_teams", { team_id: teamId }, patch, ["name", "description", "status", "metadata_json"], true);
    return this.getTeamById(teamId);
  }

  async deleteTeams(teamIds: string[]): Promise<BatchDeleteResult> {
    const result = await this.batchDelete("meta_teams", "team_id", teamIds);
    if (result.deleted_ids.length > 0) {
      await this.col("meta_team_members").deleteMany({ team_id: { $in: result.deleted_ids } } as Document);
      await this.col("meta_agents").deleteMany({ team_id: { $in: result.deleted_ids } } as Document);
      await this.col("meta_tasks").deleteMany({ team_id: { $in: result.deleted_ids } } as Document);
      await this.col("meta_assets").deleteMany({ team_id: { $in: result.deleted_ids } } as Document);
    }
    return result;
  }

  private async buildTeamDeletePreview(teamId: string, session?: ClientSession): Promise<TeamDeletePreview | null> {
    const team = await this.col<TeamEntity>("meta_teams").findOne(
      { team_id: teamId } as Document,
      { ...PROJECT_NO_ID, session },
    ) as TeamEntity | null;
    if (!team) return null;
    const activeMembers = await this.col("meta_team_members").countDocuments({ team_id: teamId, status: "active" }, { session });
    const agents = await this.col("meta_agents").countDocuments({ team_id: teamId }, { session });
    const tasks = await this.col("meta_tasks").countDocuments({ team_id: teamId }, { session });
    const assets = await this.col("meta_assets").countDocuments({ team_id: teamId }, { session });
    const assetRows = await this.col("meta_assets").aggregate([
      { $match: { team_id: teamId } },
      { $group: { _id: "$asset_type", c: { $sum: 1 } } },
    ], { session }).toArray();
    const taskAgents = await this.col("meta_task_agents").aggregate([
      { $lookup: { from: "meta_tasks", localField: "task_id", foreignField: "task_id", as: "task" } },
      { $match: { "task.team_id": teamId, status: "active" } },
      { $count: "c" },
    ], { session }).toArray();
    const fixedAssets = await this.col("meta_agent_fixed_assets").aggregate([
      { $lookup: { from: "meta_agents", localField: "agent_id", foreignField: "agent_id", as: "agent" } },
      { $match: { "agent.team_id": teamId } },
      { $count: "c" },
    ], { session }).toArray();
    const acls = await this.col("meta_asset_acl").aggregate([
      { $lookup: { from: "meta_assets", localField: "asset_id", foreignField: "asset_id", as: "asset" } },
      { $match: { "asset.team_id": teamId } },
      { $count: "c" },
    ], { session }).toArray();
    const operations = await this.col("meta_lifecycle_operations").countDocuments({
      team_id: teamId, status: { $nin: ["succeeded", "failed", "resolved"] },
    }, { session });
    const findings = await this.col("meta_integrity_findings").countDocuments({
      team_id: teamId, status: "open", category: { $in: ["operational_orphan", "inconsistent"] },
    }, { session });
    const counts: UserOwnedResourceCounts = { teams: 1, agents, tasks, assets };
    const assetCounts: UserOwnedAssetCounts = { skill: 0, llm_wiki: 0, code_graph: 0, chat_memory: 0, other: 0 };
    for (const row of assetRows) {
      const key = String(row._id);
      if (key in assetCounts) assetCounts[key as keyof UserOwnedAssetCounts] = Number(row.c);
      else assetCounts.other += Number(row.c);
    }
    const activeAssociations = Number(taskAgents[0]?.c ?? 0) + Number(fixedAssets[0]?.c ?? 0)
      + Number(acls[0]?.c ?? 0) + operations + findings;
    const fingerprint = JSON.stringify({
      team_id: team.team_id, updated_at: team.updated_at, active_members: activeMembers,
      counts, asset_counts: assetCounts, active_associations: activeAssociations,
    });
    return {
      team_id: team.team_id,
      team_name: team.name,
      revision: createHash("sha256").update(fingerprint).digest("hex"),
      active_members: activeMembers,
      counts,
      asset_counts: assetCounts,
      active_associations: activeAssociations,
      ready: activeMembers === 1 && agents === 0 && tasks === 0 && assets === 0 && activeAssociations === 0,
    };
  }

  async getTeamDeletePreview(teamId: string): Promise<TeamDeletePreview | null> {
    return this.buildTeamDeletePreview(teamId);
  }

  async deleteEmptyTeam(teamId: string, ownerUserId: string, revision: string): Promise<boolean> {
    if (!this.useTransactions) throw new LifecycleTransactionsRequiredError();
    return this.withTx(async (session) => {
      const team = await this.col<TeamEntity>("meta_teams").findOne(
        { team_id: teamId, owner_user_id: ownerUserId } as Document,
        { ...PROJECT_NO_ID, session },
      );
      if (!team) return false;
      const preview = await this.buildTeamDeletePreview(teamId, session);
      if (!preview || !preview.ready || preview.revision !== revision) return false;
      await this.col("meta_team_members").deleteOne({ team_id: teamId, user_id: ownerUserId }, { session });
      const deleted = await this.col("meta_teams").deleteOne({ team_id: teamId, owner_user_id: ownerUserId }, { session });
      return deleted.deletedCount === 1;
    });
  }

  async prepareOwnershipTransfer(input: OwnershipTransferInput): Promise<{ operation_id: string; status: string }> {
    if (!this.useTransactions) throw new LifecycleTransactionsRequiredError();
    return this.withTx(async (session) => {
      const existing = await this.col("meta_lifecycle_operations").findOne({
        idempotency_key: input.idempotency_key,
        resource_type: input.resource_type,
        resource_id: input.resource_id,
      }, { session });
      if (existing) {
        if (existing.team_id !== input.team_id || existing.from_owner_user_id !== input.from_user_id
          || existing.to_owner_user_id !== input.to_user_id) throw new Error("idempotency_key_conflict");
        return { operation_id: String(existing.operation_id), status: String(existing.status) };
      }
      const target = await this.col("meta_team_members").findOne({
        team_id: input.team_id, user_id: input.to_user_id, status: "active",
      }, { session });
      const user = await this.col("meta_users").findOne({ user_id: input.to_user_id, status: "active" }, { session });
      const collection = input.resource_type === "team" ? "meta_teams"
        : input.resource_type === "agent" ? "meta_agents"
          : input.resource_type === "task" ? "meta_tasks" : "meta_assets";
      const idColumn = `${input.resource_type}_id`;
      const current = await this.col(collection).findOne({
        [idColumn]: input.resource_id, team_id: input.team_id,
      }, { session });
      if (!target || !user) throw new Error("target_not_active_member");
      if (!current) throw new Error("resource_not_found");
      if (current.owner_user_id !== input.from_user_id) throw new Error("not_resource_owner");
      const operationId = generateRelationId();
      const now = nowIso();
      await this.col("meta_lifecycle_operations").insertOne({
        operation_id: operationId, idempotency_key: input.idempotency_key,
        actor_user_id: input.from_user_id, team_id: input.team_id,
        resource_type: input.resource_type, resource_id: input.resource_id,
        from_owner_user_id: input.from_user_id, to_owner_user_id: input.to_user_id,
        status: "pending", result_json: "{}", error_code: null,
        created_at: now, updated_at: now,
      }, { session });
      await this.col("meta_teams").updateOne({ team_id: input.team_id }, { $set: { updated_at: now } }, { session });
      return { operation_id: operationId, status: "pending" };
    });
  }

  async resolveOwnershipTransfer(input: Pick<OwnershipTransferInput, "team_id" | "resource_type" | "resource_id" | "idempotency_key"> & {
    status: "failed" | "inconsistent_retryable"; error_code: string;
  }): Promise<void> {
    if (!this.useTransactions) throw new LifecycleTransactionsRequiredError();
    await this.withTx(async (session) => {
      const now = nowIso();
      await this.col("meta_lifecycle_operations").updateOne({
        idempotency_key: input.idempotency_key, resource_type: input.resource_type,
        resource_id: input.resource_id, team_id: input.team_id, status: { $ne: "succeeded" },
      }, { $set: { status: input.status, error_code: input.error_code, updated_at: now } }, { session });
      await this.col("meta_teams").updateOne({ team_id: input.team_id }, { $set: { updated_at: now } }, { session });
    });
  }

  async transferOwnership(input: OwnershipTransferInput): Promise<OwnershipTransferResult> {
    if (!this.useTransactions) throw new LifecycleTransactionsRequiredError();
    return this.withTx(async (session) => {
      const operation = await this.col("meta_lifecycle_operations").findOne({
        idempotency_key: input.idempotency_key,
        resource_type: input.resource_type,
        resource_id: input.resource_id,
      }, { session });
      if (operation?.status === "succeeded" && operation.result_json) {
        return JSON.parse(String(operation.result_json)) as OwnershipTransferResult;
      }
      const fail = (reason: string): OwnershipTransferResult => ({
        resource_type: input.resource_type, resource_id: input.resource_id,
        transferred: false, implicit_asset_ids: [], removed_binding_ids: [], reason,
      });
      const target = await this.col<TeamMemberEntity>("meta_team_members").findOne(
        { team_id: input.team_id, user_id: input.to_user_id, status: "active" } as Document,
        { ...PROJECT_NO_ID, session },
      );
      const user = await this.col<UserEntity>("meta_users").findOne(
        { user_id: input.to_user_id, status: "active" } as Document,
        { ...PROJECT_NO_ID, session },
      );
      if (!target || !user) return fail("target_not_active_member");
      if (input.resource_type === "team" && target.role !== "admin") return fail("team_owner_target_must_be_admin");
      const collection = input.resource_type === "team" ? "meta_teams"
        : input.resource_type === "agent" ? "meta_agents"
          : input.resource_type === "task" ? "meta_tasks" : "meta_assets";
      const idColumn = `${input.resource_type}_id`;
      const current = await this.col(collection).findOne(
        { [idColumn]: input.resource_id, team_id: input.team_id } as Document,
        { projection: { _id: 0, team_id: 1, owner_user_id: 1 }, session },
      );
      if (!current) return fail("resource_not_found");
      if (current.owner_user_id !== input.from_user_id) return fail("not_resource_owner");

      const implicitAssetIds: string[] = [];
      const removedBindingIds: string[] = [];
      if (input.resource_type === "agent") {
        const bindings = await this.col<FixedAssetBindingEntity>("meta_agent_fixed_assets").find(
          { agent_id: input.resource_id } as Document, { ...PROJECT_NO_ID, session },
        ).toArray();
        const assetIds = bindings.map((binding) => binding.asset_id);
        const assets = await this.col<AssetEntity>("meta_assets").find(
          { asset_id: { $in: assetIds } } as Document, { ...PROJECT_NO_ID, session },
        ).toArray();
        if (new Set(assetIds).size !== assets.length || assets.some((asset) => asset.team_id !== input.team_id)) {
          return fail("bound_asset_invalid");
        }
        implicitAssetIds.push(...assets
          .filter((asset) => asset.owner_user_id === input.from_user_id)
          .map((asset) => asset.asset_id));
        await this.col("meta_assets").updateMany(
          { asset_id: { $in: implicitAssetIds }, owner_user_id: input.from_user_id } as Document,
          { $set: { owner_user_id: input.to_user_id, updated_at: nowIso() } },
          { session },
        );
      }
      await this.col("meta_teams").updateOne(
        { team_id: input.team_id },
        { $set: { updated_at: nowIso() } },
        { session },
      );
      await this.col(collection).updateOne(
        { [idColumn]: input.resource_id, owner_user_id: input.from_user_id } as Document,
        { $set: { owner_user_id: input.to_user_id, updated_at: nowIso() } },
        { session },
      );
      const result: OwnershipTransferResult = {
        resource_type: input.resource_type, resource_id: input.resource_id, transferred: true,
        implicit_asset_ids: implicitAssetIds, removed_binding_ids: removedBindingIds,
      };
      if (operation) {
        await this.col("meta_lifecycle_operations").updateOne(
          { operation_id: operation.operation_id },
          { $set: { status: "succeeded", result_json: JSON.stringify(result), error_code: null, updated_at: nowIso() } },
          { session },
        );
      } else {
        await this.col("meta_lifecycle_operations").insertOne({
          operation_id: generateRelationId(), idempotency_key: input.idempotency_key,
          actor_user_id: input.from_user_id, team_id: input.team_id,
          resource_type: input.resource_type, resource_id: input.resource_id,
          from_owner_user_id: input.from_user_id, to_owner_user_id: input.to_user_id,
          status: "succeeded", result_json: JSON.stringify(result), error_code: null,
          created_at: nowIso(), updated_at: nowIso(),
        }, { session });
      }
      return result;
    });
  }

  async transferSkillOwnership(input: SkillOwnershipTransferInput): Promise<OwnershipTransferResult> {
    if (!this.useTransactions) throw new LifecycleTransactionsRequiredError();
    return this.withTx(async (session) => {
      const fail = (reason: string): OwnershipTransferResult => ({
        resource_type: "asset", resource_id: input.resource_id, transferred: false,
        implicit_asset_ids: [], removed_binding_ids: [], reason,
      });
      const operation = await this.col("meta_lifecycle_operations").findOne({
        idempotency_key: input.idempotency_key, resource_type: "asset", resource_id: input.resource_id,
      }, { session });
      if (operation?.status === "succeeded" && operation.result_json) {
        return JSON.parse(String(operation.result_json)) as OwnershipTransferResult;
      }
      const [asset, sourceAgent, targetAgent, target, targetUser, binding, targetBinding] = await Promise.all([
        this.col<AssetEntity>("meta_assets").findOne({ asset_id: input.resource_id } as Document, { ...PROJECT_NO_ID, session }),
        this.col<AgentEntity>("meta_agents").findOne({ agent_id: input.from_agent_id } as Document, { ...PROJECT_NO_ID, session }),
        this.col<AgentEntity>("meta_agents").findOne({ agent_id: input.to_agent_id } as Document, { ...PROJECT_NO_ID, session }),
        this.col<TeamMemberEntity>("meta_team_members").findOne({ team_id: input.team_id, user_id: input.to_user_id, status: "active" } as Document, { ...PROJECT_NO_ID, session }),
        this.col<UserEntity>("meta_users").findOne({ user_id: input.to_user_id, status: "active" } as Document, { ...PROJECT_NO_ID, session }),
        this.col<FixedAssetBindingEntity>("meta_agent_fixed_assets").findOne({ agent_id: input.from_agent_id, asset_id: input.resource_id } as Document, { ...PROJECT_NO_ID, session }),
        this.col<FixedAssetBindingEntity>("meta_agent_fixed_assets").findOne({ agent_id: input.to_agent_id, asset_id: input.resource_id } as Document, { ...PROJECT_NO_ID, session }),
      ]);
      if (!target || !targetUser) return fail("target_not_active_member");
      if (!asset || asset.team_id !== input.team_id ||
        !["skill", "llm_wiki", "code_graph", "chat_memory"].includes(asset.asset_type)) {
        return fail("resource_not_found");
      }
      if (asset.owner_user_id !== input.from_user_id) return fail("not_resource_owner");
      if (!sourceAgent || sourceAgent.team_id !== input.team_id || sourceAgent.owner_user_id !== input.from_user_id) return fail("source_agent_not_owned");
      if (!targetAgent || targetAgent.team_id !== input.team_id || targetAgent.owner_user_id !== input.to_user_id || targetAgent.status !== "active") return fail("target_agent_not_active");
      if (!binding) return fail("source_asset_binding_not_found");
      if (asset.asset_type === "chat_memory" && !targetBinding) {
        const selfMemoryId = `chat_memory-${input.team_id}-${input.to_agent_id}`;
        const imported = await this.col<FixedAssetBindingEntity>("meta_agent_fixed_assets").countDocuments({
          agent_id: input.to_agent_id,
          asset_type: "chat_memory",
          asset_id: { $ne: selfMemoryId },
        } as Document, { session });
        if (imported >= 2) return fail("IMPORT_LIMIT_EXCEEDED");
      }
      if (targetBinding) await this.col("meta_agent_fixed_assets").deleteOne({ agent_id: input.from_agent_id, asset_id: input.resource_id }, { session });
      else await this.col("meta_agent_fixed_assets").updateOne(
        { agent_id: input.from_agent_id, asset_id: input.resource_id }, { $set: { agent_id: input.to_agent_id } }, { session },
      );
      await this.col("meta_assets").updateOne(
        { asset_id: input.resource_id, owner_user_id: input.from_user_id },
        { $set: { owner_user_id: input.to_user_id, updated_at: nowIso() } }, { session },
      );
      const result: OwnershipTransferResult = {
        resource_type: "asset", resource_id: input.resource_id, transferred: true,
        implicit_asset_ids: [], removed_binding_ids: [],
      };
      if (operation) await this.col("meta_lifecycle_operations").updateOne(
        { operation_id: operation.operation_id },
        { $set: { status: "succeeded", result_json: JSON.stringify(result), error_code: null, updated_at: nowIso() } }, { session },
      );
      else await this.col("meta_lifecycle_operations").insertOne({
        operation_id: generateRelationId(), idempotency_key: input.idempotency_key,
        actor_user_id: input.from_user_id, team_id: input.team_id, resource_type: "asset", resource_id: input.resource_id,
        from_owner_user_id: input.from_user_id, to_owner_user_id: input.to_user_id,
        status: "succeeded", result_json: JSON.stringify(result), error_code: null,
        created_at: nowIso(), updated_at: nowIso(),
      }, { session });
      return result;
    });
  }

  async scanIntegrityFindings(): Promise<IntegrityFinding[]> {
    const [users, teams, members, agents, tasks, assets, taskAgents, fixedAssets, acls, participation] = await Promise.all([
      this.col<UserEntity>("meta_users").find({}, PROJECT_NO_ID).toArray(),
      this.col<TeamEntity>("meta_teams").find({}, PROJECT_NO_ID).toArray(),
      this.col<TeamMemberEntity>("meta_team_members").find({}, PROJECT_NO_ID).toArray(),
      this.col<AgentEntity>("meta_agents").find({}, PROJECT_NO_ID).toArray(),
      this.col<TaskEntity>("meta_tasks").find({}, PROJECT_NO_ID).toArray(),
      this.col<AssetEntity>("meta_assets").find({}, PROJECT_NO_ID).toArray(),
      this.col<TaskAgentEntity>("meta_task_agents").find({}, PROJECT_NO_ID).toArray(),
      this.col<FixedAssetBindingEntity>("meta_agent_fixed_assets").find({}, PROJECT_NO_ID).toArray(),
      this.col<AclEntity>("meta_asset_acl").find({}, PROJECT_NO_ID).toArray(),
      this.col<ParticipationLogEntity>("meta_participation_logs").find({}, PROJECT_NO_ID).toArray(),
    ]);
    const userIds = new Set(users.map((item) => item.user_id));
    const teamById = new Map(teams.map((item) => [item.team_id, item]));
    const memberByKey = new Map(members.map((item) => [`${item.team_id}:${item.user_id}`, item]));
    const agentById = new Map(agents.map((item) => [item.agent_id, item]));
    const taskById = new Map(tasks.map((item) => [item.task_id, item]));
    const assetById = new Map(assets.map((item) => [item.asset_id, item]));
    const now = nowIso();
    const rows: Array<Omit<IntegrityFinding, "finding_id" | "fingerprint" | "first_seen_at" | "last_seen_at">> = [];
    const owned = [
      ...agents.map((item) => ({ type: "agent", id: item.agent_id, team: item.team_id, owner: item.owner_user_id })),
      ...tasks.map((item) => ({ type: "task", id: item.task_id, team: item.team_id, owner: item.owner_user_id })),
      ...assets.map((item) => ({ type: item.asset_type, id: item.asset_id, team: item.team_id, owner: item.owner_user_id })),
    ];
    for (const item of owned) {
      const teamExists = teamById.has(item.team);
      const userExists = userIds.has(item.owner);
      const membership = memberByKey.get(`${item.team}:${item.owner}`);
      if (teamExists && userExists && membership?.status === "active") continue;
      rows.push({
        category: teamExists && userExists ? "recoverable_dependency" : "operational_orphan",
        source_service: "MemoryCore", resource_type: item.type, resource_id: item.id,
        team_id: item.team, owner_user_id: item.owner,
        reason: !teamExists ? "missing_team" : !userExists ? "missing_owner_user" : "owner_membership_absent",
        allowed_actions: ["inspect"],
      });
    }
    for (const team of teams) {
      const ownerMember = memberByKey.get(`${team.team_id}:${team.owner_user_id}`);
      if (!userIds.has(team.owner_user_id) || ownerMember?.status !== "active" || ownerMember.role !== "admin") {
        rows.push({
          category: "inconsistent", source_service: "MemoryCore", resource_type: "team",
          resource_id: team.team_id, team_id: team.team_id, owner_user_id: team.owner_user_id,
          reason: "invalid_team_owner_membership", allowed_actions: ["inspect"],
        });
      }
    }
    for (const relation of taskAgents) {
      if (!taskById.has(relation.task_id) || !agentById.has(relation.agent_id)) rows.push({
        category: "operational_orphan", source_service: "MemoryCore", resource_type: "task_agent_relation",
        resource_id: relation.id, team_id: taskById.get(relation.task_id)?.team_id ?? agentById.get(relation.agent_id)?.team_id ?? null,
        owner_user_id: null, reason: "dangling_task_or_agent", allowed_actions: ["inspect", "purge"],
      });
    }
    for (const relation of fixedAssets) {
      if (!agentById.has(relation.agent_id) || !assetById.has(relation.asset_id)) rows.push({
        category: "operational_orphan", source_service: "MemoryCore", resource_type: "fixed_asset_relation",
        resource_id: relation.id, team_id: agentById.get(relation.agent_id)?.team_id ?? assetById.get(relation.asset_id)?.team_id ?? null,
        owner_user_id: null, reason: "dangling_agent_or_asset", allowed_actions: ["inspect", "purge"],
      });
    }
    for (const relation of acls) {
      if (!assetById.has(relation.asset_id)) rows.push({
        category: "operational_orphan", source_service: "MemoryCore", resource_type: "acl_relation",
        resource_id: relation.id, team_id: null, owner_user_id: null,
        reason: "dangling_asset_acl", allowed_actions: ["inspect", "purge"],
      });
    }
    for (const log of participation) {
      if (!teamById.has(log.team_id) || !taskById.has(log.task_id) || !agentById.has(log.agent_id)) rows.push({
        category: "retained_history", source_service: "MemoryCore", resource_type: "participation_history",
        resource_id: log.id, team_id: log.team_id, owner_user_id: log.user_id,
        reason: "historical_reference_without_live_parent", allowed_actions: ["inspect"],
      });
    }
    const findings: IntegrityFinding[] = rows.map((row) => {
      const fingerprint = createHash("sha256").update(JSON.stringify(row)).digest("hex");
      return { ...row, finding_id: `finding-${fingerprint.slice(0, 20)}`, fingerprint, first_seen_at: now, last_seen_at: now };
    });
    const currentFingerprints = findings.map((finding) => finding.fingerprint);
    await this.col("meta_integrity_findings").updateMany(
      {
        status: "open",
        ...(currentFingerprints.length > 0 ? { fingerprint: { $nin: currentFingerprints } } : {}),
      },
      { $set: { status: "resolved", last_seen_at: now } },
    );
    if (findings.length) {
      await this.col("meta_integrity_findings").bulkWrite(findings.map((finding) => ({
        updateOne: {
          filter: { fingerprint: finding.fingerprint },
          update: {
            $set: { ...finding, status: "open", last_seen_at: now },
            $setOnInsert: { first_seen_at: now },
          },
          upsert: true,
        },
      })));
    }
    return findings;
  }

  async purgeIntegrityFindings(findings: Array<{ finding_id: string; fingerprint: string }>): Promise<{
    deleted: string[]; failed: Array<{ finding_id: string; reason: string }>;
  }> {
    if (!this.useTransactions) throw new LifecycleTransactionsRequiredError();
    const current = new Map((await this.scanIntegrityFindings()).map((item) => [item.finding_id, item]));
    return this.withTx(async (session) => {
      const deleted: string[] = [];
      const failed: Array<{ finding_id: string; reason: string }> = [];
      for (const requested of findings) {
        const item = current.get(requested.finding_id);
        if (!item || item.fingerprint !== requested.fingerprint) {
          failed.push({ finding_id: requested.finding_id, reason: "stale_integrity_scan" });
          continue;
        }
        const collection = item.resource_type === "task_agent_relation" ? "meta_task_agents"
          : item.resource_type === "fixed_asset_relation" ? "meta_agent_fixed_assets"
            : item.resource_type === "acl_relation" ? "meta_asset_acl" : null;
        if (!collection || !item.allowed_actions.includes("purge")) {
          failed.push({ finding_id: requested.finding_id, reason: "finding_not_purgable" });
          continue;
        }
        await this.col(collection).deleteOne({ id: item.resource_id }, { session });
        await this.col("meta_integrity_findings").updateOne(
          { finding_id: item.finding_id }, { $set: { status: "resolved", last_seen_at: nowIso() } }, { session },
        );
        deleted.push(item.finding_id);
      }
      return { deleted, failed };
    });
  }

  async listTeamsByUser(userId: string, pagination?: PaginationParams | null, filter?: { name?: string }): Promise<ListPage<TeamEntity>> {
    const joinedMatch: Document = {};
    if (filter?.name) joinedMatch.name = filter.name;
    return this.paginatedJoin<TeamEntity>(
      "meta_team_members",
      { user_id: userId, status: "active" },
      "meta_teams",
      "team_id",
      "team_id",
      { created_at: -1 },
      pagination,
      Object.keys(joinedMatch).length > 0 ? joinedMatch : undefined,
    );
  }

  // ============================================================
  // TeamMember
  // ============================================================
  async addTeamMember(input: AddTeamMemberInput): Promise<TeamMemberEntity> {
    if (!this.useTransactions) throw new LifecycleTransactionsRequiredError();
    const now = nowIso();
    await this.withTx(async (session) => {
      const team = await this.col("meta_teams").findOne({ team_id: input.team_id }, { session });
      const user = await this.col("meta_users").findOne({ user_id: input.user_id, status: "active" }, { session });
      if (!team || !user) throw new Error("active_team_and_user_required");
      await runWithGeneratedRelationId(input.id, isMongoRelationIdCollision, async (id) => {
        await this.col("meta_team_members").updateOne(
          { team_id: input.team_id, user_id: input.user_id },
          {
            $set: { role: input.role ?? "member", status: "active" },
            $setOnInsert: { id, team_id: input.team_id, user_id: input.user_id, joined_at: now },
          },
          { upsert: true, session },
        );
      });
      await this.col("meta_teams").updateOne({ team_id: input.team_id }, { $set: { updated_at: now } }, { session });
    });
    return (await this.getTeamMember(input.team_id, input.user_id))!;
  }

  async removeTeamMember(teamId: string, userId: string): Promise<void> {
    await this.col("meta_team_members").deleteOne({ team_id: teamId, user_id: userId });
  }

  async updateTeamMemberRole(teamId: string, userId: string, role: TeamMemberEntity["role"]): Promise<TeamMemberEntity | null> {
    if (!this.useTransactions) throw new LifecycleTransactionsRequiredError();
    await this.withTx(async (session) => {
      await this.col("meta_team_members").updateOne(
        { team_id: teamId, user_id: userId, status: "active" }, { $set: { role } }, { session },
      );
      await this.col("meta_teams").updateOne({ team_id: teamId }, { $set: { updated_at: nowIso() } }, { session });
    });
    return this.getTeamMember(teamId, userId);
  }

  async removeTeamMemberSafely(teamId: string, userId: string): Promise<MemberRemovalResult> {
    if (!this.useTransactions) throw new LifecycleTransactionsRequiredError();
    return this.withTx(async (session) => {
      const q = { owner_user_id: userId, team_id: teamId };
      const agents = await this.col("meta_agents").countDocuments(q, { session });
      const tasks = await this.col("meta_tasks").countDocuments(q, { session });
      const assets = await this.col("meta_assets").countDocuments(q, { session });
      const assetRows = await this.col("meta_assets").aggregate([
        { $match: q }, { $group: { _id: "$asset_type", c: { $sum: 1 } } },
      ], { session }).toArray();
      const acls = await this.col("meta_asset_acl").aggregate([
        { $lookup: { from: "meta_assets", localField: "asset_id", foreignField: "asset_id", as: "asset" } },
        { $match: { "asset.team_id": teamId, subject_type: "user", subject_id: userId } },
        { $count: "c" },
      ], { session }).toArray();
      const operations = await this.col("meta_lifecycle_operations").countDocuments({
        team_id: teamId,
        $or: [{ from_owner_user_id: userId }, { to_owner_user_id: userId }],
        status: { $nin: ["succeeded", "failed", "resolved"] },
      }, { session });
      const findings = await this.col("meta_integrity_findings").countDocuments({
        team_id: teamId,
        owner_user_id: userId,
        status: "open",
        category: { $in: ["operational_orphan", "inconsistent"] },
      }, { session });
      const counts: UserOwnedResourceCounts = { teams: 0, agents, tasks, assets };
      const assetCounts: UserOwnedAssetCounts = { skill: 0, llm_wiki: 0, code_graph: 0, chat_memory: 0, other: 0 };
      for (const row of assetRows) {
        const key = String(row._id);
        if (key in assetCounts) assetCounts[key as keyof UserOwnedAssetCounts] = Number(row.c);
        else assetCounts.other += Number(row.c);
      }
      const aclCount = Number(acls[0]?.c ?? 0);
      const activeAssociations = aclCount + findings;
      if (agents || tasks || assets) {
        return { removed: false, counts, asset_counts: assetCounts, active_associations: activeAssociations, blocker_code: "member_has_owned_resources" };
      }
      if (operations) return { removed: false, counts, asset_counts: assetCounts, active_associations: activeAssociations, blocker_code: "lifecycle_operation_in_progress" };
      if (findings) return { removed: false, counts, asset_counts: assetCounts, active_associations: activeAssociations, blocker_code: "member_has_active_associations" };
      if (aclCount) {
        const teamAssetIds = await this.col("meta_assets").find(
          { team_id: teamId }, { projection: { asset_id: 1 }, session },
        ).map((row) => String(row.asset_id)).toArray();
        await this.col("meta_asset_acl").deleteMany(
          { asset_id: { $in: teamAssetIds }, subject_type: "user", subject_id: userId }, { session },
        );
      }
      await this.col("meta_teams").updateOne({ team_id: teamId }, { $set: { updated_at: nowIso() } }, { session });
      await this.col("meta_team_members").deleteOne({ team_id: teamId, user_id: userId }, { session });
      return { removed: true, counts, asset_counts: assetCounts, active_associations: aclCount };
    });
  }

  async listTeamMembers(teamId: string, pagination?: PaginationParams | null): Promise<ListPage<TeamMemberEntity>> {
    return this.paginatedFind(
      "meta_team_members",
      { team_id: teamId, status: "active" },
      pagination,
      { joined_at: -1 },
      (d) => d as TeamMemberEntity,
    );
  }

  async getTeamMember(teamId: string, userId: string): Promise<TeamMemberEntity | null> {
    return this.col<TeamMemberEntity>("meta_team_members").findOne(
      { team_id: teamId, user_id: userId } as Document,
      PROJECT_NO_ID,
    ) as Promise<TeamMemberEntity | null>;
  }

  async listTeamMembersWithProfile(
    teamId: string,
    pagination?: PaginationParams | null,
  ): Promise<ListPage<TeamMemberView>> {
    const match = { team_id: teamId, status: "active" };
    const c = this.col("meta_team_members");
    const countResult = await c.aggregate([{ $match: match }, { $count: "total" }]).toArray();
    const total = (countResult[0] as { total?: number })?.total ?? 0;
    const p = pagination ?? DEFAULT_PAGINATION;
    const docs = await c
      .aggregate([
        { $match: match },
        { $lookup: { from: "meta_users", localField: "user_id", foreignField: "user_id", as: "_user" } },
        {
          $addFields: {
            username: { $ifNull: [{ $arrayElemAt: ["$_user.username", 0] }, ""] },
          },
        },
        { $project: { _id: 0, _user: 0 } },
        { $sort: { joined_at: -1 } },
        { $skip: p.offset },
        { $limit: p.limit },
      ])
      .toArray();
    return { items: docs.map((d) => mapTeamMemberWithProfile(d as TeamMemberEntity & { username?: string })), total };
  }

  async getTeamMemberWithProfile(teamId: string, userId: string): Promise<TeamMemberView | null> {
    const member = await this.getTeamMember(teamId, userId);
    if (!member) return null;
    const user = await this.getUserById(userId);
    return mapTeamMemberWithProfile({ ...member, username: user?.username ?? "" });
  }

  // ============================================================
  // Agent
  // ============================================================
  async createAgent(input: CreateAgentInput): Promise<AgentEntity> {
    if (!this.useTransactions) throw new LifecycleTransactionsRequiredError();
    const now = nowIso();
    for (let attempt = 0; attempt < PK_RETRY_LIMIT; attempt++) {
      const agent: AgentEntity = {
        agent_id: input.agent_id ?? generateId(ID_PREFIX.agent),
        team_id: input.team_id,
        owner_user_id: input.owner_user_id,
        name: input.name,
        description: input.description ?? null,
        prompt: input.prompt ?? null,
        visibility: input.visibility ?? "team",
        status: input.status ?? "active",
        created_at: now,
        updated_at: now,
        metadata_json: input.metadata_json ?? "{}",
      };
      try {
        await this.withTx(async (session) => {
          const team = await this.col("meta_teams").findOne({ team_id: input.team_id }, { session });
          const member = await this.col("meta_team_members").findOne(
            { team_id: input.team_id, user_id: input.owner_user_id, status: "active" }, { session },
          );
          const user = await this.col("meta_users").findOne({ user_id: input.owner_user_id, status: "active" }, { session });
          if (!team || !member || !user) throw new Error("active_team_membership_required");
          await this.col("meta_teams").updateOne({ team_id: input.team_id }, { $set: { updated_at: now } }, { session });
          await this.col("meta_agents").insertOne({ ...agent }, { session });
        });
        return agent;
      } catch (err) {
        if (isPkCollision(err) && !input.agent_id) continue;
        throw err;
      }
    }
    throw new Error("PK collision after max retries");
  }

  async getAgentById(agentId: string): Promise<AgentEntity | null> {
    return this.col<AgentEntity>("meta_agents").findOne({ agent_id: agentId } as Document, PROJECT_NO_ID) as Promise<AgentEntity | null>;
  }

  async updateAgent(agentId: string, patch: Partial<AgentEntity>): Promise<AgentEntity | null> {
    await this.patchOne("meta_agents", { agent_id: agentId }, patch, ["name", "description", "prompt", "visibility", "status", "metadata_json"], true);
    return this.getAgentById(agentId);
  }

  async deleteAgents(agentIds: string[]): Promise<BatchDeleteResult> {
    const agents = await this.col<AgentEntity>("meta_agents")
      .find({ agent_id: { $in: agentIds } } as Document, { projection: PROJECT_NO_ID })
      .toArray();
    const selfMemoryByAgent = new Map(
      agents.map((agent) => [agent.agent_id, buildChatMemoryAssetId(agent.team_id, agent.agent_id)]),
    );

    const result = await this.batchDelete("meta_agents", "agent_id", agentIds);
    if (result.deleted_ids.length > 0) {
      await this.col("meta_task_agents").deleteMany({ agent_id: { $in: result.deleted_ids } } as Document);
      await this.col("meta_agent_fixed_assets").deleteMany({ agent_id: { $in: result.deleted_ids } } as Document);
      const selfMemoryAssetIds = result.deleted_ids
        .map((agentId) => selfMemoryByAgent.get(agentId))
        .filter((assetId): assetId is string => !!assetId);
      if (selfMemoryAssetIds.length > 0) {
        await this.deleteAssets(selfMemoryAssetIds);
      }
    }
    return result;
  }

  async listAgentsByTeam(teamId: string, pagination?: PaginationParams | null, filter?: AgentFilter): Promise<ListPage<AgentEntity>> {
    const q: Document = { team_id: teamId };
    if (filter?.status) q.status = filter.status;
    if (filter?.owner_user_id) q.owner_user_id = filter.owner_user_id;
    if (filter?.name) q.name = filter.name;
    return this.paginatedFind("meta_agents", q, pagination, { created_at: -1 }, (d) => d as AgentEntity);
  }

  async listAgentsByOwner(userId: string, pagination?: PaginationParams | null, filter?: AgentFilter): Promise<ListPage<AgentEntity>> {
    const q: Document = { owner_user_id: userId };
    if (filter?.status) q.status = filter.status;
    if (filter?.name) q.name = filter.name;
    return this.paginatedFind("meta_agents", q, pagination, { created_at: -1 }, (d) => d as AgentEntity);
  }

  // ============================================================
  // Task
  // ============================================================
  async createTask(input: CreateTaskInput): Promise<TaskEntity> {
    if (!this.useTransactions) throw new LifecycleTransactionsRequiredError();
    const now = nowIso();
    for (let attempt = 0; attempt < PK_RETRY_LIMIT; attempt++) {
      const task: TaskEntity = {
        task_id: input.task_id ?? generateId(ID_PREFIX.task),
        team_id: input.team_id,
        owner_user_id: input.owner_user_id ?? input.creator_user_id,
        creator_user_id: input.creator_user_id,
        title: input.title,
        description: input.description ?? null,
        source_type: input.source_type ?? "manual",
        source_url: input.source_url ?? null,
        status: input.status ?? "running",
        auto_assign_floating_assets: input.auto_assign_floating_assets ?? false,
        risk_level: input.risk_level ?? null,
        created_at: now,
        updated_at: now,
        metadata_json: input.metadata_json ?? "{}",
      };
      try {
        await this.withTx(async (session) => {
          const ownerId = input.owner_user_id ?? input.creator_user_id;
          const team = await this.col("meta_teams").findOne({ team_id: input.team_id }, { session });
          const member = await this.col("meta_team_members").findOne(
            { team_id: input.team_id, user_id: ownerId, status: "active" }, { session },
          );
          const user = await this.col("meta_users").findOne({ user_id: ownerId, status: "active" }, { session });
          if (!team || !member || !user) throw new Error("active_team_membership_required");
          await this.col("meta_teams").updateOne({ team_id: input.team_id }, { $set: { updated_at: now } }, { session });
          await this.col("meta_tasks").insertOne({ ...task }, { session });
          const links = input.linked_agents ?? [];
          if (links.length > 0) {
            await this.col("meta_task_agents").insertMany(
              links.map((l) => ({
                id: generateRelationId(),
                task_id: task.task_id,
                agent_id: l.agent_id,
                role_in_task: l.role_in_task ?? null,
                status: "active",
                created_at: now,
              })),
              { session },
            );
          }
        });
        return task;
      } catch (err) {
        if (isStorePkCollision(err) && !input.task_id) continue;
        if (isMongoRelationIdCollision(err)) continue;
        throw err;
      }
    }
    throw new Error("PK collision after max retries");
  }

  async getTaskById(taskId: string): Promise<TaskEntity | null> {
    return this.col<TaskEntity>("meta_tasks").findOne({ task_id: taskId } as Document, PROJECT_NO_ID) as Promise<TaskEntity | null>;
  }

  async updateTask(taskId: string, patch: Partial<TaskEntity>): Promise<TaskEntity | null> {
    await this.patchOne("meta_tasks", { task_id: taskId }, patch, ["title", "description", "source_type", "source_url", "status", "auto_assign_floating_assets", "risk_level", "metadata_json"], true);
    return this.getTaskById(taskId);
  }

  async deleteTasks(taskIds: string[]): Promise<BatchDeleteResult> {
    const result = await this.batchDelete("meta_tasks", "task_id", taskIds);
    if (result.deleted_ids.length > 0) {
      await this.col("meta_task_agents").deleteMany({ task_id: { $in: result.deleted_ids } } as Document);
    }
    return result;
  }

  async listTasksByTeam(teamId: string, pagination?: PaginationParams | null, filter?: TaskFilter): Promise<ListPage<TaskEntity>> {
    const q: Document = { team_id: teamId };
    if (filter?.status) q.status = filter.status;
    if (filter?.creator_user_id) q.owner_user_id = filter.creator_user_id;
    if (filter?.title) q.title = filter.title;
    return this.paginatedFind("meta_tasks", q, pagination, { created_at: -1 }, (d) => d as TaskEntity);
  }

  async listTasks(filter: TaskFilter, pagination?: PaginationParams | null): Promise<ListPage<TaskEntity>> {
    const q: Document = {};
    if (filter.status) q.status = filter.status;
    if (filter.creator_user_id) q.owner_user_id = filter.creator_user_id;
    if (filter.title) q.title = filter.title;
    return this.paginatedFind("meta_tasks", q, pagination, { created_at: -1 }, (d) => d as TaskEntity);
  }

  // ============================================================
  // TaskAgent
  // ============================================================
  async linkTaskAgent(taskId: string, agentId: string, roleInTask?: string): Promise<TaskAgentEntity> {
    const now = nowIso();
    await runWithGeneratedRelationId(undefined, isMongoRelationIdCollision, async (id) => {
      await this.col("meta_task_agents").updateOne(
        { task_id: taskId, agent_id: agentId },
        {
          $set: { role_in_task: roleInTask ?? null, status: "active" },
          $setOnInsert: { id, task_id: taskId, agent_id: agentId, created_at: now },
        },
        { upsert: true },
      );
    });
    return (await this.col<TaskAgentEntity>("meta_task_agents").findOne(
      { task_id: taskId, agent_id: agentId } as Document,
      PROJECT_NO_ID,
    )) as TaskAgentEntity;
  }

  async unlinkTaskAgent(taskId: string, agentId: string): Promise<void> {
    await this.col("meta_task_agents").deleteOne({ task_id: taskId, agent_id: agentId });
  }

  async listTaskAgents(taskId: string, pagination?: PaginationParams | null): Promise<ListPage<TaskAgentEntity>> {
    return this.paginatedFind(
      "meta_task_agents",
      { task_id: taskId, status: "active" },
      pagination,
      { created_at: -1 },
      (d) => d as TaskAgentEntity,
    );
  }

  // ============================================================
  // ParticipationLog
  // ============================================================
  async appendParticipationLog(input: AppendParticipationLogInput): Promise<ParticipationLogEntity> {
    const now = nowIso();
    const createdAt = input.created_at ?? now;
    const entity: ParticipationLogEntity = {
      id: generateRelationId(),
      team_id: input.team_id,
      task_id: input.task_id,
      agent_id: input.agent_id,
      user_id: input.user_id,
      source: input.source ?? "unknown",
      metadata_json: input.metadata_json ?? "{}",
      created_at: createdAt,
      updated_at: createdAt,
    };
    await this.col("meta_participation_logs").insertOne(entity);
    return entity;
  }

  async listParticipationLogs(
    filter: ParticipationLogFilter,
    pagination?: PaginationParams | null,
  ): Promise<ListPage<ParticipationLogEntity>> {
    const match = this.buildParticipationLogMatch(filter);
    const p = pagination ?? DEFAULT_PAGINATION;
    if (filter.dedupe) {
      const pipeline: Document[] = [
        { $match: match },
        { $sort: { created_at: -1, id: -1 } },
        { $group: { _id: "$user_id", doc: { $first: "$$ROOT" } } },
        { $replaceRoot: { newRoot: "$doc" } },
        { $sort: { created_at: -1, id: -1 } },
        {
          $facet: {
            items: [{ $skip: p.offset }, { $limit: p.limit }],
            total: [{ $count: "total" }],
          },
        },
      ];
      const [result] = await this.col("meta_participation_logs").aggregate(pipeline).toArray();
      const facet = result as { items?: Document[]; total?: Array<{ total: number }> };
      return {
        items: (facet.items ?? []).map((d) => d as ParticipationLogEntity),
        total: facet.total?.[0]?.total ?? 0,
      };
    }
    return this.paginatedFind(
      "meta_participation_logs",
      match,
      pagination,
      { created_at: -1, id: -1 },
      (d) => d as ParticipationLogEntity,
    );
  }

  private buildParticipationLogMatch(filter: ParticipationLogFilter): Document {
    const q: Document = { team_id: filter.team_id };
    if (filter.task_id) q.task_id = filter.task_id;
    if (filter.agent_id) q.agent_id = filter.agent_id;
    if (filter.user_id) q.user_id = filter.user_id;
    if (filter.created_after) q.created_at = { ...(q.created_at as Document), $gte: filter.created_after };
    if (filter.created_before) {
      q.created_at = { ...(q.created_at as Document), $lte: filter.created_before };
    }
    return q;
  }

  // ============================================================
  // Asset
  // ============================================================
  async createAsset(input: CreateAssetInput): Promise<AssetEntity> {
    if (!this.useTransactions) throw new LifecycleTransactionsRequiredError();
    const now = nowIso();
    const asset: AssetEntity = {
      asset_id: input.asset_id,
      team_id: input.team_id,
      asset_type: input.asset_type,
      name: input.name,
      description: input.description ?? null,
      owner_user_id: input.owner_user_id,
      source_type: input.source_type,
      source_ref: input.source_ref ?? null,
      version: 1,
      visibility: input.visibility ?? "team",
      status: input.status ?? "draft",
      confidence: input.confidence ?? null,
      expires_at: input.expires_at ?? null,
      last_used_at: null,
      usage_count: 0,
      content_ref: input.content_ref ?? null,
      created_at: now,
      updated_at: now,
      metadata_json: input.metadata_json ?? "{}",
    };
    await this.withTx(async (session) => {
      const team = await this.col("meta_teams").findOne({ team_id: input.team_id }, { session });
      const member = await this.col("meta_team_members").findOne(
        { team_id: input.team_id, user_id: input.owner_user_id, status: "active" }, { session },
      );
      const user = await this.col("meta_users").findOne({ user_id: input.owner_user_id, status: "active" }, { session });
      if (!team || !member || !user) throw new Error("active_team_membership_required");
      await this.col("meta_teams").updateOne({ team_id: input.team_id }, { $set: { updated_at: now } }, { session });
      await this.col("meta_assets").insertOne({ ...asset }, { session });
    });
    return asset;
  }

  async getAssetById(assetId: string): Promise<AssetEntity | null> {
    return this.col<AssetEntity>("meta_assets").findOne({ asset_id: assetId } as Document, PROJECT_NO_ID) as Promise<AssetEntity | null>;
  }

  async updateAsset(assetId: string, patch: Partial<AssetEntity>): Promise<AssetEntity | null> {
    await this.patchOne("meta_assets", { asset_id: assetId }, patch, ["name", "description", "visibility", "status", "confidence", "expires_at", "content_ref", "version", "source_ref", "metadata_json"], true);
    return this.getAssetById(assetId);
  }

  async deleteAssets(assetIds: string[]): Promise<BatchDeleteResult> {
    // 物理删除 meta_assets，并级联清理绑定与 ACL。
    // 已不存在视为幂等成功（Skill 钩子/handler 双通道会二次调用）。
    const result: BatchDeleteResult = { deleted_ids: [], failed: [] };
    for (const id of assetIds) {
      const existing = await this.getAssetById(id);
      if (!existing) {
        result.deleted_ids.push(id);
        continue;
      }
      await this.withTx(async (session) => {
        await this.col("meta_agent_fixed_assets").deleteMany({ asset_id: id }, { session });
        await this.col("meta_asset_acl").deleteMany({ asset_id: id }, { session });
        await this.col("meta_assets").deleteOne({ asset_id: id }, { session });
      });
      result.deleted_ids.push(id);
    }
    return result;
  }

  async listAssetsByTeam(teamId: string, pagination?: PaginationParams | null, filter?: AssetFilter): Promise<ListPage<AssetEntity>> {
    const q: Document = { team_id: teamId };
    if (filter?.asset_type) q.asset_type = filter.asset_type;
    if (filter?.status) q.status = filter.status;
    if (filter?.owner_user_id) q.owner_user_id = filter.owner_user_id;
    if (filter?.visibility) q.visibility = filter.visibility;
    return this.paginatedFind("meta_assets", q, pagination, { created_at: -1 }, (d) => d as AssetEntity);
  }

  async touchAssetUsage(assetId: string): Promise<void> {
    await this.col("meta_assets").updateOne(
      { asset_id: assetId },
      { $inc: { usage_count: 1 }, $set: { last_used_at: nowIso() } },
    );
  }

  // ============================================================
  // AgentFixedAsset（全量替换）
  // ============================================================
  async setAgentFixedAssets(agentId: string, bindings: FixedAssetBindingInput[]): Promise<void> {
    const now = nowIso();
    for (let attempt = 0; attempt < RELATION_ID_RETRY_LIMIT; attempt++) {
      try {
        await this.withTx(async (session) => {
          await this.col("meta_agent_fixed_assets").deleteMany({ agent_id: agentId }, { session });
          if (bindings.length > 0) {
            await this.col("meta_agent_fixed_assets").insertMany(
              bindings.map((b) => ({
                id: generateRelationId(),
                agent_id: agentId,
                asset_id: b.asset_id,
                asset_type: b.asset_type,
                injection_mode: b.injection_mode ?? "summary",
                priority: b.priority ?? 50,
                created_by: b.created_by,
                created_at: now,
              })),
              { session },
            );
          }
        });
        return;
      } catch (err) {
        if (isMongoRelationIdCollision(err)) continue;
        throw err;
      }
    }
    throw new Error("relation id collision after max retries");
  }

  async addAgentFixedAsset(agentId: string, b: FixedAssetBindingInput): Promise<void> {
    // (agent_id, asset_id) 上有 unique index（见 initIndexes）。冲突 = 已存在
    // → 视作 no-op，天然幂等。
    try {
      await this.col("meta_agent_fixed_assets").insertOne({
        id: generateRelationId(),
        agent_id: agentId,
        asset_id: b.asset_id,
        asset_type: b.asset_type,
        injection_mode: b.injection_mode ?? "summary",
        priority: b.priority ?? 50,
        created_by: b.created_by,
        created_at: nowIso(),
      });
    } catch (err) {
      // E11000 on (agent_id, asset_id) → already bound, ignore
      if (typeof err === "object" && err !== null && (err as { code?: number }).code === 11000) {
        return;
      }
      throw err;
    }
  }

  async listAgentFixedAssets(
    agentId: string,
    pagination?: PaginationParams | null,
    filter?: { assetTypes?: readonly string[] },
  ): Promise<ListPage<FixedAssetBindingEntity>> {
    const types = filter?.assetTypes ?? [];
    if (types.length === 0) {
      return this.paginatedFind(
        "meta_agent_fixed_assets",
        { agent_id: agentId },
        pagination,
        { priority: -1, created_at: -1 },
        (d) => d as FixedAssetBindingEntity,
      );
    }
    // 类型过滤：先按 asset_type 拿 asset_id 集合，再用它过滤 binding。
    const assetIds = await this.col("meta_assets")
      .find({ asset_type: { $in: [...types] } } as Document, { projection: { asset_id: 1 } })
      .map((d) => (d as { asset_id: string }).asset_id)
      .toArray();
    if (assetIds.length === 0) {
      return { items: [], total: 0 };
    }
    return this.paginatedFind(
      "meta_agent_fixed_assets",
      { agent_id: agentId, asset_id: { $in: assetIds } },
      pagination,
      { priority: -1, created_at: -1 },
      (d) => d as FixedAssetBindingEntity,
    );
  }

  async getAgentFixedAsset(agentId: string, assetId: string): Promise<FixedAssetBindingEntity | null> {
    return this.col<FixedAssetBindingEntity>("meta_agent_fixed_assets").findOne(
      { agent_id: agentId, asset_id: assetId } as Document,
      PROJECT_NO_ID,
    ) as Promise<FixedAssetBindingEntity | null>;
  }

  async summarizeAgentFixedAssetsByAgents(
    agentIds: string[],
    options?: { assetId?: string },
  ): Promise<AgentFixedAssetCountRow[]> {
    if (agentIds.length === 0) return [];
    const match: Document = { agent_id: { $in: agentIds } };
    if (options?.assetId) match.asset_id = options.assetId;
    const rows = await this.col("meta_agent_fixed_assets")
      .aggregate<{ _id: { agent_id: string; asset_type: string }; cnt: number }>([
        { $match: match },
        {
          $group: {
            _id: { agent_id: "$agent_id", asset_type: "$asset_type" },
            assets: { $addToSet: "$asset_id" },
          },
        },
        {
          $project: {
            _id: 1,
            cnt: { $size: "$assets" },
          },
        },
      ])
      .toArray();
    return rows.map((r) => ({
      agent_id: r._id.agent_id,
      asset_type: r._id.asset_type as AssetType,
      cnt: r.cnt,
    }));
  }

  // ============================================================
  // ACL
  // ============================================================
  async grantAcl(input: GrantAclInput): Promise<AclEntity> {
    const now = nowIso();
    await runWithGeneratedRelationId(input.id, isMongoRelationIdCollision, async (id) => {
      await this.col("meta_asset_acl").updateOne(
        { asset_id: input.asset_id, subject_type: input.subject_type, subject_id: input.subject_id, permission: input.permission },
        {
          $set: { effect: input.effect ?? "allow", granted_by: input.granted_by, updated_at: now },
          $setOnInsert: {
            id,
            asset_id: input.asset_id,
            subject_type: input.subject_type,
            subject_id: input.subject_id,
            permission: input.permission,
            created_at: now,
          },
        },
        { upsert: true },
      );
    });
    return (await this.col<AclEntity>("meta_asset_acl").findOne(
      { asset_id: input.asset_id, subject_type: input.subject_type, subject_id: input.subject_id, permission: input.permission } as Document,
      PROJECT_NO_ID,
    )) as AclEntity;
  }

  async getAclById(id: string): Promise<AclEntity | null> {
    return (await this.col<AclEntity>("meta_asset_acl").findOne({ id } as Document, PROJECT_NO_ID)) as AclEntity | null;
  }

  async revokeAcl(id: string): Promise<void> {
    await this.col("meta_asset_acl").deleteOne({ id });
  }

  async listAclByAsset(assetId: string, pagination?: PaginationParams | null): Promise<ListPage<AclEntity>> {
    return this.paginatedFind("meta_asset_acl", { asset_id: assetId }, pagination, { created_at: -1 }, (d) => d as AclEntity);
  }

  async listAclBySubject(subjectType: string, subjectId: string, pagination?: PaginationParams | null): Promise<ListPage<AclEntity>> {
    return this.paginatedFind(
      "meta_asset_acl",
      { subject_type: subjectType, subject_id: subjectId },
      pagination,
      { created_at: -1 },
      (d) => d as AclEntity,
    );
  }

  // ============================================================
  // Helpers
  // ============================================================
  private async patchOne(
    collection: string,
    filter: Document,
    patch: Record<string, unknown>,
    allowed: string[],
    touchUpdatedAt: boolean,
  ): Promise<void> {
    const set: Record<string, unknown> = {};
    for (const k of allowed) {
      if (k in patch && patch[k] !== undefined) set[k] = patch[k];
    }
    if (touchUpdatedAt) set.updated_at = nowIso();
    if (Object.keys(set).length === 0) return;
    await this.col(collection).updateOne(filter, { $set: set });
  }

  private async batchDelete(collection: string, pkCol: string, ids: string[]): Promise<BatchDeleteResult> {
    const result: BatchDeleteResult = { deleted_ids: [], failed: [] };
    for (const id of ids) {
      const res = await this.col(collection).deleteOne({ [pkCol]: id });
      if (res.deletedCount && res.deletedCount > 0) result.deleted_ids.push(id);
      else result.failed.push({ id, reason: "not_found" });
    }
    return result;
  }

  // ============================================================
  // ConfigParam
  // ============================================================

  private async nextConfigParamId(): Promise<number> {
    const result = await this.col("meta_counters").findOneAndUpdate(
      { _id: "meta_config_params" } as any,
      { $inc: { seq: 1 } },
      { upsert: true, returnDocument: "after" },
    );
    return (result as any).seq as number;
  }

  async getConfigParam(
    scope: "global" | "user",
    userId: string | null,
    module: string,
    paramName: string,
  ): Promise<ConfigParamEntity | null> {
    const filter: Document =
      scope === "global"
        ? { scope: "global", user_id: null, module, param_name: paramName }
        : { scope: "user", user_id: userId, module, param_name: paramName };
    const doc = await this.col("meta_config_params").findOne(filter, PROJECT_NO_ID);
    return doc ? (doc as unknown as ConfigParamEntity) : null;
  }

  async upsertConfigParam(input: UpsertConfigParamInput): Promise<ConfigParamEntity> {
    const now = nowIso();
    const filter: Document =
      input.scope === "global"
        ? { scope: "global", user_id: null, module: input.module, param_name: input.param_name }
        : { scope: "user", user_id: input.user_id, module: input.module, param_name: input.param_name };

    const id = await this.nextConfigParamId();
    await this.col("meta_config_params").findOneAndUpdate(
      filter,
      {
        $set: {
          param_value: input.param_value,
          description: input.description,
          updated_at: now,
        },
        $setOnInsert: {
          id,
          scope: input.scope,
          user_id: input.scope === "user" ? input.user_id : null,
          module: input.module,
          param_name: input.param_name,
          created_at: now,
        },
      },
      { upsert: true, returnDocument: "after" },
    );

    const result = await this.getConfigParam(
      input.scope,
      input.scope === "user" ? input.user_id! : null,
      input.module,
      input.param_name,
    );
    return result!;
  }

  async listConfigParams(filter: ListConfigParamsFilter): Promise<ConfigParamEntity[]> {
    const query: Document = { module: filter.module };

    if (filter.scope) {
      query.scope = filter.scope;
    }
    if (filter.userId) {
      query.$or = [
        { scope: "global" },
        { scope: "user", user_id: filter.userId },
      ];
    }
    if (filter.paramNames && filter.paramNames.length > 0) {
      query.param_name = { $in: filter.paramNames };
    }

    const docs = await this.col("meta_config_params")
      .find(query, PROJECT_NO_ID)
      .sort({ scope: 1, param_name: 1 })
      .toArray();
    return docs as unknown as ConfigParamEntity[];
  }
}

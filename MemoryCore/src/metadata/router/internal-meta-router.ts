import { subscriptionResolveSchema } from "./v3-meta-schemas.js";
import { ModelConnectionError } from "../models/types.js";
/**
 * v3 内部元数据路由（/v3/internal/meta/*）。
 * 运维 / 控制面专用；不写入公开 MetadataClient。
 */
import type * as http from "node:http";
import type { ZodType } from "zod";
import {
  successEnvelope,
  errorEnvelope,
  resolveRequestId,
  makeRequestId,
} from "../../gateway/v2-router.js";
import { formatZodError, type ApiResponseEnvelope } from "../../gateway/v2-schemas.js";
import type { Logger } from "../../core/types.js";
import { SkillCoreError, type SkillCore } from "../../core/skill/skill-core.js";
import { MetadataService, MetadataError } from "../service/metadata-service.js";
import { extractInstanceId, normalizeInstanceIdForRoute } from "./instance.js";
import { resolvePagination } from "./pagination.js";
import {
  internalAssetFinalizeDeleteSchema,
  internalAssetFinalizeTransferSchema,
  internalAssetGetSchema,
  internalSkillSetLockSchema,
  internalAssetPrepareTransferSchema,
  internalAssetResolveTransferSchema,
  internalBoundAssetFinalizeTransferSchema,
  internalAgentCreateForHandoffSchema,
  internalSkillFinalizeTransferSchema,
  internalSkillTransferOwnerSchema,
  internalListUsersByInstanceSchema,
  supportedAgentsSchema,
  initAdminSchema,
  instanceUpstreamInternalListSchema,
} from "./v3-meta-schemas.js";
import {
  createMetaApiTraceContext,
  logMetaApiEntry,
  logMetaApiError,
  logMetaApiRejected,
  logMetaApiResponse,
} from "./meta-api-trace.js";
import {
  getApiTraceConfig,
  runWithApiRequestContext,
} from "../../api-trace/index.js";

export const V3_INTERNAL_PREFIX = "/v3/internal/meta";

const TAG = "[META-V3-INTERNAL]";

export interface InternalMetaRouterDeps {
  getMetadataService: (instanceId: string) => MetadataService | undefined | Promise<MetadataService | undefined>;
  getSkillCore: (instanceId: string) => SkillCore | undefined | Promise<SkillCore | undefined>;
  logger: Logger;
  /**
   * v2 InstanceUpstream:Proxy 拉数据时会触发 seed default 组,seed 逻辑依赖 supported-agents 数据源。
   * 与 v3-meta-router 的 deps.getSupportedAgents 是同一份数据(Core 启动时从 gateway yaml 读)。
   */
  getSupportedAgents: () => import("../types.js").SupportedAgent[];
}

interface InternalRuntimeDeps {
  getSupportedAgents: () => import("../types.js").SupportedAgent[];
}

type InternalHandler = (
  body: unknown,
  /** 免 instance 路由(NO_INSTANCE_ROUTES)下为 undefined —— 这类 handler 不得使用。 */
  svc: MetadataService | undefined,
  instanceId: string,
  requestId: string,
  deps: InternalMetaRouterDeps,
) => Promise<ApiResponseEnvelope>;

function bind<S extends ZodType>(
  schema: S,
  fn: (data: S["_output"], svc: MetadataService, instanceId: string, deps: InternalMetaRouterDeps) => Promise<unknown>,
): InternalHandler {
  return async (body, svc, instanceId, requestId, deps) => {
    const parsed = schema.safeParse(body);
    if (!parsed.success) return errorEnvelope(400, formatZodError(parsed.error), requestId);
    if (!svc) throw new Error("Metadata service unavailable for instance route");
    const data = await fn(parsed.data as S["_output"], svc, instanceId, deps);
    return successEnvelope(data, requestId);
  };
}

/** 免 instance 路由专用:handler 不接收 svc / instanceId。 */
function bindInstanceFree<S extends ZodType>(
  schema: S,
  fn: (data: S["_output"], runtime: InternalRuntimeDeps) => Promise<unknown>,
): InternalHandler {
  return async (body, _svc, _instanceId, requestId, runtime) => {
    const parsed = schema.safeParse(body);
    if (!parsed.success) return errorEnvelope(400, formatZodError(parsed.error), requestId);
    const data = await fn(parsed.data as S["_output"], runtime);
    return successEnvelope(data, requestId);
  };
}

const routeTable: Record<string, InternalHandler> = {
  [`${V3_INTERNAL_PREFIX}/user/init-admin`]: bind(initAdminSchema, (d, svc) => svc.initAdminUser(d)),
  [`${V3_INTERNAL_PREFIX}/user/list-by-instance`]: bind(
    internalListUsersByInstanceSchema,
    async (d, svc, instanceId) => {
      const pagination = resolvePagination(d);
      return svc.listUsersByInstance(instanceId, pagination, {
        status: d.status,
        user_type: d.user_type,
        user_ids: d.user_ids,
      });
    },
  ),
  [`${V3_INTERNAL_PREFIX}/asset/finalize-delete`]: bind(
    internalAssetFinalizeDeleteSchema,
    (d, svc) => svc.finalizeAssetDeleteInternal(d.asset_id, d.expected_owner_user_id),
  ),
  [`${V3_INTERNAL_PREFIX}/asset/get`]: bind(
    internalAssetGetSchema,
    async (d, svc) => {
      const asset = await svc.getAssetById(d.asset_id);
      if (!asset) throw new MetadataError("asset_not_found", `asset not found: ${d.asset_id}`);
      return asset;
    },
  ),
  [`${V3_INTERNAL_PREFIX}/skill/set-lock`]: bind(
    internalSkillSetLockSchema,
    (d, svc) => svc.setSkillLockInternal(d.asset_id, d.expected_owner_user_id, d.locked),
  ),
  [`${V3_INTERNAL_PREFIX}/asset/finalize-transfer`]: bind(
    internalAssetFinalizeTransferSchema,
    (d, svc) => svc.finalizeAssetTransferInternal(d),
  ),
  [`${V3_INTERNAL_PREFIX}/asset/finalize-bound-transfer`]: bind(
    internalBoundAssetFinalizeTransferSchema,
    (d, svc) => svc.finalizeBoundAssetTransferInternal(d),
  ),
  [`${V3_INTERNAL_PREFIX}/agent/create-for-handoff`]: bind(
    internalAgentCreateForHandoffSchema,
    (d, svc) => svc.createAgentForHandoffInternal(d),
  ),
  [`${V3_INTERNAL_PREFIX}/asset/prepare-transfer`]: bind(
    internalAssetPrepareTransferSchema,
    (d, svc) => svc.prepareAssetTransferInternal(d),
  ),
  [`${V3_INTERNAL_PREFIX}/skill/transfer-owner`]: bind(
    internalSkillTransferOwnerSchema,
    async (d, _svc, instanceId, deps) => {
      const core = await deps.getSkillCore(instanceId);
      if (!core) throw new MetadataError("lifecycle_coordinator_unavailable", "Skill lifecycle coordinator unavailable");
      try {
        return await core.transferOwnership(d);
      } catch (error) {
        if (error instanceof SkillCoreError) throw new MetadataError(error.code.toLowerCase(), error.message);
        throw error;
      }
    },
  ),
  [`${V3_INTERNAL_PREFIX}/skill/finalize-transfer`]: bind(
    internalSkillFinalizeTransferSchema,
    (d, svc) => svc.finalizeSkillTransferInternal(d),
  ),
  [`${V3_INTERNAL_PREFIX}/asset/resolve-transfer`]: bind(
    internalAssetResolveTransferSchema,
    async (d, svc) => {
      await svc.resolveAssetTransferInternal(d);
      return { ok: true };
    },
  ),
  // §6.D:Proxy 拉全量配置(明文 api_key),同时触发 seed default 组。
  [`${V3_INTERNAL_PREFIX}/model-connections/chatgpt/resolve`]: bind(subscriptionResolveSchema,
    async (d, svc) => svc.modelCatalog.resolveSubscription(d)),
  [`${V3_INTERNAL_PREFIX}/instance-upstream/list`]: bind(
    instanceUpstreamInternalListSchema,
    async (_d, svc, _instanceId, runtime) =>
      svc.listInstanceUpstreamGroupsInternal(runtime.getSupportedAgents()),
  ),
  [`${V3_INTERNAL_PREFIX}/instance-upstream/model`]: bind(
    instanceUpstreamInternalListSchema,
    async (_d, svc, _instanceId, deps) => svc.getConversationModelsInternal(deps.getSupportedAgents()),
  ),
  // §6.A 的内部镜像:与 /v3/meta/upstream/supported-agents 同一份数据源
  // (Core 启动时从 gateway yaml 的 upstream.supportedAgents 读),供无 user-key 的
  // 控制面服务(shark 等)取 agent 全集。
  //
  // 与公开版的两点差异,都是有意为之:
  //   1. 不做 assertCanManageUsers —— 本族只校验 Layer 1 Bearer,不解析用户身份;
  //   2. 不调 ensureDefaultSeeded —— 保持只读语义。seed 继续由公开的 §6.A 接口
  //      与 §6.D 的 instance-upstream/list 负责(二者共用 store 层 seed 逻辑),
  //      这里少一次不构成空洞。
  //
  // 免 instance_id:数据源是 Core 级 yaml,不落任何实例库,且调用方(实例发货流程)
  // 此刻实例本身还不存在。见 NO_INSTANCE_ROUTES。
  [`${V3_INTERNAL_PREFIX}/upstream/supported-agents`]: bindInstanceFree(
    supportedAgentsSchema,
    async (_d, runtime) => ({ items: runtime.getSupportedAgents() }),
  ),
};

/**
 * 免 `x-tdai-service-id` 的内部路由。
 *
 * 仅限"不接触任何实例库"的只读路由 —— 分发层的 instance 解析会顺带构造该实例的
 * metadata store,对发货期(实例尚未创建)的调用方是无意义的副作用。
 * 加新条目时必须确认 handler 不使用 svc / instanceId。
 */
const NO_INSTANCE_ROUTES = new Set<string>([
  `${V3_INTERNAL_PREFIX}/upstream/supported-agents`,
]);

export const V3_INTERNAL_ROUTES = Object.keys(routeTable);

function mapErrorCode(code: string): number {
  if (code.endsWith("_not_found")) return 404;
  if (code === "permission_denied") return 403;
  if (code === "missing_instance_id" || code === "invalid_instance_id") return 400;
  if (code === "already_initialized" || code === "last_system_admin" || code === "member_already_exists"
    || code === "stale_lifecycle_operation" || code === "target_not_active_member"
    || code === "team_skill_required" || code === "invalid_asset_metadata") return 409;
  if (code === "user_limit_exceeded" || code === "team_limit_exceeded") return 409;
  return 400;
}

function resolveInstanceId(req: http.IncomingMessage, bodyInstance?: string): string {
  try {
    const fromHeader = extractInstanceId(req.headers);
    if (fromHeader) return fromHeader;
  } catch {
    /* fall through */
  }
  return bodyInstance?.trim() ?? "";
}

/**
 * 内部分发：仅 Bearer（Layer 1 已在 gateway 校验）；跳过 x-tdai-user-key。
 */
export async function handleInternalMetaRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  method: string,
  parseJsonBody: <T>(req: http.IncomingMessage) => Promise<T>,
  sendJson: (res: http.ServerResponse, status: number, body: unknown) => void,
  deps: InternalMetaRouterDeps,
): Promise<boolean> {
  if (!pathname.startsWith(V3_INTERNAL_PREFIX) || method !== "POST") return false;

  const handler = routeTable[pathname];
  if (!handler) {
    sendJson(res, 404, errorEnvelope(404, "not_found", makeRequestId()));
    return true;
  }

  const requestId = resolveRequestId(req.headers as Record<string, string | string[] | undefined>);
  const traceCtx = createMetaApiTraceContext({ route: pathname, requestId, internal: true });

  try {
    const body = await parseJsonBody<Record<string, unknown>>(req);
    const bodyInstance =
      typeof body.instance_id === "string" ? body.instance_id : undefined;

    // 免 instance 路由:不解析 id、不构造该实例的 metadata store。
    const skipInstance = NO_INSTANCE_ROUTES.has(pathname);
    let instanceId = "";
    if (!skipInstance) {
      try {
        instanceId = normalizeInstanceIdForRoute(resolveInstanceId(req, bodyInstance));
      } catch (err) {
        if (err instanceof MetadataError) {
          const code = mapErrorCode(err.code);
          logMetaApiRejected(traceCtx, {
            httpStatus: code,
            envelopeCode: code,
            message: err.code,
            body,
          });
          sendJson(res, code, errorEnvelope(code, err.code, requestId));
          return true;
        }
        throw err;
      }
      traceCtx.instanceId = instanceId;
    }

    const svc = skipInstance
      ? undefined
      : await Promise.resolve(deps.getMetadataService(instanceId));
    if (!svc && !skipInstance) {
      logMetaApiRejected(traceCtx, {
        httpStatus: 503,
        envelopeCode: 503,
        message: "MetadataService not available",
        body,
      });
      sendJson(res, 503, errorEnvelope(503, "MetadataService not available", requestId));
      return true;
    }

    const traceModule = getApiTraceConfig().policy.module;
    await runWithApiRequestContext(
      {
        requestId,
        route: pathname,
        module: traceModule,
        instanceId,
        internal: true,
      },
      async () => {
        logMetaApiEntry(traceCtx, body);
        deps.logger.debug?.(`${TAG} ${pathname} instance=${instanceId}`);
      const envelope = await handler(body, svc, instanceId, requestId, deps);
        const httpStatus = envelope.code === 0 ? 200 : envelope.code >= 400 && envelope.code < 600 ? envelope.code : 200;
        logMetaApiResponse(traceCtx, envelope, httpStatus);
        sendJson(res, httpStatus, envelope);
      },
    );
    return true;
  } catch (err) {
    if (err instanceof ModelConnectionError) {
      sendJson(res, err.status, errorEnvelope(err.status, err.code, requestId));
      return true;
    }
    if (err instanceof MetadataError) {
      const code = mapErrorCode(err.code);
      const message = `${err.code}: ${err.message}`;
      logMetaApiError(traceCtx, err, { envelopeCode: code, httpStatus: code });
      sendJson(res, code, errorEnvelope(code, message, requestId));
      return true;
    }
    const msg = err instanceof Error ? err.message : String(err);
    deps.logger.error?.(`${TAG} unexpected: ${msg}`);
    logMetaApiError(traceCtx, err, { envelopeCode: 500, httpStatus: 500 });
    sendJson(res, 500, errorEnvelope(500, "internal_error", requestId));
    return true;
  }
}

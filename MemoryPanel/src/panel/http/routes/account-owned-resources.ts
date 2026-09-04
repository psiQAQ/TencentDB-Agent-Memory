/** Owner-only permanent cleanup used to finish Team offboarding safely. */
import { randomUUID } from 'node:crypto';
import type { Hono } from 'hono';
import type { PanelDeps } from '../../panel-deps.js';
import { toKernelCredentials, type MetaCallContext } from '../../kernel/types.js';
import { validatePanelMetaHeaders } from '../middleware/validate-panel-headers.js';
import { respondControlError, respondEnvelope } from '../envelope.js';
import { getAgentTemplate } from '../../state/agent-template-store.js';
import {
  buildCtx,
  extractListItems,
  okEnvelope,
  readJson,
  resolveCallerUserId,
  str,
} from './knowledge/common.js';

type ResourceType = 'agent' | 'task' | 'asset';

interface ResourceRef {
  resource_type: ResourceType;
  resource_id: string;
}

interface OwnedEntity {
  resource_type: ResourceType;
  resource_id: string;
  team_id: string;
  owner_user_id: string;
  asset_type?: 'skill' | 'llm_wiki' | 'code_graph' | 'chat_memory';
}

interface SkillRow {
  skill_id: string;
  version: number;
  owner_agent_id?: string;
}

interface DeleteResult {
  deleted_ids?: string[];
  failed?: Array<{ id: string; reason: string }>;
}

interface BoundAsset {
  asset_id: string;
  team_id: string;
  owner_user_id: string;
  asset_type: 'skill' | 'llm_wiki' | 'code_graph' | 'chat_memory' | string;
}

async function listAgentBoundAssets(
  deps: PanelDeps,
  ctx: MetaCallContext,
  agentId: string,
): Promise<BoundAsset[]> {
  const assets: BoundAsset[] = [];
  for (let offset = 0; ; offset += 100) {
    const env = await deps.metaKernel.invoke(
      'agent-fixed-asset/list',
      { agent_id: agentId, limit: 100, offset },
      ctx,
    );
    if (env.code !== 0) throw new Error(env.message || 'AGENT_FIXED_ASSET_LIST_FAILED');
    const bindings = extractListItems<{ asset_id: string }>(env);
    for (const binding of bindings) {
      const assetEnv = await deps.metaKernel.invoke('asset/get', { asset_id: binding.asset_id }, ctx);
      if (assetEnv.code === 404) throw new Error(`BOUND_ASSET_NOT_FOUND: ${binding.asset_id}`);
      if (assetEnv.code !== 0) throw new Error(assetEnv.message || 'ASSET_LOOKUP_FAILED');
      const asset = assetEnv.data as BoundAsset | null;
      if (!asset) throw new Error(`BOUND_ASSET_NOT_FOUND: ${binding.asset_id}`);
      assets.push(asset);
    }
    const total = (env.data as { total?: number } | null)?.total ?? assets.length;
    if (bindings.length === 0 || offset + bindings.length >= total) break;
  }
  return assets;
}

async function transferKnowledgeWithJournal(
  deps: PanelDeps,
  ctx: MetaCallContext,
  input: {
    team_id: string;
    asset_id: string;
    asset_type: 'llm_wiki' | 'code_graph';
    from_owner_user_id: string;
    to_owner_user_id: string;
    from_agent_id?: string;
    to_agent_id?: string;
    idempotency_key: string;
  },
): Promise<Record<string, unknown>> {
  const operationBody = {
    team_id: input.team_id,
    asset_id: input.asset_id,
    from_owner_user_id: input.from_owner_user_id,
    to_owner_user_id: input.to_owner_user_id,
    idempotency_key: input.idempotency_key,
  };
  const prepareEnv = await deps.kernelHttp.postEnvelope<{ operation_id: string; status: string }>(
    '/v3/internal/meta/asset/prepare-transfer',
    operationBody,
    toKernelCredentials(ctx, { timeoutMs: deps.config.metadataRemoteTimeoutMs }, { omitUserKey: true }),
  );
  if (prepareEnv.code !== 0) throw new Error(prepareEnv.message || 'CORE_PREPARE_FAILED');
  const kc = deps.knowledgeClientFactory(ctx.instanceId);
  try {
    await kc.transferOwnership({
      resource_type: input.asset_type,
      resource_id: input.asset_id,
      from_owner_user_id: input.from_owner_user_id,
      to_owner_user_id: input.to_owner_user_id,
    });
  } catch (err) {
    await resolveKnowledgeTransfer(deps, ctx, operationBody, 'failed', 'KNOWLEDGE_TRANSFER_FAILED').catch(() => {});
    throw err;
  }
  const coreEnv = await deps.kernelHttp.postEnvelope<Record<string, unknown>>(
    input.from_agent_id && input.to_agent_id
      ? '/v3/internal/meta/asset/finalize-bound-transfer'
      : '/v3/internal/meta/asset/finalize-transfer',
    {
      ...operationBody,
      ...(input.from_agent_id && input.to_agent_id
        ? { from_agent_id: input.from_agent_id, to_agent_id: input.to_agent_id }
        : {}),
    },
    toKernelCredentials(ctx, { timeoutMs: deps.config.metadataRemoteTimeoutMs }, { omitUserKey: true }),
  );
  if (coreEnv.code === 0) return coreEnv.data ?? { resource_type: 'asset', resource_id: input.asset_id, transferred: true };
  try {
    await kc.transferOwnership({
      resource_type: input.asset_type,
      resource_id: input.asset_id,
      from_owner_user_id: input.to_owner_user_id,
      to_owner_user_id: input.from_owner_user_id,
    });
  } catch {
    await resolveKnowledgeTransfer(
      deps,
      ctx,
      operationBody,
      'inconsistent_retryable',
      'CORE_FINALIZE_AND_COMPENSATION_FAILED',
    ).catch(() => {});
    throw new Error('INCONSISTENT_RETRYABLE');
  }
  await resolveKnowledgeTransfer(deps, ctx, operationBody, 'failed', 'CORE_FINALIZE_FAILED');
  throw new Error(coreEnv.message || 'CORE_FINALIZE_FAILED');
}

async function createHandoffAgent(
  deps: PanelDeps,
  ctx: MetaCallContext,
  teamId: string,
  userId: string,
): Promise<{ agent_id: string; name: string }> {
  const userEnv = await deps.metaKernel.invoke('user/get', { user_id: userId }, ctx);
  if (userEnv.code !== 0) throw new Error(userEnv.message || 'USER_LOOKUP_FAILED');
  const username = (userEnv.data as { username?: string } | null)?.username ?? userId;
  const template = getAgentTemplate(deps.config.agentTemplateDir, ctx.instanceId, teamId);
  const name = template?.name ? `${template.name}-${username}` : `default-agent-${username}`;
  const metadata = JSON.stringify({
    ui: { role_prompt: '', rules_prompt: '' },
    panel_provisioning: {
      source: 'ownership_handoff',
      schema_version: 1,
      team_id: teamId,
      created_for_user_id: userId,
    },
  });
  const env = await deps.kernelHttp.postEnvelope<{ agent_id: string; name: string }>(
    '/v3/internal/meta/agent/create-for-handoff',
    {
      team_id: teamId,
      owner_user_id: userId,
      name,
      description: template?.description ?? '用于接收 ownership 交接资产的默认 Agent。',
      prompt: template?.prompt ?? '',
      visibility: template?.visibility ?? 'team',
      metadata_json: metadata,
    },
    toKernelCredentials(ctx, { timeoutMs: deps.config.metadataRemoteTimeoutMs }, { omitUserKey: true }),
  );
  if (env.code !== 0 || !env.data) throw new Error(env.message || 'HANDOFF_AGENT_CREATE_FAILED');
  return env.data;
}

async function transferSkillWithJournal(
  deps: PanelDeps,
  ctx: MetaCallContext,
  input: {
    team_id: string;
    asset_id: string;
    from_owner_user_id: string;
    to_owner_user_id: string;
    from_agent_id: string;
    to_agent_id: string;
    idempotency_key: string;
  },
): Promise<Record<string, unknown>> {
  const operationBody = {
    team_id: input.team_id,
    asset_id: input.asset_id,
    from_owner_user_id: input.from_owner_user_id,
    to_owner_user_id: input.to_owner_user_id,
    idempotency_key: input.idempotency_key,
  };
  const prepare = await deps.kernelHttp.postEnvelope(
    '/v3/internal/meta/asset/prepare-transfer',
    operationBody,
    toKernelCredentials(ctx, { timeoutMs: deps.config.metadataRemoteTimeoutMs }, { omitUserKey: true }),
  );
  if (prepare.code !== 0) throw new Error(prepare.message || 'CORE_PREPARE_FAILED');
  const backingBody = {
    skill_id: input.asset_id,
    team_id: input.team_id,
    from_agent_id: input.from_agent_id,
    to_agent_id: input.to_agent_id,
  };
  const backing = await deps.kernelHttp.postEnvelope(
    '/v3/internal/meta/skill/transfer-owner',
    backingBody,
    toKernelCredentials(ctx, { timeoutMs: deps.config.metadataRemoteTimeoutMs }, { omitUserKey: true }),
  );
  if (backing.code !== 0) {
    await resolveKnowledgeTransfer(deps, ctx, operationBody, 'failed', 'SKILL_BACKING_TRANSFER_FAILED').catch(() => {});
    throw new Error(backing.message || 'SKILL_BACKING_TRANSFER_FAILED');
  }
  const finalized = await deps.kernelHttp.postEnvelope<Record<string, unknown>>(
    '/v3/internal/meta/skill/finalize-transfer',
    { ...operationBody, from_agent_id: input.from_agent_id, to_agent_id: input.to_agent_id },
    toKernelCredentials(ctx, { timeoutMs: deps.config.metadataRemoteTimeoutMs }, { omitUserKey: true }),
  );
  if (finalized.code === 0) return finalized.data ?? { resource_type: 'asset', resource_id: input.asset_id, transferred: true };
  const compensated = await deps.kernelHttp.postEnvelope(
    '/v3/internal/meta/skill/transfer-owner',
    { ...backingBody, from_agent_id: input.to_agent_id, to_agent_id: input.from_agent_id },
    toKernelCredentials(ctx, { timeoutMs: deps.config.metadataRemoteTimeoutMs }, { omitUserKey: true }),
  );
  await resolveKnowledgeTransfer(
    deps,
    ctx,
    operationBody,
    compensated.code === 0 ? 'failed' : 'inconsistent_retryable',
    compensated.code === 0 ? 'CORE_FINALIZE_FAILED' : 'SKILL_COMPENSATION_FAILED',
  ).catch(() => {});
  if (compensated.code !== 0) throw new Error('INCONSISTENT_RETRYABLE');
  throw new Error(finalized.message || 'CORE_FINALIZE_FAILED');
}

function assertDeletedOrAbsent(result: DeleteResult, id: string, label: string): void {
  const failure = result.failed?.find((item) => item.id === id);
  if (failure && !/not[_ -]?found/i.test(failure.reason)) {
    throw new Error(`${label}: ${failure.reason}`);
  }
}

async function finalizeAssetDelete(
  deps: PanelDeps,
  ctx: MetaCallContext,
  assetId: string,
  ownerUserId: string,
): Promise<void> {
  const env = await deps.kernelHttp.postEnvelope<DeleteResult>(
    '/v3/internal/meta/asset/finalize-delete',
    { asset_id: assetId, expected_owner_user_id: ownerUserId },
    toKernelCredentials(ctx, { timeoutMs: deps.config.metadataRemoteTimeoutMs }, { omitUserKey: true }),
  );
  if (env.code !== 0) throw new Error(env.message || 'ASSET_FINALIZE_DELETE_FAILED');
  assertDeletedOrAbsent(env.data ?? {}, assetId, 'ASSET_FINALIZE_DELETE_FAILED');
}

async function deleteKnowledgeBackingAndMetadata(
  deps: PanelDeps,
  ctx: MetaCallContext,
  entity: OwnedEntity,
): Promise<void> {
  const kc = deps.knowledgeClientFactory(ctx.instanceId);
  const ksResult = entity.asset_type === 'llm_wiki'
    ? await kc.wikiDelete([entity.resource_id])
    : await kc.codeGraphDelete([entity.resource_id]);
  assertDeletedOrAbsent(ksResult, entity.resource_id, 'KNOWLEDGE_SERVICE_DELETE_FAILED');

  const detailEnv = await deps.kernelHttp.postEnvelope<DeleteResult>(
    '/v3/knowledge/delete',
    { knowledge_ids: [entity.resource_id], team_id: entity.team_id },
    toKernelCredentials(ctx, { timeoutMs: deps.config.metadataRemoteTimeoutMs }, { omitUserKey: true }),
  );
  if (detailEnv.code !== 0) throw new Error(detailEnv.message || 'KNOWLEDGE_DETAIL_DELETE_FAILED');
  assertDeletedOrAbsent(detailEnv.data ?? {}, entity.resource_id, 'KNOWLEDGE_DETAIL_DELETE_FAILED');

  await finalizeAssetDelete(deps, ctx, entity.resource_id, entity.owner_user_id);
}

function parseResourceRefs(body: Record<string, unknown>): ResourceRef[] | null {
  if (!Array.isArray(body.resources) || body.resources.length === 0 || body.resources.length > 100) return null;
  const refs: ResourceRef[] = [];
  const seen = new Set<string>();
  for (const raw of body.resources) {
    if (!raw || typeof raw !== 'object') return null;
    const item = raw as Record<string, unknown>;
    const type = item.resource_type;
    const id = item.resource_id;
    if ((type !== 'agent' && type !== 'task' && type !== 'asset') || typeof id !== 'string' || !id.trim()) {
      return null;
    }
    const key = `${type}:${id.trim()}`;
    if (!seen.has(key)) refs.push({ resource_type: type, resource_id: id.trim() });
    seen.add(key);
  }
  return refs;
}

async function listAgentSkills(
  deps: PanelDeps,
  ctx: MetaCallContext,
  userId: string,
  teamId: string,
  agentId?: string,
): Promise<SkillRow[]> {
  const all: SkillRow[] = [];
  for (let offset = 0; ; offset += 100) {
    const env = await deps.skillKernel.invoke('list', {
      user_id: userId,
      team_id: teamId,
      agent_id: agentId,
      filters: { status: ['active', 'archived'] },
      pagination: { limit: 100, offset },
    }, ctx);
    if (env.code !== 0) throw new Error(env.message || 'SKILL_LIST_FAILED');
    const batch = extractListItems<SkillRow>(env);
    all.push(...batch);
    const total = (env.data as { total?: number } | null)?.total ?? all.length;
    if (batch.length === 0 || all.length >= total) break;
  }
  return all;
}

async function deleteSkill(
  deps: PanelDeps,
  ctx: MetaCallContext,
  userId: string,
  teamId: string,
  skillId: string,
  knownAgentId?: string,
): Promise<void> {
  const skills = await listAgentSkills(deps, ctx, userId, teamId, knownAgentId);
  const skill = skills.find((item) => item.skill_id === skillId);
  if (!skill) {
    await finalizeAssetDelete(deps, ctx, skillId, userId);
    return;
  }
  const env = await deps.skillKernel.invoke('delete', {
    user_id: userId,
    team_id: teamId,
    agent_id: skill.owner_agent_id ?? knownAgentId,
    skill_id: skillId,
    expected_version: skill.version,
  }, ctx);
  if (env.code !== 0 && env.code !== 40401) throw new Error(env.message || 'SKILL_DELETE_FAILED');
  await finalizeAssetDelete(deps, ctx, skillId, userId);
}

async function clearAndDeleteChatMemory(
  deps: PanelDeps,
  ctx: MetaCallContext,
  memoryId: string,
  ownerUserId: string,
): Promise<void> {
  const env = await deps.kernelHttp.postEnvelope<{
    items?: Array<{ memory_id: string; cleared: boolean; reason?: string }>;
    all_cleared?: boolean;
  }>(
    '/v3/chat-memory/clear',
    { memory_ids: [memoryId] },
    toKernelCredentials(ctx, { timeoutMs: 60_000 }),
  );
  if (env.code !== 0 || env.data?.all_cleared === false) {
    throw new Error(env.message || env.data?.items?.[0]?.reason || 'CHAT_MEMORY_CLEAR_FAILED');
  }
  await finalizeAssetDelete(deps, ctx, memoryId, ownerUserId);
}

async function purgeAsset(
  deps: PanelDeps,
  ctx: MetaCallContext,
  userId: string,
  entity: OwnedEntity,
): Promise<void> {
  switch (entity.asset_type) {
    case 'skill':
      await deleteSkill(deps, ctx, userId, entity.team_id, entity.resource_id);
      return;
    case 'llm_wiki': {
      await deleteKnowledgeBackingAndMetadata(deps, ctx, entity);
      return;
    }
    case 'code_graph': {
      await deleteKnowledgeBackingAndMetadata(deps, ctx, entity);
      return;
    }
    case 'chat_memory':
      await clearAndDeleteChatMemory(deps, ctx, entity.resource_id, userId);
      return;
    default: {
      const env = await deps.metaKernel.invoke('asset/delete', { asset_ids: [entity.resource_id] }, ctx);
      if (env.code !== 0) throw new Error(env.message || 'ASSET_DELETE_FAILED');
      assertDeletedOrAbsent((env.data ?? {}) as DeleteResult, entity.resource_id, 'ASSET_DELETE_FAILED');
    }
  }
}

async function purgeAgent(
  deps: PanelDeps,
  ctx: MetaCallContext,
  userId: string,
  entity: OwnedEntity,
): Promise<string[]> {
  const deletedChildren: string[] = [];
  const skills = await listAgentSkills(deps, ctx, userId, entity.team_id, entity.resource_id);
  for (const skill of skills) {
    await deleteSkill(deps, ctx, userId, entity.team_id, skill.skill_id, entity.resource_id);
    deletedChildren.push(skill.skill_id);
  }
  const memoryId = `chat_memory-${entity.team_id}-${entity.resource_id}`;
  const memoryEnv = await deps.metaKernel.invoke('asset/get', { asset_id: memoryId }, ctx);
  if (memoryEnv.code === 0 && memoryEnv.data) {
    await clearAndDeleteChatMemory(deps, ctx, memoryId, userId);
    deletedChildren.push(memoryId);
  } else if (memoryEnv.code !== 404) {
    throw new Error(memoryEnv.message || 'CHAT_MEMORY_LOOKUP_FAILED');
  }
  const env = await deps.metaKernel.invoke('agent/delete', { agent_ids: [entity.resource_id] }, ctx);
  if (env.code !== 0) throw new Error(env.message || 'AGENT_DELETE_FAILED');
  assertDeletedOrAbsent((env.data ?? {}) as DeleteResult, entity.resource_id, 'AGENT_DELETE_FAILED');
  return deletedChildren;
}

export function registerAccountOwnedResourceRoutes(api: Hono, deps: PanelDeps): void {
  api.post('/account/ownership/transfer', validatePanelMetaHeaders(deps), async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const teamId = str(body, 'team_id');
    const idempotencyKey = str(body, 'idempotency_key');
    if (!teamId) return respondControlError(c, 400, 'MISSING_TEAM_ID');
    if (!idempotencyKey || !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(idempotencyKey)) {
      return respondControlError(c, 400, 'INVALID_IDEMPOTENCY_KEY');
    }
    if (str(body, 'confirmation') !== 'TRANSFER_OWNERSHIP') {
      return respondControlError(c, 400, 'CONFIRMATION_REQUIRED');
    }
    if (!Array.isArray(body.transfers) || body.transfers.length === 0 || body.transfers.length > 100) {
      return respondControlError(c, 400, 'INVALID_TRANSFERS');
    }
    const callerId = await resolveCallerUserId(deps, ctx);
    if (!callerId) return respondControlError(c, 401, 'INVALID_USER_KEY');
    type Transfer = {
      resource_type: 'team' | 'agent' | 'task' | 'asset';
      resource_id: string;
      to_user_id: string;
      from_agent_id?: string;
      to_agent_id?: string;
    };
    const requested: Transfer[] = [];
    const assetById = new Map<string, BoundAsset>();
    const automaticTargetAgentByUser = new Map<string, string>();
    let standaloneAssetTarget: { user_id: string; agent_id: string } | null = null;

    // Validate the complete batch before the first backing-store mutation.
    for (const raw of body.transfers) {
      if (!raw || typeof raw !== 'object') return respondControlError(c, 400, 'INVALID_TRANSFERS');
      const item = raw as Record<string, unknown>;
      const resourceType = item.resource_type;
      const resourceId = typeof item.resource_id === 'string' ? item.resource_id.trim() : '';
      const toUserId = typeof item.to_user_id === 'string' ? item.to_user_id.trim() : '';
      const fromAgentId = typeof item.from_agent_id === 'string' ? item.from_agent_id.trim() : undefined;
      const toAgentId = typeof item.to_agent_id === 'string' ? item.to_agent_id.trim() : undefined;
      if (!['team', 'agent', 'task', 'asset'].includes(String(resourceType)) || !resourceId || !toUserId) {
        return respondControlError(c, 400, 'INVALID_TRANSFERS');
      }
      const transfer = {
        resource_type: resourceType,
        resource_id: resourceId,
        to_user_id: toUserId,
        from_agent_id: fromAgentId,
        to_agent_id: toAgentId,
      } as Transfer;
      const targetEnv = await deps.metaKernel.invoke(
        'team-member/get',
        { team_id: teamId, user_id: toUserId },
        ctx,
      );
      if (targetEnv.code !== 0) return respondEnvelope(c, targetEnv);
      if ((targetEnv.data as { status?: string } | null)?.status !== 'active') {
        return respondControlError(c, 409, 'TARGET_NOT_ACTIVE_MEMBER');
      }
      if (resourceType === 'asset') {
        const assetEnv = await deps.metaKernel.invoke('asset/get', { asset_id: resourceId }, ctx);
        if (assetEnv.code !== 0) return respondEnvelope(c, assetEnv);
        const asset = assetEnv.data as BoundAsset | null;
        if (!asset || asset.team_id !== teamId) return respondControlError(c, 400, 'RESOURCE_TEAM_MISMATCH');
        if (asset.owner_user_id !== callerId) return respondControlError(c, 403, 'NOT_RESOURCE_OWNER');
        if (['skill', 'llm_wiki', 'code_graph', 'chat_memory'].includes(asset.asset_type)) {
          if (!fromAgentId) return respondControlError(c, 400, 'SOURCE_AGENT_REQUIRED');
          const sourceAgentEnv = await deps.metaKernel.invoke('agent/get', { agent_id: fromAgentId }, ctx);
          if (sourceAgentEnv.code !== 0) return respondEnvelope(c, sourceAgentEnv);
          const sourceAgent = sourceAgentEnv.data as { team_id?: string; owner_user_id?: string; status?: string } | null;
          if (!sourceAgent || sourceAgent.team_id !== teamId || sourceAgent.owner_user_id !== callerId) {
            return respondControlError(c, 409, 'SOURCE_AGENT_NOT_OWNED');
          }
          const sourceBindings = await listAgentBoundAssets(deps, ctx, fromAgentId);
          if (!sourceBindings.some((binding) => binding.asset_id === resourceId)) {
            return respondControlError(c, 409, 'SOURCE_ASSET_BINDING_NOT_FOUND');
          }

          let resolvedTargetAgentId = toAgentId ?? automaticTargetAgentByUser.get(toUserId);
          if (!resolvedTargetAgentId) {
            const agentsEnv = await deps.metaKernel.invoke('agent/list', {
              team_id: teamId,
              owner_user_id: toUserId,
              status: 'active',
              limit: 2,
              offset: 0,
            }, ctx);
            if (agentsEnv.code !== 0) return respondEnvelope(c, agentsEnv);
            const targetAgents = extractListItems<{ agent_id: string; metadata_json?: string }>(agentsEnv);
            const handoffAgent = targetAgents.find((candidate) => {
              try {
                const metadata = JSON.parse(candidate.metadata_json ?? '{}') as {
                  panel_provisioning?: { source?: string; created_for_user_id?: string };
                };
                return metadata.panel_provisioning?.source === 'ownership_handoff'
                  && metadata.panel_provisioning.created_for_user_id === toUserId;
              } catch {
                return false;
              }
            });
            if (handoffAgent) {
              resolvedTargetAgentId = handoffAgent.agent_id;
              automaticTargetAgentByUser.set(toUserId, resolvedTargetAgentId);
            } else if (targetAgents.length > 0) {
              return respondControlError(c, 400, 'TARGET_AGENT_REQUIRED');
            }
          }
          if (!resolvedTargetAgentId) {
            try {
              resolvedTargetAgentId = (await createHandoffAgent(deps, ctx, teamId, toUserId)).agent_id;
              automaticTargetAgentByUser.set(toUserId, resolvedTargetAgentId);
            } catch (err) {
              return respondControlError(c, 502, err instanceof Error ? err.message : 'HANDOFF_AGENT_CREATE_FAILED');
            }
          }
          if (standaloneAssetTarget &&
            (standaloneAssetTarget.user_id !== toUserId || standaloneAssetTarget.agent_id !== resolvedTargetAgentId)) {
            return respondControlError(c, 400, 'ASSET_TRANSFER_TARGET_MUST_MATCH');
          }
          standaloneAssetTarget = { user_id: toUserId, agent_id: resolvedTargetAgentId };
          transfer.to_agent_id = resolvedTargetAgentId;
          const targetAgentEnv = await deps.metaKernel.invoke('agent/get', { agent_id: resolvedTargetAgentId }, ctx);
          if (targetAgentEnv.code !== 0) return respondEnvelope(c, targetAgentEnv);
          const targetAgent = targetAgentEnv.data as { team_id?: string; owner_user_id?: string; status?: string } | null;
          if (!targetAgent || targetAgent.team_id !== teamId || targetAgent.owner_user_id !== toUserId || targetAgent.status !== 'active') {
            return respondControlError(c, 409, 'TARGET_AGENT_NOT_ACTIVE');
          }
        }
        assetById.set(asset.asset_id, asset);
      }
      requested.push(transfer);
    }

    // Agent is the aggregate root. Every fixed binding remains attached. Assets
    // owned by the old Agent owner follow the Agent; assets owned by somebody
    // else keep their owner and remain shared bindings. An explicitly selected
    // child is therefore folded into its selected Agent instead of being sent as
    // an illegal standalone managed-asset transfer.
    const aggregateChildren = new Map<string, {
      asset: BoundAsset;
      to_user_id: string;
      agent_id: string;
    }>();
    try {
      for (const transfer of requested.filter((item) => item.resource_type === 'agent')) {
        for (const asset of await listAgentBoundAssets(deps, ctx, transfer.resource_id)) {
          if (asset.team_id !== teamId) {
            return respondControlError(c, 409, 'BOUND_ASSET_TEAM_MISMATCH');
          }
          assetById.set(asset.asset_id, asset);
          if (asset.owner_user_id !== callerId) continue;
          const existing = aggregateChildren.get(asset.asset_id);
          if (existing && existing.to_user_id !== transfer.to_user_id) {
            return respondControlError(c, 409, 'AGGREGATE_TRANSFER_TARGET_CONFLICT');
          }
          aggregateChildren.set(asset.asset_id, {
            asset,
            to_user_id: transfer.to_user_id,
            agent_id: transfer.resource_id,
          });
        }
      }
    } catch (err) {
      return respondControlError(c, 502, err instanceof Error ? err.message : 'AGGREGATE_PREFLIGHT_FAILED');
    }

    for (const transfer of requested.filter((item) => item.resource_type === 'asset')) {
      const child = aggregateChildren.get(transfer.resource_id);
      if (child && child.to_user_id !== transfer.to_user_id) {
        return respondControlError(c, 409, 'AGGREGATE_TRANSFER_TARGET_CONFLICT');
      }
    }

    const regular: Transfer[] = [];
    const knowledge: Array<Transfer & { asset_type: 'llm_wiki' | 'code_graph'; from_agent_id: string; to_agent_id: string }> = [];
    const skills: Array<Transfer & { from_agent_id: string; to_agent_id: string }> = [];
    for (const transfer of requested) {
      if (transfer.resource_type !== 'asset') {
        regular.push(transfer);
        continue;
      }
      if (aggregateChildren.has(transfer.resource_id)) continue;
      const asset = assetById.get(transfer.resource_id);
      if (asset?.asset_type === 'skill') {
        const rows = await listAgentSkills(deps, ctx, callerId, teamId);
        const backing = rows.find((row) => row.skill_id === transfer.resource_id);
        if (!backing?.owner_agent_id || !transfer.to_agent_id) {
          return respondControlError(c, 409, 'SKILL_BACKING_OWNER_NOT_FOUND');
        }
        const sourceAgentEnv = await deps.metaKernel.invoke('agent/get', { agent_id: backing.owner_agent_id }, ctx);
        const sourceAgent = sourceAgentEnv.data as { team_id?: string; owner_user_id?: string } | null;
        if (sourceAgentEnv.code !== 0 || !sourceAgent || sourceAgent.team_id !== teamId || sourceAgent.owner_user_id !== callerId) {
          return respondControlError(c, 409, 'SKILL_BACKING_OWNER_MISMATCH');
        }
        skills.push({ ...transfer, from_agent_id: backing.owner_agent_id, to_agent_id: transfer.to_agent_id });
      } else
      if (asset?.asset_type === 'llm_wiki' || asset?.asset_type === 'code_graph') {
        if (!transfer.from_agent_id || !transfer.to_agent_id) {
          return respondControlError(c, 400, 'TARGET_AGENT_REQUIRED');
        }
        knowledge.push({
          ...transfer,
          asset_type: asset.asset_type,
          from_agent_id: transfer.from_agent_id,
          to_agent_id: transfer.to_agent_id,
        });
      } else {
        regular.push(transfer);
      }
    }

    const items: Array<Record<string, unknown>> = [];
    const movedAggregateKnowledge: Array<{
      asset: BoundAsset;
      to_user_id: string;
      agent_id: string;
    }> = [];
    try {
      for (const child of aggregateChildren.values()) {
        if (child.asset.asset_type !== 'llm_wiki' && child.asset.asset_type !== 'code_graph') continue;
        await transferKnowledgeWithJournal(deps, ctx, {
          team_id: teamId,
          asset_id: child.asset.asset_id,
          asset_type: child.asset.asset_type,
          from_owner_user_id: callerId,
          to_owner_user_id: child.to_user_id,
          idempotency_key: idempotencyKey,
        });
        movedAggregateKnowledge.push(child);
      }
    } catch (err) {
      let compensationFailed = false;
      for (const child of [...movedAggregateKnowledge].reverse()) {
        try {
          await transferKnowledgeWithJournal(deps, ctx, {
            team_id: teamId,
            asset_id: child.asset.asset_id,
            asset_type: child.asset.asset_type as 'llm_wiki' | 'code_graph',
            from_owner_user_id: child.to_user_id,
            to_owner_user_id: callerId,
            idempotency_key: randomUUID(),
          });
        } catch {
          compensationFailed = true;
        }
      }
      if (compensationFailed) return respondControlError(c, 500, 'INCONSISTENT_RETRYABLE');
      return respondControlError(c, 502, err instanceof Error ? err.message : 'AGGREGATE_BACKING_TRANSFER_FAILED');
    }

    if (regular.length > 0) {
      const env = await deps.metaKernel.invoke('ownership/transfer', {
        team_id: teamId,
        transfers: regular,
        idempotency_key: idempotencyKey,
        confirmation: 'TRANSFER_OWNERSHIP',
      }, ctx);
      const resultItems = ((env.data as { items?: Array<Record<string, unknown>> } | null)?.items ?? []).map((item) => {
        if (item.resource_type !== 'agent' || typeof item.resource_id !== 'string') return item;
        const childIds = [...aggregateChildren.values()]
          .filter((child) => child.agent_id === item.resource_id)
          .map((child) => child.asset.asset_id);
        return {
          ...item,
          implicit_asset_ids: [...new Set([
            ...((item.implicit_asset_ids as string[] | undefined) ?? []),
            ...childIds,
          ])],
        };
      });
      const aggregateFailed = env.code !== 0 || resultItems.some(
        (item) => item.resource_type === 'agent' && item.transferred === false,
      );
      if (aggregateFailed) {
        let compensationFailed = false;
        for (const child of [...movedAggregateKnowledge].reverse()) {
          try {
            await transferKnowledgeWithJournal(deps, ctx, {
              team_id: teamId,
              asset_id: child.asset.asset_id,
              asset_type: child.asset.asset_type as 'llm_wiki' | 'code_graph',
              from_owner_user_id: child.to_user_id,
              to_owner_user_id: callerId,
              idempotency_key: randomUUID(),
            });
          } catch {
            compensationFailed = true;
          }
        }
        if (compensationFailed) return respondControlError(c, 500, 'INCONSISTENT_RETRYABLE');
        if (env.code !== 0) return respondEnvelope(c, env);
      }
      items.push(...resultItems);
    }

    for (const transfer of knowledge) {
      try {
        items.push(await transferKnowledgeWithJournal(deps, ctx, {
          team_id: teamId,
          asset_id: transfer.resource_id,
          asset_type: transfer.asset_type,
          from_owner_user_id: callerId,
          to_owner_user_id: transfer.to_user_id,
          from_agent_id: transfer.from_agent_id,
          to_agent_id: transfer.to_agent_id,
          idempotency_key: idempotencyKey,
        }));
      } catch (err) {
        items.push({
          ...transfer,
          transferred: false,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }
    for (const transfer of skills) {
      try {
        items.push(await transferSkillWithJournal(deps, ctx, {
          team_id: teamId,
          asset_id: transfer.resource_id,
          from_owner_user_id: callerId,
          to_owner_user_id: transfer.to_user_id,
          from_agent_id: transfer.from_agent_id,
          to_agent_id: transfer.to_agent_id,
          idempotency_key: idempotencyKey,
        }));
      } catch (err) {
        items.push({ ...transfer, transferred: false, reason: err instanceof Error ? err.message : String(err) });
      }
    }
    return respondEnvelope(c, okEnvelope(c, { items }));
  });

  api.post('/account/owned-resources/purge', validatePanelMetaHeaders(deps), async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const teamId = str(body, 'team_id');
    const refs = parseResourceRefs(body);
    if (!teamId) return respondControlError(c, 400, 'MISSING_TEAM_ID');
    if (!refs) return respondControlError(c, 400, 'INVALID_RESOURCES');
    if (str(body, 'confirmation') !== 'PERMANENT_DELETE') {
      return respondControlError(c, 400, 'CONFIRMATION_REQUIRED');
    }
    const callerId = await resolveCallerUserId(deps, ctx);
    if (!callerId) return respondControlError(c, 401, 'INVALID_USER_KEY');
    const memberEnv = await deps.metaKernel.invoke(
      'team-member/get',
      { team_id: teamId, user_id: callerId },
      ctx,
    );
    if (memberEnv.code !== 0) return respondEnvelope(c, memberEnv);
    const membership = memberEnv.data as { status?: string } | null;
    if (membership?.status !== 'active') return respondControlError(c, 403, 'ACTIVE_TEAM_MEMBERSHIP_REQUIRED');

    const validated: OwnedEntity[] = [];
    const alreadyAbsent: ResourceRef[] = [];
    for (const ref of refs) {
      const action = `${ref.resource_type}/get`;
      const idField = `${ref.resource_type}_id`;
      const env = await deps.metaKernel.invoke(action, { [idField]: ref.resource_id }, ctx);
      if (env.code === 404 || (env.code === 0 && !env.data)) {
        alreadyAbsent.push(ref);
        continue;
      }
      if (env.code !== 0) return respondEnvelope(c, env);
      const item = env.data as Record<string, unknown>;
      if (item.owner_user_id !== callerId) return respondControlError(c, 403, 'NOT_RESOURCE_OWNER');
      if (item.team_id !== teamId) return respondControlError(c, 400, 'RESOURCE_TEAM_MISMATCH');
      validated.push({
        ...ref,
        team_id: teamId,
        owner_user_id: callerId,
        asset_type: ref.resource_type === 'asset'
          ? item.asset_type as OwnedEntity['asset_type']
          : undefined,
      });
    }

    const deleted: Array<ResourceRef & { deleted_children?: string[] }> = [...alreadyAbsent];
    const failed: Array<ResourceRef & { reason: string }> = [];
    const order = { task: 0, asset: 1, agent: 2 } as const;
    for (const entity of validated.sort((a, b) => order[a.resource_type] - order[b.resource_type])) {
      try {
        if (entity.resource_type === 'task') {
          const env = await deps.metaKernel.invoke('task/delete', { task_ids: [entity.resource_id] }, ctx);
          if (env.code !== 0) throw new Error(env.message || 'TASK_DELETE_FAILED');
          assertDeletedOrAbsent((env.data ?? {}) as DeleteResult, entity.resource_id, 'TASK_DELETE_FAILED');
          deleted.push(entity);
        } else if (entity.resource_type === 'asset') {
          await purgeAsset(deps, ctx, callerId, entity);
          deleted.push(entity);
        } else {
          const deletedChildren = await purgeAgent(deps, ctx, callerId, entity);
          deleted.push({ ...entity, deleted_children: deletedChildren });
        }
      } catch (err) {
        failed.push({
          resource_type: entity.resource_type,
          resource_id: entity.resource_id,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const remainingEnv = await deps.metaKernel.invoke('user/dependencies', {
      user_id: callerId,
      team_id: teamId,
      limit: 1,
      offset: 0,
    }, ctx);
    const remaining = remainingEnv.code === 0
      ? (remainingEnv.data as { counts?: unknown } | null)?.counts ?? null
      : null;
    return respondEnvelope(c, okEnvelope(c, { deleted, failed, remaining }));
  });
}

async function resolveKnowledgeTransfer(
  deps: PanelDeps,
  ctx: MetaCallContext,
  operation: { team_id: string; asset_id: string; idempotency_key: string },
  status: 'failed' | 'inconsistent_retryable',
  errorCode: string,
): Promise<void> {
  const env = await deps.kernelHttp.postEnvelope(
    '/v3/internal/meta/asset/resolve-transfer',
    { ...operation, status, error_code: errorCode },
    toKernelCredentials(ctx, { timeoutMs: deps.config.metadataRemoteTimeoutMs }, { omitUserKey: true }),
  );
  if (env.code !== 0) throw new Error(env.message || 'CORE_RESOLVE_OPERATION_FAILED');
}

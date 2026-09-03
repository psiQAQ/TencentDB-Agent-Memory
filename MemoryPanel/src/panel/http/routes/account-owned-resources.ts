/** Owner-only permanent cleanup used to finish Team offboarding safely. */
import type { Hono } from 'hono';
import type { PanelDeps } from '../../panel-deps.js';
import { toKernelCredentials, type MetaCallContext } from '../../kernel/types.js';
import { validatePanelMetaHeaders } from '../middleware/validate-panel-headers.js';
import { respondControlError, respondEnvelope } from '../envelope.js';
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

function assertDeletedOrAbsent(result: DeleteResult, id: string, label: string): void {
  const failure = result.failed?.find((item) => item.id === id);
  if (failure && !/not[_ -]?found/i.test(failure.reason)) {
    throw new Error(`${label}: ${failure.reason}`);
  }
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

  const metaEnv = await deps.metaKernel.invoke('asset/delete', { asset_ids: [entity.resource_id] }, ctx);
  if (metaEnv.code !== 0) throw new Error(metaEnv.message || 'ASSET_DELETE_FAILED');
  assertDeletedOrAbsent((metaEnv.data ?? {}) as DeleteResult, entity.resource_id, 'ASSET_DELETE_FAILED');
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
    const metaEnv = await deps.metaKernel.invoke('asset/delete', { asset_ids: [skillId] }, ctx);
    if (metaEnv.code !== 0) throw new Error(metaEnv.message || 'ASSET_DELETE_FAILED');
    assertDeletedOrAbsent((metaEnv.data ?? {}) as DeleteResult, skillId, 'ASSET_DELETE_FAILED');
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
  const metaEnv = await deps.metaKernel.invoke('asset/delete', { asset_ids: [skillId] }, ctx);
  if (metaEnv.code !== 0) throw new Error(metaEnv.message || 'ASSET_DELETE_FAILED');
  assertDeletedOrAbsent((metaEnv.data ?? {}) as DeleteResult, skillId, 'ASSET_DELETE_FAILED');
}

async function clearAndDeleteChatMemory(
  deps: PanelDeps,
  ctx: MetaCallContext,
  memoryId: string,
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
  const metaEnv = await deps.metaKernel.invoke('asset/delete', { asset_ids: [memoryId] }, ctx);
  if (metaEnv.code !== 0) throw new Error(metaEnv.message || 'ASSET_DELETE_FAILED');
  assertDeletedOrAbsent((metaEnv.data ?? {}) as DeleteResult, memoryId, 'ASSET_DELETE_FAILED');
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
      await clearAndDeleteChatMemory(deps, ctx, entity.resource_id);
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
    await clearAndDeleteChatMemory(deps, ctx, memoryId);
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
      const ownerField = ref.resource_type === 'task' ? 'creator_user_id' : 'owner_user_id';
      if (item[ownerField] !== callerId) return respondControlError(c, 403, 'NOT_RESOURCE_OWNER');
      if (item.team_id !== teamId) return respondControlError(c, 400, 'RESOURCE_TEAM_MISMATCH');
      validated.push({
        ...ref,
        team_id: teamId,
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

import type { Context, Hono } from 'hono';
import type { PanelDeps } from '../../panel-deps.js';
import type { MetaCallContext } from '../../kernel/types.js';
import type { MetaEnvelope } from '../../kernel/envelope.js';
import { validatePanelMetaHeaders } from '../middleware/validate-panel-headers.js';
import { respondControlError, respondEnvelope } from '../envelope.js';
import {
  buildCtx,
  fetchAllMetaListItems,
  okEnvelope,
  readJson,
  resolveCallerUserId,
  strArray,
} from './knowledge/common.js';

export type TeamAtlasNodeType =
  | 'identity'
  | 'team'
  | 'task'
  | 'agent'
  | 'skill'
  | 'llm_wiki'
  | 'code_graph'
  | 'chat_memory';

export type TeamAtlasRelation =
  | 'member_of'
  | 'contains'
  | 'assigned_to'
  | 'owns'
  | 'fixed_binding';

export interface TeamAtlasNode {
  id: string;
  entity_id: string;
  type: TeamAtlasNodeType;
  label: string;
  team_id?: string;
  status?: string;
  metadata?: Record<string, string | number | boolean | null>;
}

export interface TeamAtlasEdge {
  id: string;
  type: TeamAtlasRelation;
  source: string;
  target: string;
  team_id?: string;
}

export interface TeamAtlasWarning {
  code:
    | 'SOURCE_PARTIAL'
    | 'TEAM_WITHOUT_TASKS'
    | 'TEAM_WITHOUT_AGENTS'
    | 'TASK_WITHOUT_AGENTS'
    | 'AGENT_WITHOUT_REUSABLE_ASSETS'
    | 'ASSET_NOT_BOUND';
  node_id?: string;
  source?: string;
  message: string;
}

interface TeamRaw {
  team_id: string;
  name: string;
  description?: string | null;
  owner_user_id: string;
  status?: string;
}

interface TeamMemberRaw {
  role?: string;
}

interface TaskRaw {
  task_id: string;
  team_id: string;
  title: string;
  status?: string;
  creator_user_id?: string;
  source_type?: string;
}

interface AgentRaw {
  agent_id: string;
  team_id: string;
  owner_user_id: string;
  name: string;
  status?: string;
}

interface AssetRaw {
  asset_id: string;
  team_id: string;
  asset_type: TeamAtlasNodeType;
  name: string;
  owner_user_id: string;
  status?: string;
  visibility?: string;
}

interface TaskAgentRaw {
  task_id: string;
  agent_id: string;
  status?: string;
}

interface FixedAssetRaw {
  asset_id: string;
  asset_type: string;
}

interface SkillRaw {
  skill_id: string;
  owner_agent_id?: string;
  status?: string;
}

export interface TeamAtlasSnapshot {
  team: TeamRaw;
  role?: string;
  tasks: TaskRaw[];
  agents: AgentRaw[];
  assets: AssetRaw[];
  taskAgents: TaskAgentRaw[];
  fixedAssets: Array<FixedAssetRaw & { agent_id: string }>;
  skills: SkillRaw[];
  complete: {
    tasks: boolean;
    agents: boolean;
    assets: boolean;
    taskAgents: boolean;
    fixedAssets: boolean;
    skills: boolean;
  };
  failedSources: string[];
}

export interface TeamAtlasIR {
  schema_version: 1;
  generated_at: string;
  scope: { user_id: string; team_ids: string[] };
  completeness: 'complete' | 'partial';
  summary: {
    teams: number;
    tasks: number;
    agents: number;
    assets: number;
    edges: number;
    warnings: number;
  };
  nodes: TeamAtlasNode[];
  edges: TeamAtlasEdge[];
  warnings: TeamAtlasWarning[];
}

const ACTIVE_ASSET_TYPES = new Set<TeamAtlasNodeType>([
  'skill',
  'llm_wiki',
  'code_graph',
  'chat_memory',
]);
const INACTIVE_STATUSES = new Set(['archived', 'deprecated', 'failed', 'inactive', 'removed']);

function nodeId(type: TeamAtlasNodeType, id: string): string {
  return `${type}:${id}`;
}

function edgeId(type: TeamAtlasRelation, source: string, target: string): string {
  return `${type}:${source}->${target}`;
}

function active(status: string | undefined): boolean {
  return !status || !INACTIVE_STATUSES.has(status);
}

function dedupeById<T extends { id: string }>(items: T[]): T[] {
  return Array.from(new Map(items.map((item) => [item.id, item])).values()).sort((a, b) =>
    a.id.localeCompare(b.id),
  );
}

export async function mapInBatches<T, R>(
  items: T[],
  batchSize: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += batchSize) {
    out.push(...(await Promise.all(items.slice(i, i + batchSize).map(mapper))));
  }
  return out;
}

export function buildTeamAtlasIR(
  userId: string,
  snapshots: TeamAtlasSnapshot[],
  generatedAt = new Date().toISOString(),
): TeamAtlasIR {
  const nodes: TeamAtlasNode[] = [
    { id: nodeId('identity', userId), entity_id: userId, type: 'identity', label: userId },
  ];
  const edges: TeamAtlasEdge[] = [];
  const warnings: TeamAtlasWarning[] = [];

  for (const snapshot of [...snapshots].sort((a, b) => a.team.team_id.localeCompare(b.team.team_id))) {
    const team = snapshot.team;
    const tasks = snapshot.tasks.filter((item) => active(item.status));
    const agents = snapshot.agents.filter((item) => active(item.status));
    const assets = snapshot.assets.filter(
      (item) => active(item.status) && ACTIVE_ASSET_TYPES.has(item.asset_type),
    );
    const teamNode = nodeId('team', team.team_id);
    nodes.push({
      id: teamNode,
      entity_id: team.team_id,
      type: 'team',
      label: team.name || team.team_id,
      team_id: team.team_id,
      status: team.status,
      metadata: {
        owner_user_id: team.owner_user_id,
        role: snapshot.role ?? null,
        tasks: tasks.length,
        agents: agents.length,
        assets: assets.length,
      },
    });
    edges.push({
      id: edgeId('member_of', nodeId('identity', userId), teamNode),
      type: 'member_of',
      source: nodeId('identity', userId),
      target: teamNode,
      team_id: team.team_id,
    });

    for (const task of tasks) {
      const id = nodeId('task', task.task_id);
      nodes.push({
        id,
        entity_id: task.task_id,
        type: 'task',
        label: task.title || task.task_id,
        team_id: team.team_id,
        status: task.status,
        metadata: {
          creator_user_id: task.creator_user_id ?? null,
          source_type: task.source_type ?? null,
        },
      });
      edges.push({ id: edgeId('contains', teamNode, id), type: 'contains', source: teamNode, target: id, team_id: team.team_id });
    }
    for (const agent of agents) {
      const id = nodeId('agent', agent.agent_id);
      nodes.push({
        id,
        entity_id: agent.agent_id,
        type: 'agent',
        label: agent.name || agent.agent_id,
        team_id: team.team_id,
        status: agent.status,
        metadata: { owner_user_id: agent.owner_user_id },
      });
      edges.push({ id: edgeId('contains', teamNode, id), type: 'contains', source: teamNode, target: id, team_id: team.team_id });
    }
    for (const asset of assets) {
      nodes.push({
        id: nodeId(asset.asset_type, asset.asset_id),
        entity_id: asset.asset_id,
        type: asset.asset_type,
        label: asset.name || asset.asset_id,
        team_id: team.team_id,
        status: asset.status,
        metadata: { visibility: asset.visibility ?? null, owner_user_id: asset.owner_user_id },
      });
    }

    const visibleNodeIds = new Set(nodes.filter((node) => !node.team_id || node.team_id === team.team_id).map((node) => node.id));
    for (const link of snapshot.taskAgents.filter((item) => active(item.status))) {
      const source = nodeId('task', link.task_id);
      const target = nodeId('agent', link.agent_id);
      if (visibleNodeIds.has(source) && visibleNodeIds.has(target)) {
        edges.push({ id: edgeId('assigned_to', source, target), type: 'assigned_to', source, target, team_id: team.team_id });
      }
    }
    for (const skill of snapshot.skills.filter((item) => active(item.status) && item.owner_agent_id)) {
      const source = nodeId('agent', skill.owner_agent_id!);
      const target = nodeId('skill', skill.skill_id);
      if (visibleNodeIds.has(source) && visibleNodeIds.has(target)) {
        edges.push({ id: edgeId('owns', source, target), type: 'owns', source, target, team_id: team.team_id });
      }
    }
    for (const binding of snapshot.fixedAssets) {
      const source = nodeId('agent', binding.agent_id);
      const asset = assets.find((item) => item.asset_id === binding.asset_id);
      if (!asset) continue;
      const target = nodeId(asset.asset_type, asset.asset_id);
      if (visibleNodeIds.has(source) && visibleNodeIds.has(target)) {
        edges.push({ id: edgeId('fixed_binding', source, target), type: 'fixed_binding', source, target, team_id: team.team_id });
      }
    }

    if (snapshot.complete.tasks && tasks.length === 0) warnings.push({ code: 'TEAM_WITHOUT_TASKS', node_id: teamNode, message: `${team.name || team.team_id} has no active tasks` });
    if (snapshot.complete.agents && agents.length === 0) warnings.push({ code: 'TEAM_WITHOUT_AGENTS', node_id: teamNode, message: `${team.name || team.team_id} has no active agents` });
    if (snapshot.complete.taskAgents) {
      for (const task of tasks) {
        const id = nodeId('task', task.task_id);
        if (!edges.some((edge) => edge.type === 'assigned_to' && edge.source === id)) warnings.push({ code: 'TASK_WITHOUT_AGENTS', node_id: id, message: `${task.title || task.task_id} has no assigned agents` });
      }
    }
    if (snapshot.complete.fixedAssets && snapshot.complete.skills && snapshot.complete.assets) {
      for (const agent of agents) {
        const id = nodeId('agent', agent.agent_id);
        if (!edges.some((edge) => (edge.type === 'owns' || edge.type === 'fixed_binding') && edge.source === id)) warnings.push({ code: 'AGENT_WITHOUT_REUSABLE_ASSETS', node_id: id, message: `${agent.name || agent.agent_id} has no reusable assets` });
      }
      for (const asset of assets) {
        const id = nodeId(asset.asset_type, asset.asset_id);
        if (!edges.some((edge) => (edge.type === 'owns' || edge.type === 'fixed_binding') && edge.target === id)) warnings.push({ code: 'ASSET_NOT_BOUND', node_id: id, message: `${asset.name || asset.asset_id} is not bound to an agent` });
      }
    }
    for (const source of snapshot.failedSources) warnings.push({ code: 'SOURCE_PARTIAL', source, node_id: teamNode, message: `${source} is unavailable for ${team.name || team.team_id}` });
  }

  const finalNodes = dedupeById(nodes);
  const nodeIds = new Set(finalNodes.map((node) => node.id));
  const finalEdges = dedupeById(edges.filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target)));
  const finalWarnings = warnings.sort((a, b) => `${a.code}:${a.node_id ?? ''}:${a.source ?? ''}`.localeCompare(`${b.code}:${b.node_id ?? ''}:${b.source ?? ''}`));
  const completeness = snapshots.some((snapshot) => snapshot.failedSources.length > 0) ? 'partial' : 'complete';
  return {
    schema_version: 1,
    generated_at: generatedAt,
    scope: { user_id: userId, team_ids: snapshots.map((item) => item.team.team_id).sort() },
    completeness,
    summary: {
      teams: finalNodes.filter((node) => node.type === 'team').length,
      tasks: finalNodes.filter((node) => node.type === 'task').length,
      agents: finalNodes.filter((node) => node.type === 'agent').length,
      assets: finalNodes.filter((node) => ACTIVE_ASSET_TYPES.has(node.type)).length,
      edges: finalEdges.length,
      warnings: finalWarnings.length,
    },
    nodes: finalNodes,
    edges: finalEdges,
    warnings: finalWarnings,
  };
}

async function fetchAllStrict<T>(
  deps: PanelDeps,
  ctx: MetaCallContext,
  action: string,
  body: Record<string, unknown>,
): Promise<T[]> {
  let error: MetaEnvelope<unknown> | undefined;
  const items = await fetchAllMetaListItems<T>(deps, ctx, action, body, (env) => {
    error = env;
  });
  if (error) throw error;
  return items;
}

async function fetchAllSkills(
  deps: PanelDeps,
  ctx: MetaCallContext,
  userId: string,
  teamId: string,
): Promise<SkillRaw[]> {
  const all: SkillRaw[] = [];
  const limit = 1000;
  for (let offset = 0; ; offset += limit) {
    const env = await deps.skillKernel.invoke('list', {
      user_id: userId,
      team_id: teamId,
      filters: { status: ['active'] },
      pagination: { limit, offset },
    }, ctx);
    if (env.code !== 0) throw env;
    const data = env.data as { items?: SkillRaw[]; total?: number } | null;
    const items = data?.items ?? [];
    all.push(...items);
    if (items.length === 0 || all.length >= (data?.total ?? all.length)) break;
  }
  return all;
}

async function settledSource<T>(source: string, fn: () => Promise<T>): Promise<{ source: string; ok: true; value: T } | { source: string; ok: false }> {
  try {
    return { source, ok: true, value: await fn() };
  } catch {
    return { source, ok: false };
  }
}

async function loadTeamSnapshot(
  deps: PanelDeps,
  ctx: MetaCallContext,
  userId: string,
  team: TeamRaw,
): Promise<TeamAtlasSnapshot> {
  const assetTypes: AssetRaw['asset_type'][] = ['skill', 'llm_wiki', 'code_graph', 'chat_memory'];
  const [memberRes, tasksRes, agentsRes, assetsRes, skillsRes] = await Promise.all([
    settledSource('team-member/get', async () => {
      const env = await deps.metaKernel.invoke('team-member/get', { team_id: team.team_id, user_id: userId }, ctx);
      if (env.code !== 0) throw env;
      return env.data as TeamMemberRaw;
    }),
    settledSource('task/list', () => fetchAllStrict<TaskRaw>(deps, ctx, 'task/list', { team_id: team.team_id })),
    settledSource('agent/list', () => fetchAllStrict<AgentRaw>(deps, ctx, 'agent/list', { team_id: team.team_id })),
    settledSource('asset/list-accessible', async () => (await Promise.all(assetTypes.map((assetType) => fetchAllStrict<AssetRaw>(deps, ctx, 'asset/list-accessible', { user_id: userId, team_id: team.team_id, asset_type: assetType, action: 'read' })))).flat()),
    settledSource('skill/list', () => fetchAllSkills(deps, ctx, userId, team.team_id)),
  ]);
  const tasks = tasksRes.ok ? tasksRes.value : [];
  const agents = agentsRes.ok ? agentsRes.value : [];
  const taskAgentsRes = await settledSource('task-agent/list', async () => (await mapInBatches(tasks, 20, (task) => fetchAllStrict<TaskAgentRaw>(deps, ctx, 'task-agent/list', { task_id: task.task_id }))).flat());
  const fixedAssetsRes = await settledSource('agent-fixed-asset/list', async () => (await mapInBatches(agents, 20, async (agent) => (await fetchAllStrict<FixedAssetRaw>(deps, ctx, 'agent-fixed-asset/list', { agent_id: agent.agent_id })).map((binding) => ({ ...binding, agent_id: agent.agent_id })))).flat());
  const sources = [memberRes, tasksRes, agentsRes, assetsRes, skillsRes, taskAgentsRes, fixedAssetsRes];
  return {
    team,
    role: memberRes.ok ? memberRes.value.role : undefined,
    tasks,
    agents,
    assets: assetsRes.ok ? assetsRes.value : [],
    taskAgents: taskAgentsRes.ok ? taskAgentsRes.value : [],
    fixedAssets: fixedAssetsRes.ok ? fixedAssetsRes.value : [],
    skills: skillsRes.ok ? skillsRes.value : [],
    complete: {
      tasks: tasksRes.ok,
      agents: agentsRes.ok,
      assets: assetsRes.ok,
      taskAgents: taskAgentsRes.ok,
      fixedAssets: fixedAssetsRes.ok,
      skills: skillsRes.ok,
    },
    failedSources: sources.filter((item) => !item.ok).map((item) => item.source),
  };
}

async function handleBootstrap(c: Context, deps: PanelDeps): Promise<Response> {
  const ctx = buildCtx(c);
  const body = await readJson(c);
  const requestedTeamIds = [...new Set(strArray(body, 'team_ids'))];
  const userId = await resolveCallerUserId(deps, ctx);
  if (!userId) return respondControlError(c, 401, 'INVALID_USER_KEY');
  let teamError: MetaEnvelope<unknown> | undefined;
  const visibleTeams = (await fetchAllMetaListItems<TeamRaw>(deps, ctx, 'team/list', { user_id: userId }, (env) => { teamError = env; })).filter((team) => active(team.status));
  if (teamError) return respondEnvelope(c, teamError);
  const visibleIds = new Set(visibleTeams.map((team) => team.team_id));
  if (requestedTeamIds.some((teamId) => !visibleIds.has(teamId))) return respondControlError(c, 403, 'TEAM_NOT_VISIBLE');
  const selected = requestedTeamIds.length > 0 ? visibleTeams.filter((team) => requestedTeamIds.includes(team.team_id)) : visibleTeams;
  const snapshots = await mapInBatches(selected, 4, (team) => loadTeamSnapshot(deps, ctx, userId, team));
  return respondEnvelope(c, okEnvelope(c, buildTeamAtlasIR(userId, snapshots)));
}

export function registerTeamAtlasRoutes(api: Hono, deps: PanelDeps): void {
  api.post('/topology/bootstrap', validatePanelMetaHeaders(deps), (c) => handleBootstrap(c, deps));
}

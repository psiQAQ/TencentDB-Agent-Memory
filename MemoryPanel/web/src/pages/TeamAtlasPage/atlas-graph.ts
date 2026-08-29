import type { TeamAtlasEdge, TeamAtlasIR, TeamAtlasNode, TeamAtlasNodeType } from '../../lib/api/team-atlas';

export interface PositionedAtlasNode extends TeamAtlasNode {
  x: number;
  y: number;
  width: number;
  height: number;
  aggregate_count?: number;
  logical_id?: string;
  parent_agent_id?: string;
}

export interface AtlasProjection {
  nodes: TeamAtlasNode[];
  edges: TeamAtlasEdge[];
  mode: 'full' | 'team_summary' | 'team_detail' | 'agent_focus';
  truncated: boolean;
}

export interface AtlasLayout {
  nodes: PositionedAtlasNode[];
  edges: TeamAtlasEdge[];
  width: number;
  height: number;
}

export interface AtlasEdgeGeometry {
  path: string;
  labelX: number;
  labelY: number;
}

export interface AtlasContentBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  width: number;
  height: number;
}

export type AtlasSummaryNodeType = 'team' | 'task' | 'agent' | 'skill' | 'llm_wiki' | 'code_graph' | 'chat_memory';

export interface AtlasSummaryCard {
  type: AtlasSummaryNodeType;
  mine: number;
  visible: number;
}

const ASSET_TYPES = new Set<TeamAtlasNodeType>(['skill', 'llm_wiki', 'code_graph', 'chat_memory']);
const TYPE_ORDER: Record<TeamAtlasNodeType, number> = {
  team: 0,
  identity: 1,
  agent: 3,
  task: 2,
  skill: 4,
  llm_wiki: 5,
  code_graph: 6,
  chat_memory: 7,
};
const TYPE_X: Record<TeamAtlasNodeType, number> = {
  team: 30,
  identity: 310,
  task: 612,
  agent: 600,
  skill: 930,
  llm_wiki: 930,
  code_graph: 930,
  chat_memory: 930,
};

const SUMMARY_TYPES: AtlasSummaryNodeType[] = ['team', 'task', 'agent', 'skill', 'llm_wiki', 'code_graph', 'chat_memory'];

function stableNodes(nodes: TeamAtlasNode[]): TeamAtlasNode[] {
  return [...nodes].sort((a, b) => TYPE_ORDER[a.type] - TYPE_ORDER[b.type] || (a.team_id ?? '').localeCompare(b.team_id ?? '') || a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
}

function connectedIds(edges: TeamAtlasEdge[], ids: Set<string>): Set<string> {
  const out = new Set(ids);
  for (const edge of edges) {
    if (ids.has(edge.source) || ids.has(edge.target)) {
      out.add(edge.source);
      out.add(edge.target);
    }
  }
  return out;
}

function filterEdges(edges: TeamAtlasEdge[], nodes: TeamAtlasNode[]): TeamAtlasEdge[] {
  const ids = new Set(nodes.map((node) => node.id));
  return edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target)).sort((a, b) => a.id.localeCompare(b.id));
}

export function atlasInteractionEdges(edges: TeamAtlasEdge[]): TeamAtlasEdge[] {
  return edges.filter((edge) => edge.type !== 'owns');
}

export function atlasContentBounds(nodes: PositionedAtlasNode[]): AtlasContentBounds {
  if (nodes.length === 0) return { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 };
  const minX = Math.min(...nodes.map((node) => node.x));
  const minY = Math.min(...nodes.map((node) => node.y));
  const maxX = Math.max(...nodes.map((node) => node.x + node.width));
  const maxY = Math.max(...nodes.map((node) => node.y + node.height));
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

export function atlasCanvasSize(layout: Pick<AtlasLayout, 'width' | 'height'>, nodes: PositionedAtlasNode[], padding = 30): { width: number; height: number } {
  const bounds = atlasContentBounds(nodes);
  return {
    width: Math.max(1160, layout.width, Math.ceil(bounds.maxX + padding)),
    height: Math.max(620, layout.height, Math.ceil(bounds.maxY + padding)),
  };
}

export function directRelationIds(edges: TeamAtlasEdge[], nodeId: string | undefined): Set<string> {
  if (!nodeId) return new Set();
  const ids = new Set([nodeId]);
  for (const edge of edges) {
    if (edge.source === nodeId) ids.add(edge.target);
    if (edge.target === nodeId) ids.add(edge.source);
  }
  return ids;
}

export function directVisualNodeIds(
  nodes: PositionedAtlasNode[],
  edges: TeamAtlasEdge[],
  activeNode: PositionedAtlasNode | null,
): Set<string> {
  if (!activeNode) return new Set();
  const ids = new Set([activeNode.id]);
  const activeLogicalId = activeNode.logical_id ?? activeNode.id;

  for (const edge of edges) {
    if (edge.source !== activeLogicalId && edge.target !== activeLogicalId) continue;
    if (edge.type === 'assigned_to') {
      if (activeNode.type === 'task' && activeNode.parent_agent_id === edge.target) ids.add(edge.target);
      if (activeNode.type === 'agent' && edge.target === activeLogicalId) {
        for (const node of nodes) {
          if (node.type === 'task' && node.logical_id === edge.source && node.parent_agent_id === activeLogicalId) ids.add(node.id);
        }
      }
      continue;
    }
    const peerId = edge.source === activeLogicalId ? edge.target : edge.source;
    for (const node of nodes) {
      if ((node.logical_id ?? node.id) === peerId) ids.add(node.id);
    }
  }
  return ids;
}

export function projectAtlas(
  ir: TeamAtlasIR,
  options: {
    focusTeamId?: string | null;
    focusAgentId?: string | null;
    query?: string;
    assetType?: TeamAtlasNodeType | 'all';
    teamIds?: string[];
    showUnboundAssets?: boolean;
    showOtherOwners?: boolean;
    maxNodes?: number;
  } = {},
): AtlasProjection {
  const maxNodes = options.maxNodes ?? 500;
  const focusTeamId = options.focusTeamId ?? undefined;
  let nodes = stableNodes(ir.nodes);
  let mode: AtlasProjection['mode'] = 'full';
  let truncated = false;

  if (options.teamIds) {
    const teamIds = new Set(options.teamIds);
    nodes = nodes.filter((node) => node.team_id && teamIds.has(node.team_id));
  }

  if (options.showUnboundAssets === false) {
    const ownAgentIds = new Set(nodes
      .filter((node) => node.type === 'agent' && node.metadata?.owner_user_id === ir.scope.user_id)
      .map((node) => node.id));
    const ownBoundAssetIds = new Set(ir.edges
      .filter((edge) => (edge.type === 'owns' || edge.type === 'fixed_binding') && ownAgentIds.has(edge.source))
      .map((edge) => edge.target));
    nodes = nodes.filter((node) => !ASSET_TYPES.has(node.type) || ownBoundAssetIds.has(node.id));
  }

  if (options.showOtherOwners === false) {
    nodes = nodes.filter((node) => {
      if (node.type === 'team' || node.type === 'task') return true;
      if (node.type === 'identity') return node.entity_id === ir.scope.user_id;
      return node.metadata?.owner_user_id === ir.scope.user_id;
    });
  }

  if (options.focusAgentId) {
    const agentNodeId = `agent:${options.focusAgentId}`;
    const ids = connectedIds(ir.edges, new Set([agentNodeId]));
    const agent = ir.nodes.find((node) => node.id === agentNodeId);
    if (agent?.team_id) {
      ids.add(`team:${agent.team_id}`);
      for (const member of ir.nodes.filter((node) => node.type === 'identity' && node.team_id === agent.team_id)) ids.add(member.id);
    }
    nodes = nodes.filter((node) => ids.has(node.id));
    mode = 'agent_focus';
  } else if (focusTeamId) {
    nodes = nodes.filter((node) => node.id === `team:${focusTeamId}` || node.team_id === focusTeamId);
    mode = 'team_detail';
    if (nodes.length > maxNodes) {
      truncated = true;
      const structural = nodes.filter((node) => !ASSET_TYPES.has(node.type));
      const groups = ['skill', 'llm_wiki', 'code_graph', 'chat_memory'].flatMap((type) => {
        const count = nodes.filter((node) => node.type === type).length;
        return count === 0 ? [] : [{
          id: `aggregate:${focusTeamId}:${type}`,
          entity_id: `${focusTeamId}:${type}`,
          type: type as TeamAtlasNodeType,
          label: `${type} · ${count}`,
          team_id: focusTeamId,
          metadata: { aggregate: true, count },
        } satisfies TeamAtlasNode];
      });
      nodes = stableNodes([...structural.slice(0, Math.max(1, maxNodes - groups.length)), ...groups]);
    }
  } else if (nodes.length > maxNodes) {
    nodes = nodes.filter((node) => node.type === 'identity' || node.type === 'team');
    mode = 'team_summary';
    truncated = true;
  }

  const query = options.query?.trim().toLocaleLowerCase();
  if (query) {
    const matched = new Set(nodes.filter((node) => `${node.label} ${node.entity_id}`.toLocaleLowerCase().includes(query)).map((node) => node.id));
    const keep = connectedIds(ir.edges, matched);
    nodes = nodes.filter((node) => keep.has(node.id));
  }
  if (options.assetType && options.assetType !== 'all') {
    const matched = new Set(nodes.filter((node) => node.type === options.assetType || !ASSET_TYPES.has(node.type)).map((node) => node.id));
    nodes = nodes.filter((node) => matched.has(node.id));
  }
  return { nodes, edges: filterEdges(ir.edges, nodes), mode, truncated };
}

export function summarizeAtlas(ir: TeamAtlasIR, teamIds?: string[]): AtlasSummaryCard[] {
  const selectedTeams = teamIds ? new Set(teamIds) : null;
  const visibleNodes = selectedTeams ? ir.nodes.filter((node) => node.team_id && selectedTeams.has(node.team_id)) : ir.nodes;
  const visibleNodeIds = new Set(visibleNodes.map((node) => node.id));
  const visibleEdges = ir.edges.filter((edge) => visibleNodeIds.has(edge.source) && visibleNodeIds.has(edge.target));
  const userId = ir.scope.user_id;
  const ownAgentIds = new Set(visibleNodes
    .filter((node) => node.type === 'agent' && node.metadata?.owner_user_id === userId)
    .map((node) => node.id));
  const mine = new Set<string>();

  for (const node of visibleNodes) {
    if (node.type === 'team' && ir.scope.team_ids.includes(node.entity_id)) mine.add(node.id);
    if (node.type === 'task' && node.metadata?.creator_user_id === userId) mine.add(node.id);
    if (node.type === 'agent' && ownAgentIds.has(node.id)) mine.add(node.id);
    if (ASSET_TYPES.has(node.type) && node.metadata?.owner_user_id === userId) mine.add(node.id);
  }

  for (const edge of visibleEdges) {
    if (edge.type === 'assigned_to' && ownAgentIds.has(edge.target)) mine.add(edge.source);
    if ((edge.type === 'owns' || edge.type === 'fixed_binding') && ownAgentIds.has(edge.source)) mine.add(edge.target);
  }

  return SUMMARY_TYPES.map((type) => {
    const nodes = visibleNodes.filter((node) => node.type === type);
    return { type, mine: nodes.filter((node) => mine.has(node.id)).length, visible: nodes.length };
  });
}

export function layoutAtlas(projection: AtlasProjection): AtlasLayout {
  const width = 1210;
  const nodeWidth = 220;
  const nodeHeight = 72;
  const taskHeight = 40;
  const taskGap = 4;
  const agentGap = 18;
  const memberGap = 24;
  const assetGap = 18;
  const teamGap = 76;
  const positioned: PositionedAtlasNode[] = [];
  let teamTop = 36;
  const teams = stableNodes(projection.nodes.filter((node) => node.type === 'team'));

  for (const team of teams) {
    const teamNodes = stableNodes(projection.nodes.filter((node) => node.team_id === team.entity_id));
    const currentUserId = teamNodes.find((node) => node.type === 'identity' && node.metadata?.is_current)?.entity_id;
    const members = teamNodes.filter((node) => node.type === 'identity').sort((a, b) =>
      Number(Boolean(b.metadata?.is_current)) - Number(Boolean(a.metadata?.is_current))
      || a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
    const agents = teamNodes.filter((node) => node.type === 'agent');
    const tasks = teamNodes.filter((node) => node.type === 'task');
    const assets = teamNodes.filter((node) => ASSET_TYPES.has(node.type)).sort((a, b) =>
      TYPE_ORDER[a.type] - TYPE_ORDER[b.type]
      || Number(b.metadata?.owner_user_id === currentUserId) - Number(a.metadata?.owner_user_id === currentUserId)
      || a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
    const taskByAgent = new Map<string, TeamAtlasNode[]>();
    const assignedTaskIds = new Set<string>();
    for (const edge of projection.edges.filter((item) => item.type === 'assigned_to')) {
      const task = tasks.find((item) => item.id === edge.source);
      if (!task || !agents.some((item) => item.id === edge.target)) continue;
      const list = taskByAgent.get(edge.target) ?? [];
      list.push(task);
      taskByAgent.set(edge.target, list);
      assignedTaskIds.add(task.id);
    }

    const memberSections = members.map((member) => {
      const ownedAgents = agents.filter((agent) => agent.metadata?.owner_user_id === member.entity_id);
      const agentGroups = ownedAgents.map((agent) => {
        const assignedTasks = stableNodes(taskByAgent.get(agent.id) ?? []);
        return { agent, tasks: assignedTasks, height: nodeHeight + assignedTasks.length * (taskHeight + taskGap) };
      });
      const looseTasks = tasks.filter((task) => !assignedTaskIds.has(task.id) && task.metadata?.creator_user_id === member.entity_id);
      const agentHeight = agentGroups.reduce((sum, group) => sum + group.height, 0) + Math.max(0, agentGroups.length - 1) * agentGap;
      const looseHeight = looseTasks.length * (taskHeight + taskGap);
      return { member, agentGroups, looseTasks, height: Math.max(nodeHeight, agentHeight + looseHeight) };
    });
    const memberHeight = memberSections.reduce((sum, section) => sum + section.height, 0) + Math.max(0, memberSections.length - 1) * memberGap;
    const assetHeight = assets.length * nodeHeight + Math.max(0, assets.length - 1) * assetGap;
    const blockHeight = Math.max(180, memberHeight, assetHeight);
    let memberY = teamTop + (blockHeight - memberHeight) / 2;
    const memberCardYs: number[] = [];
    let memberCursor = memberY;
    for (const section of memberSections) {
      memberCardYs.push(section.agentGroups.length > 0 ? memberCursor : memberCursor + (section.height - nodeHeight) / 2);
      memberCursor += section.height + memberGap;
    }
    const teamCenterY = memberCardYs.length > 0
      ? memberCardYs.reduce((sum, y) => sum + y + nodeHeight / 2, 0) / memberCardYs.length
      : teamTop + blockHeight / 2;

    positioned.push({ ...team, x: TYPE_X.team, y: teamCenterY - nodeHeight / 2, width: nodeWidth, height: nodeHeight });
    for (const [sectionIndex, section] of memberSections.entries()) {
      const memberCardY = memberCardYs[sectionIndex]!;
      positioned.push({ ...section.member, x: TYPE_X.identity, y: memberCardY, width: nodeWidth, height: nodeHeight });
      let workY = memberY;
      for (const group of section.agentGroups) {
        positioned.push({ ...group.agent, x: TYPE_X.agent, y: workY, width: nodeWidth, height: nodeHeight });
        let taskY = workY + nodeHeight + taskGap;
        for (const task of group.tasks) {
          positioned.push({ ...task, id: `${task.id}@${group.agent.id}`, logical_id: task.id, parent_agent_id: group.agent.id, x: TYPE_X.task, y: taskY, width: nodeWidth - 12, height: taskHeight });
          taskY += taskHeight + taskGap;
        }
        workY += group.height + agentGap;
      }
      for (const task of stableNodes(section.looseTasks)) {
        positioned.push({ ...task, x: TYPE_X.task, y: workY, width: nodeWidth - 12, height: taskHeight });
        workY += taskHeight + taskGap;
      }
      memberY += section.height + memberGap;
    }
    const assetStart = teamTop + (blockHeight - assetHeight) / 2;
    assets.forEach((asset, index) => {
      const aggregateCount = typeof asset.metadata?.count === 'number' ? asset.metadata.count : undefined;
      positioned.push({ ...asset, x: TYPE_X[asset.type], y: assetStart + index * (nodeHeight + assetGap), width: nodeWidth, height: nodeHeight, ...(aggregateCount === undefined ? {} : { aggregate_count: aggregateCount }) });
    });
    teamTop += blockHeight + teamGap;
  }

  return { nodes: positioned, edges: projection.edges, width, height: Math.max(300, teamTop - teamGap + 36) };
}

function edgePortY(
  node: PositionedAtlasNode,
  edge: TeamAtlasEdge,
  edges: TeamAtlasEdge[],
  side: 'source' | 'target',
  nodes: PositionedAtlasNode[],
): number {
  const incident = edges
    .filter((item) => item.type !== 'assigned_to' && item[side] === (node.logical_id ?? node.id))
    .sort((a, b) => {
      const aPeerId = side === 'source' ? a.target : a.source;
      const bPeerId = side === 'source' ? b.target : b.source;
      const aPeer = nodes.find((item) => (item.logical_id ?? item.id) === aPeerId);
      const bPeer = nodes.find((item) => (item.logical_id ?? item.id) === bPeerId);
      return (aPeer?.y ?? 0) - (bPeer?.y ?? 0) || a.id.localeCompare(b.id);
    });
  if (incident.length <= 1) return node.y + node.height / 2;
  const index = incident.findIndex((item) => item.id === edge.id);
  const span = Math.min(34, node.height - 34);
  return node.y + node.height / 2 + ((index / (incident.length - 1)) - 0.5) * span;
}

export function edgeGeometry(
  edge: TeamAtlasEdge,
  nodes: PositionedAtlasNode[],
  edges: TeamAtlasEdge[],
): AtlasEdgeGeometry {
  const source = nodes.find((node) => node.id === edge.source);
  const target = nodes.find((node) => node.id === edge.target);
  if (!source || !target) return { path: '', labelX: 0, labelY: 0 };
  if (edge.type === 'assigned_to') return { path: '', labelX: 0, labelY: 0 };
  const sx = source.x + source.width;
  const sy = edgePortY(source, edge, edges, 'source', nodes);
  const tx = target.x;
  const ty = edgePortY(target, edge, edges, 'target', nodes);
  const peerEdges = edges.filter((item) => {
    if (item.type === 'assigned_to') return false;
    const itemSource = nodes.find((node) => node.id === item.source);
    const itemTarget = nodes.find((node) => node.id === item.target);
    return itemSource?.x === source.x && itemTarget?.x === target.x;
  }).sort((a, b) => {
    const aTarget = nodes.find((node) => (node.logical_id ?? node.id) === a.target);
    const bTarget = nodes.find((node) => (node.logical_id ?? node.id) === b.target);
    const aSource = nodes.find((node) => (node.logical_id ?? node.id) === a.source);
    const bSource = nodes.find((node) => (node.logical_id ?? node.id) === b.source);
    return (aTarget?.y ?? 0) - (bTarget?.y ?? 0) || (aSource?.y ?? 0) - (bSource?.y ?? 0) || a.id.localeCompare(b.id);
  });
  const index = peerEdges.findIndex((item) => item.id === edge.id);
  const corridorStart = sx + 12;
  const corridorEnd = tx - 12;
  const mid = corridorStart + ((index + 1) / (peerEdges.length + 1)) * (corridorEnd - corridorStart);
  return {
    path: `M ${sx} ${sy} H ${mid} V ${ty} H ${tx}`,
    labelX: mid + (tx - mid) / 2,
    labelY: ty - 7,
  };
}

export function edgePath(edge: TeamAtlasEdge, nodes: PositionedAtlasNode[], edges: TeamAtlasEdge[] = [edge]): string {
  return edgeGeometry(edge, nodes, edges).path;
}

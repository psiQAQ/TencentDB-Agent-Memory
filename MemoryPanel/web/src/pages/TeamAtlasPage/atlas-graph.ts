import type { TeamAtlasEdge, TeamAtlasIR, TeamAtlasNode, TeamAtlasNodeType } from '../../lib/api/team-atlas';

export interface PositionedAtlasNode extends TeamAtlasNode {
  x: number;
  y: number;
  width: number;
  height: number;
  aggregate_count?: number;
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

export type AtlasSummaryNodeType = 'team' | 'task' | 'agent' | 'skill' | 'llm_wiki' | 'code_graph' | 'chat_memory';

export interface AtlasSummaryCard {
  type: AtlasSummaryNodeType;
  mine: number;
  visible: number;
}

const ASSET_TYPES = new Set<TeamAtlasNodeType>(['skill', 'llm_wiki', 'code_graph', 'chat_memory']);
const TYPE_ORDER: Record<TeamAtlasNodeType, number> = {
  identity: 0,
  team: 1,
  task: 2,
  agent: 3,
  skill: 4,
  llm_wiki: 5,
  code_graph: 6,
  chat_memory: 7,
};
const TYPE_X: Record<TeamAtlasNodeType, number> = {
  identity: 30,
  team: 350,
  task: 700,
  agent: 700,
  skill: 1040,
  llm_wiki: 1040,
  code_graph: 1040,
  chat_memory: 1040,
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

export function projectAtlas(
  ir: TeamAtlasIR,
  options: {
    focusTeamId?: string | null;
    focusAgentId?: string | null;
    query?: string;
    assetType?: TeamAtlasNodeType | 'all';
    maxNodes?: number;
  } = {},
): AtlasProjection {
  const maxNodes = options.maxNodes ?? 100;
  const focusTeamId = options.focusTeamId ?? undefined;
  let nodes = stableNodes(ir.nodes);
  let mode: AtlasProjection['mode'] = 'full';
  let truncated = false;

  if (options.focusAgentId) {
    const agentNodeId = `agent:${options.focusAgentId}`;
    const ids = connectedIds(ir.edges, new Set([agentNodeId]));
    const agent = ir.nodes.find((node) => node.id === agentNodeId);
    if (agent?.team_id) {
      ids.add(`team:${agent.team_id}`);
      ids.add(`identity:${ir.scope.user_id}`);
    }
    nodes = nodes.filter((node) => ids.has(node.id));
    mode = 'agent_focus';
  } else if (focusTeamId) {
    nodes = nodes.filter((node) => node.type === 'identity' || node.id === `team:${focusTeamId}` || node.team_id === focusTeamId);
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

export function summarizeAtlas(ir: TeamAtlasIR): AtlasSummaryCard[] {
  const userId = ir.scope.user_id;
  const ownAgentIds = new Set(ir.nodes
    .filter((node) => node.type === 'agent' && node.metadata?.owner_user_id === userId)
    .map((node) => node.id));
  const mine = new Set<string>();

  for (const node of ir.nodes) {
    if (node.type === 'team' && ir.scope.team_ids.includes(node.entity_id)) mine.add(node.id);
    if (node.type === 'task' && node.metadata?.creator_user_id === userId) mine.add(node.id);
    if (node.type === 'agent' && ownAgentIds.has(node.id)) mine.add(node.id);
    if (ASSET_TYPES.has(node.type) && node.metadata?.owner_user_id === userId) mine.add(node.id);
  }

  for (const edge of ir.edges) {
    if (edge.type === 'assigned_to' && ownAgentIds.has(edge.target)) mine.add(edge.source);
    if ((edge.type === 'owns' || edge.type === 'fixed_binding') && ownAgentIds.has(edge.source)) mine.add(edge.target);
  }

  return SUMMARY_TYPES.map((type) => {
    const nodes = ir.nodes.filter((node) => node.type === type);
    return { type, mine: nodes.filter((node) => mine.has(node.id)).length, visible: nodes.length };
  });
}

export function layoutAtlas(projection: AtlasProjection): AtlasLayout {
  const width = 1310;
  const nodeWidth = 230;
  const nodeHeight = 76;
  const gap = 24;
  const positioned: PositionedAtlasNode[] = [];
  const byLane = new Map<TeamAtlasNodeType | 'asset' | 'work', TeamAtlasNode[]>();
  for (const node of stableNodes(projection.nodes)) {
    const lane = ASSET_TYPES.has(node.type) ? 'asset' : node.type === 'task' || node.type === 'agent' ? 'work' : node.type;
    const list = byLane.get(lane) ?? [];
    list.push(node);
    byLane.set(lane, list);
  }
  for (const nodes of byLane.values()) {
    nodes.sort((a, b) => (a.type === 'agent' ? 0 : a.type === 'task' ? 1 : 2) - (b.type === 'agent' ? 0 : b.type === 'task' ? 1 : 2)
      || (a.team_id ?? '').localeCompare(b.team_id ?? '') || a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
    nodes.forEach((node, index) => {
      const aggregateCount = typeof node.metadata?.count === 'number' ? node.metadata.count : undefined;
      positioned.push({ ...node, x: TYPE_X[node.type], y: 40 + index * (nodeHeight + gap), width: nodeWidth, height: nodeHeight, ...(aggregateCount === undefined ? {} : { aggregate_count: aggregateCount }) });
    });
  }
  const maxY = positioned.reduce((max, node) => Math.max(max, node.y + node.height), 220);
  return { nodes: positioned.sort((a, b) => a.id.localeCompare(b.id)), edges: projection.edges, width, height: maxY + 60 };
}

function edgePortX(
  node: PositionedAtlasNode,
  edge: TeamAtlasEdge,
  edges: TeamAtlasEdge[],
  side: 'source' | 'target',
): number {
  const incident = edges
    .filter((item) => item.type === 'assigned_to' && item[side] === node.id)
    .sort((a, b) => a.id.localeCompare(b.id));
  if (incident.length <= 1) return node.x + node.width / 2;
  const index = incident.findIndex((item) => item.id === edge.id);
  const span = Math.min(150, node.width - 40);
  return node.x + node.width / 2 + ((index / (incident.length - 1)) - 0.5) * span;
}

function edgePortY(
  node: PositionedAtlasNode,
  edge: TeamAtlasEdge,
  edges: TeamAtlasEdge[],
  side: 'source' | 'target',
): number {
  const incident = edges
    .filter((item) => item[side] === node.id)
    .sort((a, b) => a.id.localeCompare(b.id));
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
  if (edge.type === 'assigned_to' && source.x === target.x && source.y > target.y) {
    const sx = edgePortX(source, edge, edges, 'source');
    const sy = source.y;
    const tx = edgePortX(target, edge, edges, 'target');
    const ty = target.y + target.height;
    const mid = sy - Math.max(24, (sy - ty) / 2);
    return {
      path: `M ${sx} ${sy} V ${mid} H ${tx} V ${ty}`,
      labelX: sx + (tx - sx) / 2,
      labelY: mid - 7,
    };
  }
  const sx = source.x + source.width;
  const sy = edgePortY(source, edge, edges, 'source');
  const tx = target.x;
  const ty = edgePortY(target, edge, edges, 'target');
  const mid = sx + Math.max(24, (tx - sx) / 2);
  return {
    path: `M ${sx} ${sy} H ${mid} V ${ty} H ${tx}`,
    labelX: mid + (tx - mid) / 2,
    labelY: ty - 7,
  };
}

export function edgePath(edge: TeamAtlasEdge, nodes: PositionedAtlasNode[], edges: TeamAtlasEdge[] = [edge]): string {
  return edgeGeometry(edge, nodes, edges).path;
}

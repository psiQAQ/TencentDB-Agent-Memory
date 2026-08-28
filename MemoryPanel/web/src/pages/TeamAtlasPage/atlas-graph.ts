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
  identity: 40,
  team: 300,
  task: 560,
  agent: 820,
  skill: 1080,
  llm_wiki: 1080,
  code_graph: 1080,
  chat_memory: 1080,
};

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

export function layoutAtlas(projection: AtlasProjection): AtlasLayout {
  const width = 1320;
  const nodeWidth = 190;
  const nodeHeight = 58;
  const gap = 24;
  const positioned: PositionedAtlasNode[] = [];
  const byType = new Map<TeamAtlasNodeType, TeamAtlasNode[]>();
  for (const node of stableNodes(projection.nodes)) {
    const list = byType.get(node.type) ?? [];
    list.push(node);
    byType.set(node.type, list);
  }
  for (const [type, nodes] of byType) {
    nodes.forEach((node, index) => {
      const aggregateCount = typeof node.metadata?.count === 'number' ? node.metadata.count : undefined;
      positioned.push({ ...node, x: TYPE_X[type], y: 40 + index * (nodeHeight + gap), width: nodeWidth, height: nodeHeight, ...(aggregateCount === undefined ? {} : { aggregate_count: aggregateCount }) });
    });
  }
  const maxY = positioned.reduce((max, node) => Math.max(max, node.y + node.height), 220);
  return { nodes: positioned.sort((a, b) => a.id.localeCompare(b.id)), edges: projection.edges, width, height: maxY + 60 };
}

export function edgePath(edge: TeamAtlasEdge, nodes: PositionedAtlasNode[]): string {
  const source = nodes.find((node) => node.id === edge.source);
  const target = nodes.find((node) => node.id === edge.target);
  if (!source || !target) return '';
  const sx = source.x + source.width;
  const sy = source.y + source.height / 2;
  const tx = target.x;
  const ty = target.y + target.height / 2;
  const mid = sx + Math.max(24, (tx - sx) / 2);
  return `M ${sx} ${sy} H ${mid} V ${ty} H ${tx}`;
}

import { describe, expect, it } from 'vitest';
import { edgeGeometry, edgePath, layoutAtlas, projectAtlas, type PositionedAtlasNode } from '../web/src/pages/TeamAtlasPage/atlas-graph.js';
import type { TeamAtlasEdge } from '../web/src/lib/api/team-atlas.js';
import type { TeamAtlasIR, TeamAtlasNode } from '../web/src/lib/api/team-atlas.js';

function irWithNodes(nodes: TeamAtlasNode[]): TeamAtlasIR {
  const edges = nodes.filter((node) => node.type === 'team').map((node) => ({ id: `member:${node.id}`, type: 'member_of' as const, source: 'identity:user-1', target: node.id, team_id: node.team_id }));
  return {
    schema_version: 1,
    generated_at: '2026-08-28T00:00:00.000Z',
    scope: { user_id: 'user-1', team_ids: nodes.filter((node) => node.type === 'team').map((node) => node.entity_id) },
    completeness: 'complete',
    summary: { teams: 0, tasks: 0, agents: 0, assets: 0, edges: edges.length, warnings: 0 },
    nodes: [{ id: 'identity:user-1', entity_id: 'user-1', type: 'identity', label: 'User' }, ...nodes],
    edges,
    warnings: [],
  };
}

describe('Team Atlas projection and layout', () => {
  it('switches to a team summary at the 101-node boundary', () => {
    const nodes: TeamAtlasNode[] = Array.from({ length: 100 }, (_, index) => ({ id: `team:team-${index}`, entity_id: `team-${index}`, type: 'team', label: `Team ${index}`, team_id: `team-${index}` }));
    const projection = projectAtlas(irWithNodes(nodes), { maxNodes: 100 });
    expect(projection.mode).toBe('team_summary');
    expect(projection.truncated).toBe(true);
    expect(projection.nodes.every((node) => node.type === 'identity' || node.type === 'team')).toBe(true);
  });

  it('uses deterministic positions with no overlap inside a layer', () => {
    const input = irWithNodes([
      { id: 'team:b', entity_id: 'b', type: 'team', label: 'B', team_id: 'b' },
      { id: 'team:a', entity_id: 'a', type: 'team', label: 'A', team_id: 'a' },
    ]);
    const first = layoutAtlas(projectAtlas(input));
    const second = layoutAtlas(projectAtlas(input));
    expect(first).toEqual(second);
    const teamNodes = first.nodes.filter((node) => node.type === 'team');
    expect(teamNodes[1]!.y - teamNodes[0]!.y).toBeGreaterThanOrEqual(teamNodes[0]!.height);
  });

  it('lays out all four asset types in one shared lane without overlap', () => {
    const input = irWithNodes([
      { id: 'skill:s', entity_id: 's', type: 'skill', label: 'Skill', team_id: 'team-a' },
      { id: 'llm_wiki:w', entity_id: 'w', type: 'llm_wiki', label: 'Wiki', team_id: 'team-a' },
      { id: 'code_graph:c', entity_id: 'c', type: 'code_graph', label: 'Code', team_id: 'team-a' },
      { id: 'chat_memory:m', entity_id: 'm', type: 'chat_memory', label: 'Memory', team_id: 'team-a' },
    ]);
    const assets = layoutAtlas(projectAtlas(input)).nodes
      .filter((node) => ['skill', 'llm_wiki', 'code_graph', 'chat_memory'].includes(node.type))
      .sort((a, b) => a.y - b.y);
    expect(new Set(assets.map((node) => node.y)).size).toBe(4);
    expect(assets.every((node, index) => index === 0 || node.y - assets[index - 1]!.y >= node.height)).toBe(true);
  });

  it('builds orthogonal edge paths and omits dangling edges', () => {
    const input = irWithNodes([{ id: 'team:a', entity_id: 'a', type: 'team', label: 'A', team_id: 'a' }]);
    input.edges.push({ id: 'dangling', type: 'contains', source: 'team:a', target: 'task:missing' });
    const projection = projectAtlas(input);
    const layout = layoutAtlas(projection);
    expect(projection.edges.some((edge) => edge.id === 'dangling')).toBe(false);
    expect(edgePath(layout.edges[0]!, layout.nodes)).toMatch(/^M .* H .* V .* H /);
  });

  it('uses distinct ports for multiple relationships on the same pair of cards', () => {
    const nodes: PositionedAtlasNode[] = [
      { id: 'agent:a', entity_id: 'a', type: 'agent', label: 'Agent', x: 0, y: 0, width: 230, height: 76 },
      { id: 'skill:s', entity_id: 's', type: 'skill', label: 'Skill', x: 330, y: 0, width: 230, height: 76 },
    ];
    const edges: TeamAtlasEdge[] = [
      { id: 'owns', type: 'owns', source: 'agent:a', target: 'skill:s' },
      { id: 'binding', type: 'fixed_binding', source: 'agent:a', target: 'skill:s' },
    ];
    expect(edgeGeometry(edges[0]!, nodes, edges).path).not.toBe(edgeGeometry(edges[1]!, nodes, edges).path);
  });
});

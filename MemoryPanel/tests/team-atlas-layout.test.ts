import { describe, expect, it } from 'vitest';
import { edgePath, layoutAtlas, projectAtlas } from '../web/src/pages/TeamAtlasPage/atlas-graph.js';
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

  it('builds orthogonal edge paths and omits dangling edges', () => {
    const input = irWithNodes([{ id: 'team:a', entity_id: 'a', type: 'team', label: 'A', team_id: 'a' }]);
    input.edges.push({ id: 'dangling', type: 'contains', source: 'team:a', target: 'task:missing' });
    const projection = projectAtlas(input);
    const layout = layoutAtlas(projection);
    expect(projection.edges.some((edge) => edge.id === 'dangling')).toBe(false);
    expect(edgePath(layout.edges[0]!, layout.nodes)).toMatch(/^M .* H .* V .* H /);
  });
});

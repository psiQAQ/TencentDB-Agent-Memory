import { describe, expect, it } from 'vitest';
import { atlasInteractionEdges, directRelationIds, directVisualNodeIds, edgeGeometry, edgePath, layoutAtlas, projectAtlas, summarizeAtlas, type PositionedAtlasNode } from '../web/src/pages/TeamAtlasPage/atlas-graph.js';
import type { TeamAtlasEdge } from '../web/src/lib/api/team-atlas.js';
import type { TeamAtlasIR, TeamAtlasNode } from '../web/src/lib/api/team-atlas.js';

function irWithNodes(nodes: TeamAtlasNode[]): TeamAtlasIR {
  const teamIds = [...new Set(nodes.map((node) => node.team_id).filter((teamId): teamId is string => Boolean(teamId)))];
  const explicitTeamIds = new Set(nodes.filter((node) => node.type === 'team').map((node) => node.entity_id));
  const teams: TeamAtlasNode[] = teamIds.filter((teamId) => !explicitTeamIds.has(teamId)).map((teamId) => ({ id: `team:${teamId}`, entity_id: teamId, type: 'team', label: teamId, team_id: teamId }));
  const identities: TeamAtlasNode[] = teamIds.map((teamId) => ({ id: `identity:${teamId}:user-1`, entity_id: 'user-1', type: 'identity', label: 'User', team_id: teamId, metadata: { is_current: true } }));
  const edges = teamIds.map((teamId) => ({ id: `member:${teamId}`, type: 'member_of' as const, source: `team:${teamId}`, target: `identity:${teamId}:user-1`, team_id: teamId }));
  return {
    schema_version: 1,
    generated_at: '2026-08-28T00:00:00.000Z',
    scope: { user_id: 'user-1', team_ids: teamIds },
    completeness: 'complete',
    summary: { teams: 0, tasks: 0, agents: 0, assets: 0, edges: edges.length, warnings: 0 },
    nodes: [...identities, ...teams, ...nodes],
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

  it('stacks multiple team hierarchies without vertical overlap', () => {
    const input = irWithNodes([
      { id: 'team:a', entity_id: 'a', type: 'team', label: 'A', team_id: 'a' },
      { id: 'team:b', entity_id: 'b', type: 'team', label: 'B', team_id: 'b' },
      { id: 'agent:a', entity_id: 'agent-a', type: 'agent', label: 'Agent A', team_id: 'a', metadata: { owner_user_id: 'user-1' } },
      { id: 'agent:b', entity_id: 'agent-b', type: 'agent', label: 'Agent B', team_id: 'b', metadata: { owner_user_id: 'user-1' } },
    ]);
    const layout = layoutAtlas(projectAtlas(input));
    const first = layout.nodes.filter((node) => node.team_id === 'a');
    const second = layout.nodes.filter((node) => node.team_id === 'b');
    expect(Math.max(...first.map((node) => node.y + node.height))).toBeLessThan(Math.min(...second.map((node) => node.y)));
  });

  it('can hide assets that are not bound to an Agent owned by the current user', () => {
    const input = irWithNodes([
      { id: 'agent:mine', entity_id: 'mine', type: 'agent', label: 'Mine', team_id: 'team-a', metadata: { owner_user_id: 'user-1' } },
      { id: 'agent:other', entity_id: 'other', type: 'agent', label: 'Other', team_id: 'team-a', metadata: { owner_user_id: 'user-2' } },
      { id: 'skill:mine', entity_id: 'mine', type: 'skill', label: 'Mine', team_id: 'team-a' },
      { id: 'skill:other', entity_id: 'other', type: 'skill', label: 'Other', team_id: 'team-a' },
    ]);
    input.edges.push(
      { id: 'bind:mine', type: 'fixed_binding', source: 'agent:mine', target: 'skill:mine', team_id: 'team-a' },
      { id: 'bind:other', type: 'fixed_binding', source: 'agent:other', target: 'skill:other', team_id: 'team-a' },
    );
    const projection = projectAtlas(input, { showUnboundAssets: false });
    expect(projection.nodes.some((node) => node.id === 'skill:mine')).toBe(true);
    expect(projection.nodes.some((node) => node.id === 'skill:other')).toBe(false);
  });

  it('can hide identities, Agents, and assets owned by other users while retaining the Team', () => {
    const input = irWithNodes([
      { id: 'team:team-a', entity_id: 'team-a', type: 'team', label: 'Team A', team_id: 'team-a' },
      { id: 'identity:team-a:user-2', entity_id: 'user-2', type: 'identity', label: 'Other', team_id: 'team-a' },
      { id: 'agent:mine', entity_id: 'mine', type: 'agent', label: 'Mine', team_id: 'team-a', metadata: { owner_user_id: 'user-1' } },
      { id: 'agent:other', entity_id: 'other', type: 'agent', label: 'Other', team_id: 'team-a', metadata: { owner_user_id: 'user-2' } },
      { id: 'skill:mine', entity_id: 'mine', type: 'skill', label: 'Mine', team_id: 'team-a', metadata: { owner_user_id: 'user-1' } },
      { id: 'skill:other', entity_id: 'other', type: 'skill', label: 'Other', team_id: 'team-a', metadata: { owner_user_id: 'user-2' } },
    ]);
    input.edges.push({ id: 'member:other', type: 'member_of', source: 'team:team-a', target: 'identity:team-a:user-2' });
    const projection = projectAtlas(input, { showOtherOwners: false });
    expect(projection.nodes.map((node) => node.id)).toEqual(expect.arrayContaining(['team:team-a', 'identity:team-a:user-1', 'agent:mine', 'skill:mine']));
    expect(projection.nodes.map((node) => node.id)).not.toEqual(expect.arrayContaining(['identity:team-a:user-2', 'agent:other', 'skill:other']));
  });

  it('sorts the current owner first and horizontally aligns each Identity with its first Agent', () => {
    const input = irWithNodes([
      { id: 'identity:team-a:user-2', entity_id: 'user-2', type: 'identity', label: 'A Other', team_id: 'team-a' },
      { id: 'agent:other', entity_id: 'other', type: 'agent', label: 'A Other', team_id: 'team-a', metadata: { owner_user_id: 'user-2' } },
      { id: 'agent:mine', entity_id: 'mine', type: 'agent', label: 'Z Mine', team_id: 'team-a', metadata: { owner_user_id: 'user-1' } },
      { id: 'task:one', entity_id: 'one', type: 'task', label: 'One', team_id: 'team-a' },
      { id: 'task:two', entity_id: 'two', type: 'task', label: 'Two', team_id: 'team-a' },
      { id: 'chat_memory:other', entity_id: 'other-memory', type: 'chat_memory', label: 'A Other', team_id: 'team-a', metadata: { owner_user_id: 'user-2' } },
      { id: 'chat_memory:mine', entity_id: 'mine-memory', type: 'chat_memory', label: 'Z Mine', team_id: 'team-a', metadata: { owner_user_id: 'user-1' } },
    ]);
    input.edges.push(
      { id: 'member:other', type: 'member_of', source: 'team:team-a', target: 'identity:team-a:user-2' },
      { id: 'assigned:one', type: 'assigned_to', source: 'task:one', target: 'agent:mine' },
      { id: 'assigned:two', type: 'assigned_to', source: 'task:two', target: 'agent:mine' },
    );
    const layout = layoutAtlas(projectAtlas(input));
    const mineIdentity = layout.nodes.find((node) => node.id === 'identity:team-a:user-1')!;
    const mineAgent = layout.nodes.find((node) => node.id === 'agent:mine')!;
    const otherIdentity = layout.nodes.find((node) => node.id === 'identity:team-a:user-2')!;
    const team = layout.nodes.find((node) => node.id === 'team:team-a')!;
    expect(mineIdentity.y).toBeLessThan(otherIdentity.y);
    expect(mineIdentity.y).toBe(mineAgent.y);
    expect(team.y + team.height / 2).toBe((mineIdentity.y + mineIdentity.height / 2 + otherIdentity.y + otherIdentity.height / 2) / 2);
    const memories = layout.nodes.filter((node) => node.type === 'chat_memory').sort((a, b) => a.y - b.y);
    expect(memories[0]!.id).toBe('chat_memory:mine');
  });

  it('places assigned Tasks below the Agent cards in the shared work lane', () => {
    const input = irWithNodes([
      { id: 'agent:a', entity_id: 'a', type: 'agent', label: 'Agent A', team_id: 'team-a', metadata: { owner_user_id: 'user-1' } },
      { id: 'agent:b', entity_id: 'b', type: 'agent', label: 'Agent B', team_id: 'team-a', metadata: { owner_user_id: 'user-1' } },
      { id: 'task:t', entity_id: 't', type: 'task', label: 'Task', team_id: 'team-a' },
    ]);
    input.edges.push(
      { id: 'assigned:a', type: 'assigned_to', source: 'task:t', target: 'agent:a' },
      { id: 'assigned:b', type: 'assigned_to', source: 'task:t', target: 'agent:b' },
    );
    const layout = layoutAtlas(projectAtlas(input));
    const tasks = layout.nodes.filter((node) => node.type === 'task');
    const agents = layout.nodes.filter((node) => node.type === 'agent');
    expect(tasks).toHaveLength(2);
    for (const task of tasks) {
      const parent = agents.find((agent) => agent.id === task.parent_agent_id)!;
      expect(task.x).toBeGreaterThan(parent.x);
      expect(task.y).toBeGreaterThan(parent.y);
    }
    expect(edgeGeometry(layout.edges.find((edge) => edge.id === 'assigned:a')!, layout.nodes, layout.edges).path).toBe('');
  });

  it('summarizes mine versus visible entities for all seven card types', () => {
    const input = irWithNodes([
      { id: 'team:a', entity_id: 'a', type: 'team', label: 'Team A', team_id: 'a' },
      { id: 'agent:mine', entity_id: 'mine', type: 'agent', label: 'Mine', team_id: 'a', metadata: { owner_user_id: 'user-1' } },
      { id: 'agent:other', entity_id: 'other', type: 'agent', label: 'Other', team_id: 'a', metadata: { owner_user_id: 'user-2' } },
      { id: 'task:mine', entity_id: 'mine', type: 'task', label: 'Mine', team_id: 'a', metadata: { creator_user_id: 'user-2' } },
      { id: 'task:other', entity_id: 'other', type: 'task', label: 'Other', team_id: 'a', metadata: { creator_user_id: 'user-2' } },
      { id: 'skill:mine', entity_id: 'mine', type: 'skill', label: 'Mine', team_id: 'a', metadata: { owner_user_id: 'user-2' } },
      { id: 'skill:other', entity_id: 'other', type: 'skill', label: 'Other', team_id: 'a', metadata: { owner_user_id: 'user-2' } },
      { id: 'llm_wiki:mine', entity_id: 'mine', type: 'llm_wiki', label: 'Wiki', team_id: 'a', metadata: { owner_user_id: 'user-1' } },
      { id: 'code_graph:other', entity_id: 'other', type: 'code_graph', label: 'Code', team_id: 'a', metadata: { owner_user_id: 'user-2' } },
      { id: 'chat_memory:mine', entity_id: 'mine', type: 'chat_memory', label: 'Memory', team_id: 'a', metadata: { owner_user_id: 'user-1' } },
    ]);
    input.edges.push(
      { id: 'assigned:mine', type: 'assigned_to', source: 'task:mine', target: 'agent:mine' },
      { id: 'assigned:other', type: 'assigned_to', source: 'task:other', target: 'agent:other' },
      { id: 'binding:mine', type: 'fixed_binding', source: 'agent:mine', target: 'skill:mine' },
    );
    expect(summarizeAtlas(input)).toEqual([
      { type: 'team', mine: 1, visible: 1 },
      { type: 'task', mine: 1, visible: 2 },
      { type: 'agent', mine: 1, visible: 2 },
      { type: 'skill', mine: 1, visible: 2 },
      { type: 'llm_wiki', mine: 1, visible: 1 },
      { type: 'code_graph', mine: 0, visible: 1 },
      { type: 'chat_memory', mine: 1, visible: 1 },
    ]);
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

  it('omits owns edges from canvas interaction while keeping fixed bindings', () => {
    const edges: TeamAtlasEdge[] = [
      { id: 'owns', type: 'owns', source: 'agent:a', target: 'skill:s' },
      { id: 'binding', type: 'fixed_binding', source: 'agent:a', target: 'skill:s' },
    ];
    expect(atlasInteractionEdges(edges)).toEqual([edges[1]]);
  });

  it('highlights only the selected node and its direct parents and children', () => {
    const edges: TeamAtlasEdge[] = [
      { id: 'team-member', type: 'member_of', source: 'team:t', target: 'identity:u' },
      { id: 'member-agent', type: 'contains', source: 'identity:u', target: 'agent:a' },
      { id: 'agent-asset', type: 'fixed_binding', source: 'agent:a', target: 'skill:s' },
      { id: 'sibling-agent', type: 'contains', source: 'identity:u', target: 'agent:b' },
    ];
    expect([...directRelationIds(edges, 'agent:a')].sort()).toEqual(['agent:a', 'identity:u', 'skill:s']);
    expect(directRelationIds(edges, 'agent:a').has('team:t')).toBe(false);
    expect(directRelationIds(edges, 'agent:a').has('agent:b')).toBe(false);
  });

  it('highlights only the Task instance attached to the selected Agent', () => {
    const nodes: PositionedAtlasNode[] = [
      { id: 'agent:a', entity_id: 'a', type: 'agent', label: 'A', x: 0, y: 0, width: 220, height: 72 },
      { id: 'agent:b', entity_id: 'b', type: 'agent', label: 'B', x: 0, y: 100, width: 220, height: 72 },
      { id: 'task:t@agent:a', logical_id: 'task:t', parent_agent_id: 'agent:a', entity_id: 't', type: 'task', label: 'T', x: 240, y: 0, width: 208, height: 40 },
      { id: 'task:t@agent:b', logical_id: 'task:t', parent_agent_id: 'agent:b', entity_id: 't', type: 'task', label: 'T', x: 240, y: 100, width: 208, height: 40 },
    ];
    const edges: TeamAtlasEdge[] = [
      { id: 'assigned:a', type: 'assigned_to', source: 'task:t', target: 'agent:a' },
      { id: 'assigned:b', type: 'assigned_to', source: 'task:t', target: 'agent:b' },
    ];
    expect([...directVisualNodeIds(nodes, edges, nodes[0]!)].sort()).toEqual(['agent:a', 'task:t@agent:a']);
    expect([...directVisualNodeIds(nodes, edges, nodes[3]!)].sort()).toEqual(['agent:b', 'task:t@agent:b']);
  });

  it('uses an evenly offset vertical trunk for every edge between the same columns', () => {
    const nodes: PositionedAtlasNode[] = [
      { id: 'team:t', entity_id: 't', type: 'team', label: 'Team', x: 0, y: 100, width: 220, height: 72 },
      ...Array.from({ length: 5 }, (_, index) => ({ id: `identity:t:u${index}`, entity_id: `u${index}`, type: 'identity' as const, label: `U${index}`, x: 310, y: index * 90, width: 220, height: 72 })),
    ];
    const edges: TeamAtlasEdge[] = nodes.slice(1).map((node) => ({ id: `member:${node.id}`, type: 'member_of', source: 'team:t', target: node.id }));
    const trunks = edges.map((edge) => edgeGeometry(edge, nodes, edges).path.match(/H ([\d.]+) V/)?.[1]);
    expect(new Set(trunks).size).toBe(edges.length);
    const orderedByTarget = [...edges].sort((a, b) => nodes.find((node) => node.id === a.target)!.y - nodes.find((node) => node.id === b.target)!.y);
    const sourcePorts = orderedByTarget.map((edge) => Number(edgeGeometry(edge, nodes, edges).path.match(/^M [\d.]+ ([\d.]+)/)?.[1]));
    const orderedTrunks = orderedByTarget.map((edge) => Number(edgeGeometry(edge, nodes, edges).path.match(/H ([\d.]+) V/)?.[1]));
    expect(sourcePorts).toEqual([...sourcePorts].sort((a, b) => a - b));
    expect(orderedTrunks).toEqual([...orderedTrunks].sort((a, b) => a - b));
  });
});

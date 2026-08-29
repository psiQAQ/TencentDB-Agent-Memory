import { describe, expect, it, vi } from 'vitest';
import {
  buildTeamAtlasIR,
  mapInBatches,
  type TeamAtlasSnapshot,
} from '../src/panel/http/routes/team-atlas.js';

function snapshot(overrides: Partial<TeamAtlasSnapshot> = {}): TeamAtlasSnapshot {
  return {
    team: { team_id: 'team-1', name: 'Atlas', owner_user_id: 'user-1' },
    role: 'admin',
    members: [{ user_id: 'user-1', username: 'alice', role: 'admin', status: 'active' }],
    tasks: [{ task_id: 'task-1', team_id: 'team-1', title: 'Ship Atlas', status: 'active', creator_user_id: 'user-1', source_type: 'manual' }],
    agents: [{ agent_id: 'agt-1', team_id: 'team-1', owner_user_id: 'user-1', name: 'Codex', status: 'active' }],
    assets: [{ asset_id: 'skill-1', team_id: 'team-1', asset_type: 'skill', name: 'Planner', owner_user_id: 'user-1', status: 'active' }],
    taskAgents: [{ task_id: 'task-1', agent_id: 'agt-1', status: 'active' }],
    fixedAssets: [],
    skills: [{ skill_id: 'skill-1', owner_agent_id: 'agt-1', status: 'active' }],
    complete: { members: true, tasks: true, agents: true, assets: true, taskAgents: true, fixedAssets: true, skills: true },
    failedSources: [],
    ...overrides,
  };
}

describe('buildTeamAtlasIR', () => {
  it('creates stable namespaced nodes and no dangling edges', () => {
    const ir = buildTeamAtlasIR('user-1', [snapshot()], '2026-08-28T00:00:00.000Z');
    const ids = new Set(ir.nodes.map((node) => node.id));
    expect(ir.completeness).toBe('complete');
    expect(ir.nodes.map((node) => node.id)).toEqual([
      'agent:agt-1',
      'identity:team-1:user-1',
      'skill:skill-1',
      'task:task-1',
      'team:team-1',
    ]);
    expect(ir.edges.every((edge) => ids.has(edge.source) && ids.has(edge.target))).toBe(true);
    expect(ir.edges.some((edge) => edge.type === 'assigned_to')).toBe(true);
    expect(ir.edges.some((edge) => edge.type === 'owns')).toBe(true);
    expect(ir.edges.some((edge) => edge.source.startsWith('task:') && edge.target.startsWith('skill:'))).toBe(false);
    expect(ir.nodes.find((node) => node.id === 'team:team-1')?.metadata?.owner_user_id).toBe('user-1');
    expect(ir.nodes.find((node) => node.id === 'task:task-1')?.metadata).toMatchObject({ creator_user_id: 'user-1', source_type: 'manual' });
    expect(ir.nodes.find((node) => node.id === 'agent:agt-1')?.metadata?.owner_user_id).toBe('user-1');
    expect(ir.nodes.find((node) => node.id === 'identity:team-1:user-1')?.metadata).toMatchObject({ role: 'admin', is_current: true });
    expect(ir.edges).toContainEqual(expect.objectContaining({ type: 'member_of', source: 'team:team-1', target: 'identity:team-1:user-1' }));
    expect(ir.edges).toContainEqual(expect.objectContaining({ type: 'contains', source: 'identity:team-1:user-1', target: 'agent:agt-1' }));
    expect(ir.warnings).toEqual([]);
  });

  it('does not infer empty-state warnings from failed sources', () => {
    const ir = buildTeamAtlasIR('user-1', [snapshot({
      tasks: [],
      taskAgents: [],
      complete: { members: true, tasks: false, agents: true, assets: true, taskAgents: false, fixedAssets: true, skills: true },
      failedSources: ['task/list'],
    })]);
    expect(ir.completeness).toBe('partial');
    expect(ir.warnings.some((warning) => warning.code === 'SOURCE_PARTIAL')).toBe(true);
    expect(ir.warnings.some((warning) => warning.code === 'TEAM_WITHOUT_TASKS')).toBe(false);
  });

  it('creates a separate member node for the same user in each team', () => {
    const second = snapshot({
      team: { team_id: 'team-2', name: 'Beta', owner_user_id: 'user-1' },
      tasks: [], agents: [], assets: [], taskAgents: [], skills: [],
    });
    const ir = buildTeamAtlasIR('user-1', [snapshot(), second]);
    expect(ir.nodes.filter((node) => node.type === 'identity').map((node) => node.id)).toEqual([
      'identity:team-1:user-1',
      'identity:team-2:user-1',
    ]);
  });

  it('filters links that point to invisible assets', () => {
    const ir = buildTeamAtlasIR('user-1', [snapshot({
      assets: [],
      fixedAssets: [{ agent_id: 'agt-1', asset_id: 'private-asset', asset_type: 'llm_wiki' }],
      skills: [],
    })]);
    expect(ir.nodes.some((node) => node.entity_id === 'private-asset')).toBe(false);
    expect(ir.edges.some((edge) => edge.target.includes('private-asset'))).toBe(false);
  });
});

describe('mapInBatches', () => {
  it('starts at most twenty agent requests before awaiting the next batch', async () => {
    let active = 0;
    let peak = 0;
    const mapper = vi.fn(async (value: number) => {
      active += 1;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active -= 1;
      return value;
    });
    const result = await mapInBatches(Array.from({ length: 41 }, (_, index) => index), 20, mapper);
    expect(result).toHaveLength(41);
    expect(peak).toBe(20);
  });
});

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { provisionDefaultAgentForCaller } from '../src/panel/http/routes/meta/proxy.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('explicit default Agent provisioning', () => {
  it('is retry-safe and fills only a previously failed default Skill', async () => {
    const agentTemplateDir = mkdtempSync(path.join(tmpdir(), 'memory-panel-default-agent-'));
    dirs.push(agentTemplateDir);
    let agent: { agent_id: string; name: string } | null = null;
    let failOneSkill = true;
    const skillNames = new Set<string>();
    const metaInvoke = vi.fn(async (action: string, body: Record<string, unknown>) => {
      if (action === 'user/get') return { code: 0, message: 'ok', data: { username: 'normal_user' } };
      if (action === 'agent/list') return { code: 0, message: 'ok', data: { items: agent ? [agent] : [], total: agent ? 1 : 0 } };
      if (action === 'agent/create') {
        agent = { agent_id: 'agt-default', name: String(body.name) };
        return { code: 0, message: 'ok', data: agent };
      }
      throw new Error(`unexpected action: ${action}`);
    });
    const skillInvoke = vi.fn(async (action: string, body: Record<string, unknown>) => {
      expect(action).toBe('create');
      const name = String(body.name);
      if (failOneSkill) {
        failOneSkill = false;
        return { code: 500, message: 'temporary failure', data: null };
      }
      if (skillNames.has(name)) return { code: 42201, message: 'duplicate', data: null };
      skillNames.add(name);
      return { code: 0, message: 'ok', data: { skill_id: `skill-${skillNames.size}` } };
    });
    const deps = {
      config: { agentTemplateDir },
      metaKernel: { invoke: metaInvoke },
      skillKernel: { invoke: skillInvoke },
      logger: { info: vi.fn(), warn: vi.fn() },
    } as never;

    const ctx = { instanceId: 'local' } as never;
    const first = await provisionDefaultAgentForCaller('usr-normal', 'team-1', ctx, deps);
    const second = await provisionDefaultAgentForCaller('usr-normal', 'team-1', ctx, deps);

    expect(first.agent_created).toBe(true);
    expect(first.failed_assets).toHaveLength(1);
    expect(second.agent_created).toBe(false);
    expect(second.failed_assets).toEqual([]);
    expect(metaInvoke.mock.calls.filter(([action]) => action === 'agent/create')).toHaveLength(1);
    expect(skillNames.size).toBe(3);
  });
});

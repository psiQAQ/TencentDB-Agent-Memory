import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { provisionDefaultAgentForCaller } from '../src/panel/http/routes/meta/proxy.js';
import { createAgentTemplate } from '../src/panel/state/agent-template-store.js';

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
      if (action === 'agent/list')
        return {
          code: 0,
          message: 'ok',
          data: { items: agent ? [agent] : [], total: agent ? 1 : 0 },
        };
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
      return {
        code: 0,
        message: 'ok',
        data: { skill_id: `skill-${skillNames.size}` },
      };
    });
    const deps = {
      config: { agentTemplateDir },
      metaKernel: { invoke: metaInvoke },
      skillKernel: { invoke: skillInvoke },
      logger: { info: vi.fn(), warn: vi.fn() },
    } as never;

    const ctx = { instanceId: 'local' } as never;
    const first = await provisionDefaultAgentForCaller('usr-normal', 'team-1', null, ctx, deps);
    const second = await provisionDefaultAgentForCaller('usr-normal', 'team-1', null, ctx, deps);

    expect(first.agent_created).toBe(true);
    expect(first.failed_assets).toHaveLength(1);
    expect(second.agent_created).toBe(false);
    expect(second.failed_assets).toEqual([]);
    expect(metaInvoke.mock.calls.filter(([action]) => action === 'agent/create')).toHaveLength(1);
    expect(skillNames.size).toBe(3);
  });

  it('requires and provisions the selected template when a Team has multiple templates', async () => {
    const agentTemplateDir = mkdtempSync(path.join(tmpdir(), 'memory-panel-default-agent-'));
    dirs.push(agentTemplateDir);
    const first = createAgentTemplate(
      agentTemplateDir,
      'local',
      'team-1',
      { name: 'first-template', visibility: 'team', asset_ids: {} },
      'creator',
    );
    const second = createAgentTemplate(
      agentTemplateDir,
      'local',
      'team-1',
      { name: 'second-template', visibility: 'team', asset_ids: {} },
      'creator',
    );
    const metaInvoke = vi.fn(async (action: string, body: Record<string, unknown>) => {
      if (action === 'user/get') return { code: 0, message: 'ok', data: { username: 'normal_user' } };
      if (action === 'agent/list') return { code: 0, message: 'ok', data: { items: [], total: 0 } };
      if (action === 'agent/create') {
        return {
          code: 0,
          message: 'ok',
          data: {
            agent_id: 'agt-second',
            name: String(body.name),
            metadata_json: body.metadata_json,
          },
        };
      }
      throw new Error(`unexpected action: ${action}`);
    });
    const deps = {
      config: { agentTemplateDir },
      metaKernel: { invoke: metaInvoke },
      logger: { info: vi.fn(), warn: vi.fn() },
    } as never;
    const ctx = { instanceId: 'local' } as never;

    await expect(provisionDefaultAgentForCaller('usr-normal', 'team-1', null, ctx, deps)).rejects.toThrow(
      'TEMPLATE_ID_REQUIRED',
    );

    const result = await provisionDefaultAgentForCaller('usr-normal', 'team-1', second.template_id, ctx, deps);
    expect(result.agent_name).toBe('second-template');
    expect(first.template_id).not.toBe(second.template_id);
    const createBody = metaInvoke.mock.calls.find(([action]) => action === 'agent/create')?.[1];
    expect(createBody?.description).toBe('');
    expect(JSON.parse(String(createBody?.metadata_json))).toMatchObject({
      panel_provisioning: { template_id: second.template_id },
    });
  });
});

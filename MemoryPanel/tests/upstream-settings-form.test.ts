import { expect, it, vi } from 'vitest';
import {
  draftFromExtraction, draftFromGroup, emptyModelDraft, modelFailureMessage, modelWriteRequest,
  validateModelDraft, writeModelAndReload, type ModelGroup,
} from '../web/src/lib/upstream-settings-form.js';

const saved: ModelGroup = {
  group_id: 'group-a', group_type: 'custom', name: 'Primary', agents: ['codex'], enabled: true,
  mode: 'custom_unified', base_url: 'https://api.deepseek.com', api_key_masked: 'synthet…',
  model_id: 'deepseek-flash', version: 4,
};

it('allows saving a configured group before changing any client assignment', () => {
  const draft = { ...emptyModelDraft(), name: '开发组', api_key: 'synthetic-supplier-key' };
  expect(validateModelDraft(draft)).toEqual({});
  expect(modelWriteRequest(draft)).toMatchObject({ action: 'instance-upstream/groups/create', body: { agents: [] } });
});

it('explains each missing field independently and keeps extraction errors about extraction fields', () => {
  const draft = { ...emptyModelDraft(), name: '', base_url: '', model_id: '', api_key: '' };
  expect(Object.keys(validateModelDraft(draft)).sort()).toEqual(['api_key', 'base_url', 'model_id', 'name']);
  expect(validateModelDraft(draft, undefined, true).name).toBeUndefined();
});

it('identifies a Panel login key pasted into the supplier credential field', () => {
  expect(validateModelDraft({ ...emptyModelDraft(), name: 'Primary', api_key: 'sk-mem-synthetic-user-key' }).api_key)
    .toContain('模型供应商');
});

it('retains an existing same-origin key while editing and requires a new-origin key', () => {
  const draft = draftFromGroup(saved);
  expect(draft.api_key).toBe('');
  expect(validateModelDraft({ ...draft, base_url: 'https://api.deepseek.com/v1' }, saved)).toEqual({});
  expect(validateModelDraft({ ...draft, base_url: 'https://other.example/v1' }, saved).api_key).toBeTruthy();
  expect(validateModelDraft({ ...draft, group_id: undefined }, undefined).api_key).toBeTruthy();
});

it('does not include a hidden supplier key in a passthrough group request', () => {
  const draft = { ...emptyModelDraft(), name: 'Client supplier credentials', mode: 'custom_passthrough' as const,
    api_key: 'synthetic-unused-secret' };
  expect(validateModelDraft(draft)).toEqual({});
  expect(modelWriteRequest(draft).body).not.toHaveProperty('api_key');
});

it('uses the version captured when the extraction editor opened', () => {
  const extraction = { configured: true, enabled: true, base_url: saved.base_url,
    model_id: saved.model_id, api_key_masked: saved.api_key_masked, version: 2 };
  const draft = draftFromExtraction(extraction);
  expect(modelWriteRequest(draft, { ...extraction, version: 3 }).body.expected_version).toBe(2);
});

it('starts unconfigured extraction with consistent provider and model presets', () => {
  expect(draftFromExtraction({ configured: false, enabled: false })).toEqual(emptyModelDraft());
});

it('preserves custom model IDs and does not mutate saved client assignments', () => {
  const draft = draftFromGroup({ ...saved, model_id: 'my-custom-model' });
  expect(draft.custom_model).toBe(true);
  draft.agents.push('pi');
  expect(saved.agents).toEqual(['codex']);
});

it('rejects secret-bearing URLs and explains container-local addresses', () => {
  const draft = { ...emptyModelDraft(), name: 'Local', api_key: 'synthetic-key' };
  for (const url of ['https://user:secret@api.deepseek.com', 'https://api.deepseek.com?api_key=secret']) {
    expect(validateModelDraft({ ...draft, base_url: url }).base_url).toBeTruthy();
  }
  expect(validateModelDraft({ ...draft, provider: 'local', base_url: 'http://localhost:11434/v1' }).base_url)
    .toContain('host.docker.internal');
});

it('reports a successful save separately from a failed page refresh', async () => {
  const write = vi.fn().mockResolvedValue({});
  const reload = vi.fn().mockRejectedValue(new Error('read unavailable'));
  await expect(writeModelAndReload(write, reload)).resolves.toEqual({ refreshFailed: true });
  expect(write).toHaveBeenCalledTimes(1);
});

it('keeps a rejected write actionable without refreshing or exposing error bodies', async () => {
  const write = vi.fn().mockRejectedValue({ code: 'DUPLICATE_GROUP_NAME', body: 'synthetic-secret' });
  const reload = vi.fn();
  await expect(writeModelAndReload(write, reload)).rejects.toMatchObject({ code: 'DUPLICATE_GROUP_NAME' });
  expect(reload).not.toHaveBeenCalled();
  expect(modelFailureMessage({ code: 'DUPLICATE_GROUP_NAME' })).toContain('名称已存在');
  expect(modelFailureMessage({ code: 'synthetic-secret', message: 'synthetic-secret' })).not.toContain('synthetic-secret');
});

it('uses the named error prefix from the numeric Core error envelope', () => {
  for (const [status, code, expected] of [
    [400, 'DUPLICATE_GROUP_NAME', '模型组名称已存在'],
    [400, 'AGENTS_OVERLAP', '客户端已经分配'],
    [409, 'WRITE_CONFLICT', '配置已被其他操作更新'],
    [404, 'GROUP_NOT_FOUND', '此模型组已被删除'],
    [403, 'permission_denied', '只有 system admin'],
  ] as const) {
    const error = { code: status, rawMessage: `${code}: synthetic-secret`, body: 'synthetic-secret' };
    expect(modelFailureMessage(error)).toContain(expected);
    expect(modelFailureMessage(error)).not.toContain('synthetic-secret');
  }
  expect(modelFailureMessage({
    code: 502, rawMessage: 'PROXY_PROBE_UNAVAILABLE',
  })).toContain('测试服务暂时不可用');
});

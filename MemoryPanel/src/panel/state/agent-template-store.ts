/**
 * Team 默认 Agent 模板的本地集合存储。
 *
 * 新格式：{dir}/{instanceId}/{team_id}/templates.json
 * 旧格式 template.json 会在读取时映射为稳定的 legacy 模板，并在首次写入时并入集合。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

export interface AgentTemplateAssetIds {
  skills?: string[];
  code_graphs?: string[];
  wikis?: string[];
}

export interface AgentTemplateConfig {
  template_id: string;
  name: string;
  description?: string | null;
  prompt?: string | null;
  visibility?: string;
  metadata_json?: string;
  asset_ids?: AgentTemplateAssetIds;
  created_by?: string | null;
  updated_by?: string | null;
  created_at: string;
  updated_at: string;
}

export type AgentTemplateInput = Omit<
  AgentTemplateConfig,
  'template_id' | 'created_by' | 'updated_by' | 'created_at' | 'updated_at'
>;

interface AgentTemplateCollection {
  schema_version: 2;
  templates: AgentTemplateConfig[];
}

function teamDirectory(dir: string, instanceId: string, teamId: string): string {
  if (/[/\\]|\.\./.test(teamId)) {
    throw new Error(`invalid team_id for template path: ${teamId}`);
  }
  return path.join(dir, instanceId, teamId);
}

function readJson<T>(filePath: string): T | null {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8')) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    throw err;
  }
}

function readLegacyTemplate(dir: string, instanceId: string, teamId: string): AgentTemplateConfig | null {
  const legacy = readJson<AgentTemplateInput>(path.join(teamDirectory(dir, instanceId, teamId), 'template.json'));
  if (!legacy?.name) return null;
  const timestamp = new Date(0).toISOString();
  return {
    ...legacy,
    template_id: 'tpl-legacy',
    created_by: null,
    updated_by: null,
    created_at: timestamp,
    updated_at: timestamp,
  };
}

export function listAgentTemplates(dir: string, instanceId: string, teamId: string): AgentTemplateConfig[] {
  const collection = readJson<AgentTemplateCollection>(
    path.join(teamDirectory(dir, instanceId, teamId), 'templates.json'),
  );
  if (collection) return Array.isArray(collection.templates) ? collection.templates : [];
  const legacy = readLegacyTemplate(dir, instanceId, teamId);
  return legacy ? [legacy] : [];
}

function saveCollection(dir: string, instanceId: string, teamId: string, templates: AgentTemplateConfig[]): void {
  const targetDir = teamDirectory(dir, instanceId, teamId);
  mkdirSync(targetDir, { recursive: true });
  const filePath = path.join(targetDir, 'templates.json');
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  writeFileSync(
    temporaryPath,
    JSON.stringify({ schema_version: 2, templates } satisfies AgentTemplateCollection, null, 2),
    'utf8',
  );
  renameSync(temporaryPath, filePath);
}

export function createAgentTemplate(
  dir: string,
  instanceId: string,
  teamId: string,
  input: AgentTemplateInput,
  actorUserId: string,
): AgentTemplateConfig {
  const templates = listAgentTemplates(dir, instanceId, teamId);
  const now = new Date().toISOString();
  const template: AgentTemplateConfig = {
    ...input,
    template_id: `tpl-${randomUUID()}`,
    created_by: actorUserId,
    updated_by: actorUserId,
    created_at: now,
    updated_at: now,
  };
  saveCollection(dir, instanceId, teamId, [...templates, template]);
  return template;
}

export function updateAgentTemplate(
  dir: string,
  instanceId: string,
  teamId: string,
  templateId: string,
  input: AgentTemplateInput,
  actorUserId: string,
): AgentTemplateConfig | null {
  const templates = listAgentTemplates(dir, instanceId, teamId);
  const index = templates.findIndex((template) => template.template_id === templateId);
  if (index < 0) return null;
  const existing = templates[index]!;
  const updated: AgentTemplateConfig = {
    ...existing,
    ...input,
    template_id: templateId,
    created_at: existing.created_at,
    updated_by: actorUserId,
    updated_at: new Date().toISOString(),
  };
  templates[index] = updated;
  saveCollection(dir, instanceId, teamId, templates);
  return updated;
}

export function deleteAgentTemplate(dir: string, instanceId: string, teamId: string, templateId: string): boolean {
  const templates = listAgentTemplates(dir, instanceId, teamId);
  const remaining = templates.filter((template) => template.template_id !== templateId);
  if (remaining.length === templates.length) return false;
  saveCollection(dir, instanceId, teamId, remaining);
  return true;
}

export function getAgentTemplate(
  dir: string,
  instanceId: string,
  teamId: string,
  templateId: string,
): AgentTemplateConfig | null {
  return listAgentTemplates(dir, instanceId, teamId).find((template) => template.template_id === templateId) ?? null;
}

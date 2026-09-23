import type { AgentTemplateConfig } from '../../../state/agent-template-store.js';

export function isSkillLocked(metadataJson: string | undefined): boolean {
  if (!metadataJson) return false;
  try {
    return (JSON.parse(metadataJson) as { skill_lock?: { locked?: unknown } }).skill_lock?.locked === true;
  } catch {
    return false;
  }
}

export function templatesUsingSkill(templates: AgentTemplateConfig[], skillId: string): AgentTemplateConfig[] {
  return templates.filter((template) => template.asset_ids?.skills?.includes(skillId));
}

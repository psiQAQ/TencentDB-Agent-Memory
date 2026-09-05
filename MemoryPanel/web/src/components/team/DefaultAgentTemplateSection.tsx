/** Team 默认 Agent 模板集合；当前 Team 的所有 active member 都可共同维护和选用。 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from 'tea-component';
import { AddIcon, DeleteIcon, EditIcon } from 'tea-icons-react';
import { agentsApi, type AgentTemplateConfig } from '@/lib/teamApi';
import { invalidateBackendCache } from '@/services';
import { tea } from '@/lib/tea-bridge';
import { getErrorMessage } from '@/lib/error-message';
import DefaultAgentTemplateDialog from './DefaultAgentTemplateDialog';

export default function DefaultAgentTemplateSection({
  teamId,
  teamName,
}: {
  teamId: string;
  teamName: string;
}) {
  const { t } = useTranslation();
  const [templates, setTemplates] = useState<AgentTemplateConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<AgentTemplateConfig | null | undefined>(undefined);
  const [busyTemplateId, setBusyTemplateId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!teamId) return;
    setLoading(true);
    try {
      setTemplates(await agentsApi.listDefaultTemplates(teamId));
    } catch (err) {
      tea.notify.error(getErrorMessage(err));
      setTemplates([]);
    } finally {
      setLoading(false);
    }
  }, [teamId]);

  useEffect(() => {
    void load();
  }, [load]);

  function handleSaved(saved: AgentTemplateConfig) {
    setTemplates((current) => {
      const exists = current.some((template) => template.template_id === saved.template_id);
      return exists
        ? current.map((template) => (template.template_id === saved.template_id ? saved : template))
        : [...current, saved];
    });
    setEditing(undefined);
    tea.notify.success(t('defaultAgent.notify.saved'));
  }

  async function handleDelete(template: AgentTemplateConfig) {
    const ok = await tea.confirm({
      message: t('defaultAgent.delete.confirm', { name: template.name }),
      description: t('defaultAgent.delete.desc'),
      okText: t('defaultAgent.delete.action'),
    });
    if (!ok) return;
    setBusyTemplateId(template.template_id);
    try {
      await agentsApi.deleteDefaultTemplate(teamId, template.template_id);
      setTemplates((current) =>
        current.filter((item) => item.template_id !== template.template_id),
      );
      tea.notify.success(t('defaultAgent.delete.success', { name: template.name }));
    } catch (err) {
      tea.notify.error(getErrorMessage(err));
    } finally {
      setBusyTemplateId(null);
    }
  }

  async function handleProvision(template: AgentTemplateConfig) {
    const ok = await tea.confirm({
      message: t('agentGrid.defaultCreate.confirm'),
      description: t('agentGrid.defaultCreate.descTemplate', {
        name: template.name,
        skills: template.asset_ids?.skills?.length ?? 0,
        codeGraphs: template.asset_ids?.code_graphs?.length ?? 0,
        wikis: template.asset_ids?.wikis?.length ?? 0,
      }),
      okText: t('agentGrid.defaultCreate.action'),
    });
    if (!ok) return;
    setBusyTemplateId(template.template_id);
    try {
      const result = await agentsApi.createDefault(teamId, template.template_id);
      invalidateBackendCache();
      if (result.failed_assets.length > 0) {
        tea.notify.warning(
          t('agentGrid.defaultCreate.partial', { count: result.failed_assets.length }),
        );
      } else {
        tea.notify.success(t('agentGrid.defaultCreate.success', { name: result.agent_name }));
      }
    } catch (err) {
      tea.notify.error(getErrorMessage(err));
    } finally {
      setBusyTemplateId(null);
    }
  }

  return (
    <div className="_memory-panel-card _memory-default-agent-section">
      <div className="_memory-default-agent-head">
        <div className="_memory-default-agent-info">
          <div className="_memory-default-agent-title">{t('defaultAgent.title')}</div>
          <div className="_memory-default-agent-desc">{t('defaultAgent.desc')}</div>
        </div>
        <div className="_memory-default-agent-actions">
          <Button type="primary" onClick={() => setEditing(null)}>
            <AddIcon size={14} /> {t('defaultAgent.create')}
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="_memory-default-agent-body">
          <span className="_memory-default-agent-placeholder">{t('team.loading')}</span>
        </div>
      ) : templates.length === 0 ? (
        <div className="_memory-default-agent-body">
          <span className="_memory-default-agent-placeholder">{t('defaultAgent.empty')}</span>
        </div>
      ) : (
        <div className="_memory-default-agent-list">
          {templates.map((template) => (
            <div className="_memory-default-agent-item" key={template.template_id}>
              <div className="_memory-default-agent-info">
                <div className="_memory-default-agent-name" title={template.name}>
                  {template.name}
                </div>
                <div className="_memory-default-agent-detail">
                  {template.description || t('common.noDescription')}
                </div>
                <div className="_memory-default-agent-detail">
                  {t('defaultAgent.assets.summary', {
                    skills: template.asset_ids?.skills?.length ?? 0,
                    codeGraphs: template.asset_ids?.code_graphs?.length ?? 0,
                    wikis: template.asset_ids?.wikis?.length ?? 0,
                  })}
                </div>
              </div>
              <div className="_memory-default-agent-item-actions">
                <Button
                  disabled={busyTemplateId !== null}
                  loading={busyTemplateId === template.template_id}
                  onClick={() => void handleProvision(template)}
                >
                  {t('defaultAgent.use')}
                </Button>
                <Button disabled={busyTemplateId !== null} onClick={() => setEditing(template)}>
                  <EditIcon size={14} /> {t('defaultAgent.edit')}
                </Button>
                <Button
                  disabled={busyTemplateId !== null}
                  onClick={() => void handleDelete(template)}
                >
                  <DeleteIcon size={14} /> {t('common.delete')}
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {editing !== undefined && (
        <DefaultAgentTemplateDialog
          team={{ team_id: teamId, name: teamName }}
          initial={editing}
          onClose={() => setEditing(undefined)}
          onSaved={handleSaved}
        />
      )}
    </div>
  );
}

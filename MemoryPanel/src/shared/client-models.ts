/** Public client configuration metadata. Never include provider credentials or connection references. */
export interface ClientModel {
  agent_source: string;
  display_name: string;
  protocol: string;
  model_id: string | null;
  credential_kind: 'api_key' | 'chatgpt_oauth';
  status: 'ready' | 'unassigned' | 'disabled' | 'default_missing' | 'model_missing' | 'unsupported' | 'client_credentials';
}

export interface ConversationModelMetadata {
  model_id?: string | null;
  model_ids?: Record<string, string | null>;
  official_agents?: string[];
  clients?: Array<{
    agent_source: string; display_name: string; protocol: string;
    assignment: { enabled: boolean; mode: string; model_id?: string; credential_kind?: string } | null;
  }>;
}

export function resolveClientModels(data: ConversationModelMetadata, deploymentModel?: string): ClientModel[] | undefined {
  return data.clients?.map(({ agent_source, display_name, protocol, assignment }) => {
    const credential_kind = assignment?.credential_kind === 'chatgpt_oauth' ? 'chatgpt_oauth' : 'api_key';
    const model_id = (assignment?.mode === 'official' ? deploymentModel : assignment?.model_id)?.trim() || null;
    const status: ClientModel['status'] = !assignment ? 'unassigned'
      : !assignment.enabled ? 'disabled'
      : assignment.mode === 'official' && !model_id ? 'default_missing'
      : !model_id ? 'model_missing'
      : credential_kind === 'chatgpt_oauth' && !['codex', 'pi', 'opencode'].includes(agent_source) ? 'unsupported'
      : assignment.mode === 'custom_passthrough' ? 'client_credentials' : 'ready';
    return { agent_source, display_name, protocol, model_id, credential_kind, status };
  });
}

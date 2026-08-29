import { getPanelSession } from '../panelSession';
import { ApiError, request } from './base';
import type { MetaEnvelope } from './types';

export type TeamAtlasNodeType =
  | 'identity'
  | 'team'
  | 'task'
  | 'agent'
  | 'skill'
  | 'llm_wiki'
  | 'code_graph'
  | 'chat_memory';

export type TeamAtlasRelation = 'member_of' | 'contains' | 'assigned_to' | 'owns' | 'fixed_binding';

export interface TeamAtlasNode {
  id: string;
  entity_id: string;
  type: TeamAtlasNodeType;
  label: string;
  team_id?: string;
  status?: string;
  metadata?: Record<string, string | number | boolean | null>;
}

export interface TeamAtlasEdge {
  id: string;
  type: TeamAtlasRelation;
  source: string;
  target: string;
  team_id?: string;
}

export interface TeamAtlasWarning {
  code: string;
  node_id?: string;
  source?: string;
  message: string;
}

export interface TeamAtlasIR {
  schema_version: 1;
  generated_at: string;
  scope: { user_id: string; team_ids: string[] };
  completeness: 'complete' | 'partial';
  summary: { teams: number; tasks: number; agents: number; assets: number; edges: number; warnings: number };
  nodes: TeamAtlasNode[];
  edges: TeamAtlasEdge[];
  warnings: TeamAtlasWarning[];
}

export interface ChatMemoryStatus {
  block_id: string;
  checked_at: string;
  availability: 'complete' | 'partial' | 'unavailable' | 'not_applicable';
  layer_counts: { L0_messages: number | null; L1: number | null; L2: number | null; L3: number | null };
  unavailable_layers: string[];
}

async function atlasCall<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const session = getPanelSession();
  if (!session) throw new ApiError(401, 'Unauthorized', 'no active panel session');
  const envelope = await request<MetaEnvelope<T>>('POST', `/api/v1/${path}`, body, {
    'X-Tdai-Service-Id': session.instanceId,
    'X-Tdai-User-Key': session.userKey,
  });
  if (envelope.code !== 0 || envelope.data == null) {
    throw new ApiError(200, envelope.message, '', {
      code: envelope.code,
      requestId: envelope.request_id,
      rawMessage: envelope.message,
    });
  }
  return envelope.data;
}

export const teamAtlasApi = {
  bootstrap: (teamIds?: string[]) => atlasCall<TeamAtlasIR>('topology/bootstrap', teamIds?.length ? { team_ids: teamIds } : {}),
  memoryStatus: (blockId: string) => atlasCall<ChatMemoryStatus>('chat-memory/status', { block_id: blockId }),
};

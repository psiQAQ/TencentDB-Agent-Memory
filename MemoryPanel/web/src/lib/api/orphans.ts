import { ApiError, request } from './base';
import { getPanelSession } from '../panelSession';
import type { MetaEnvelope } from './types';

export interface OrphanFinding {
  finding_id: string;
  fingerprint: string;
  category:
    | 'recoverable_dependency'
    | 'operational_orphan'
    | 'cache_residue'
    | 'inconsistent'
    | 'retained_history';
  source_service: string;
  resource_type: string;
  resource_id: string;
  team_id: string | null;
  owner_user_id: string | null;
  reason: string;
  allowed_actions: Array<'inspect' | 'purge'>;
  first_seen_at: string;
  last_seen_at: string;
  name?: string;
  status?: string;
  item_count?: number;
  size_bytes?: number;
}

export interface OrphanScan {
  scan_revision: string;
  findings: OrphanFinding[];
  counts: Record<string, number>;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const session = getPanelSession();
  if (!session) throw new ApiError(401, 'Unauthorized', 'no active panel session');
  const env = await request<MetaEnvelope<T>>('POST', `/api/v1/admin/orphans/${path}`, body, {
    'X-Tdai-Service-Id': session.instanceId,
    'X-Tdai-User-Key': session.userKey,
  });
  if (env.code !== 0 || !env.data)
    throw new ApiError(env.code, env.message, '', { data: env.data });
  return env.data;
}

export const orphansApi = {
  scan: () => post<OrphanScan>('scan/start', {}),
  purge: (findings: Array<Pick<OrphanFinding, 'finding_id' | 'fingerprint'>>, reason: string) =>
    post<{ deleted: string[]; failed: Array<{ finding_id: string; reason: string }> }>('purge', {
      findings,
      reason,
      confirmation: 'PURGE_ZOMBIES',
    }),
};

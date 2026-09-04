/** Agent 显式创建、可恢复归档等 Panel 生命周期入口。 */
import type { Hono } from 'hono';
import type { PanelDeps } from '../../panel-deps.js';
import { validatePanelMetaHeaders } from '../middleware/validate-panel-headers.js';
import { respondControlError, respondEnvelope } from '../envelope.js';
import {
  buildCtx,
  okEnvelope,
  readJson,
  resolveCallerUserId,
  str,
} from './knowledge/common.js';
import { provisionDefaultAgentForCaller } from './meta/proxy.js';

interface AgentRaw {
  agent_id: string;
  owner_user_id: string;
}

export function registerAgentLifecycleRoutes(api: Hono, deps: PanelDeps): void {
  const mw = validatePanelMetaHeaders(deps);

  api.post('/agent/create-default', mw, async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const teamId = str(body, 'team_id');
    if (!teamId) return respondControlError(c, 400, 'MISSING_TEAM_ID');
    const callerId = await resolveCallerUserId(deps, ctx);
    if (!callerId) return respondControlError(c, 401, 'INVALID_USER_KEY');
    const memberEnv = await deps.metaKernel.invoke(
      'team-member/get',
      { team_id: teamId, user_id: callerId },
      ctx,
    );
    if (memberEnv.code !== 0) return respondEnvelope(c, memberEnv);
    try {
      const result = await provisionDefaultAgentForCaller(callerId, teamId, ctx, deps);
      return respondEnvelope(c, okEnvelope(c, result));
    } catch (err) {
      deps.logger.warn('explicit default agent provisioning failed', {
        instanceId: ctx.instanceId,
        teamId,
        userId: callerId,
        error: err instanceof Error ? err.message : String(err),
      });
      return respondControlError(c, 502, err instanceof Error ? err.message : 'DEFAULT_AGENT_CREATE_FAILED');
    }
  });

  for (const path of ['/agent/archive', '/agent/delete-cascade']) {
    api.post(path, mw, async (c) => {
      const ctx = buildCtx(c);
      const body = await readJson(c);
      const agentId = str(body, 'agent_id');
      if (!agentId) return respondControlError(c, 400, 'MISSING_AGENT_ID');

      const callerId = await resolveCallerUserId(deps, ctx);
      if (!callerId) return respondControlError(c, 401, 'INVALID_USER_KEY');
      const agentEnv = await deps.metaKernel.invoke('agent/get', { agent_id: agentId }, ctx);
      if (agentEnv.code === 404 || (agentEnv.code === 0 && !agentEnv.data)) {
        return respondControlError(c, 404, 'AGENT_NOT_FOUND');
      }
      if (agentEnv.code !== 0) return respondEnvelope(c, agentEnv);
      const agent = agentEnv.data as AgentRaw;
      if (agent.owner_user_id !== callerId) return respondControlError(c, 403, 'NOT_YOUR_AGENT');

      const archiveEnv = await deps.metaKernel.invoke('agent/archive', { agent_id: agentId }, ctx);
      if (archiveEnv.code !== 0) return respondEnvelope(c, archiveEnv);
      return respondEnvelope(c, okEnvelope(c, {
        archived: true,
        agent_id: agentId,
        assets_preserved: true,
      }));
    });
  }
}

import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../config.js';
import { buildSessionTurnContext, submitSessionTurn } from '../session-trace/index.js';
import { buildTurnBody, isTurnEnd } from '../session-trace/record.js';
import { sessionUploadQueue } from '../session-trace/upload-queue.js';
import { ResponsesAssembler } from '../session-trace/assemble.js';

afterEach(() => vi.restoreAllMocks());
describe('merged session trace behavior', () => {
  it('keeps user and tool messages while excluding system and developer context', () => {
    const messages = [
      { role: 'system', content: 'private system' }, { role: 'developer', content: 'private injected context' },
      { role: 'user', content: 'question' }, { role: 'tool', content: 'tool result', tool_call_id: 'call-1' },
    ];
    const body = buildTurnBody({ startedAt: '2026-10-13T00:00:00.000Z', endedAt: '2026-10-13T00:00:01.000Z',
      userQuery: 'question', model: 'synthetic', messages,
      reply: { output: { content: 'answer' }, stopReason: 'stop', toolCallCount: 0 } });
    expect(body?.messages).toEqual(messages.slice(2));
    expect(JSON.stringify(body)).not.toContain('private');
    expect(messages).toHaveLength(4);
  });
  it('records only completed text turns using the authenticated identity', () => {
    const enqueue = vi.spyOn(sessionUploadQueue, 'submit').mockResolvedValue('ok');
    const config = structuredClone(DEFAULT_CONFIG);
    const context = buildSessionTurnContext(config, {
      protocol: 'openai', startedAt: '2026-10-13T00:00:00.000Z', userQuery: 'question', mainSessionId: 'session-1', subagent: null,
    }, { spaceId: 'tenant-1', authUserId: 'user-1', sessionInfo: { team_id: 'team-1', user_id: 'user-1' },
      upstreamBody: { messages: [{ role: 'user', content: 'question' }] } });
    submitSessionTurn(context, { output: {}, stopReason: null, toolCallCount: 0 }, 'synthetic');
    submitSessionTurn(context, { output: {}, stopReason: 'tool_calls', toolCallCount: 1 }, 'synthetic');
    expect(enqueue).not.toHaveBeenCalled();
    submitSessionTurn(context, { output: { content: 'answer' }, stopReason: 'stop', toolCallCount: 0 }, 'synthetic');
    expect(enqueue).toHaveBeenCalledOnce();
    expect(enqueue.mock.calls[0][1]).toEqual({ serviceId: 'tenant-1', userId: 'user-1', sessionId: 'session-1', teamId: 'team-1' });
  });
  it('does not treat failed or interrupted Responses streams as complete turns', () => {
    const assembler = new ResponsesAssembler();
    assembler.push({ type: 'response.output_text.delta', delta: 'partial' });
    expect(isTurnEnd('responses', assembler.result())).toBe(false);
    assembler.push({ type: 'response.failed', response: { status: 'failed', output: [] } });
    expect(isTurnEnd('responses', assembler.result())).toBe(false);
  });
});

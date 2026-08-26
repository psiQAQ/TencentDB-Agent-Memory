/**
 * Candidate SessionStore keys for bridge calls that only carry a bare
 * x-conversation-id and therefore cannot identify the originating client.
 */
export function buildBridgeSessionKeyCandidates(sessionId: string): string[] {
  if (sessionId.includes(":")) return [sessionId];
  return [
    sessionId,
    `codebuddy:${sessionId}`,
    `claude-code:${sessionId}`,
    `codex:${sessionId}`,
    `workbuddy:${sessionId}`,
    `dsh:${sessionId}`,
    `opencode:${sessionId}`,
    `hermes:${sessionId}`,
    `openclaw:${sessionId}`,
    `cursor:${sessionId}`,
  ];
}

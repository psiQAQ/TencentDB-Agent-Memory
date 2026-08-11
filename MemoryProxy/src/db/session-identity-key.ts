import type { SessionInitState } from "../session/types.js";

const VERSION_PREFIX = "v2:";

export interface PersistedSessionIdentity {
  spaceId: string;
  userId: string;
  agentSource: string;
  sessionId: string;
}

function tupleOf(identity: PersistedSessionIdentity): [string, string, string, string] {
  return [identity.spaceId, identity.userId, identity.agentSource, identity.sessionId];
}

export function persistedSessionIdentityKey(
  spaceId: string,
  userId: string,
  agentSource: string,
  sessionId: string,
): string {
  const payload = JSON.stringify([spaceId, userId, agentSource, sessionId]);
  return VERSION_PREFIX + Buffer.from(payload, "utf8").toString("base64url");
}

export function parsePersistedSessionIdentityKey(
  key: string,
): PersistedSessionIdentity | null {
  if (!key.startsWith(VERSION_PREFIX)) return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(key.slice(VERSION_PREFIX.length), "base64url").toString("utf8"),
    ) as unknown;
    if (
      !Array.isArray(parsed)
      || parsed.length !== 4
      || parsed.some((value) => typeof value !== "string")
    ) return null;
    const [spaceId, userId, agentSource, sessionId] = parsed as string[];
    const identity = { spaceId, userId, agentSource, sessionId };
    return persistedSessionIdentityKey(...tupleOf(identity)) === key ? identity : null;
  } catch {
    return null;
  }
}

/**
 * Return the pre-v2 key only when its delimiter and `_default` sentinel are
 * unambiguous for this authenticated identity. Never use this for new writes.
 */
export function legacyPersistedSessionIdentityKey(
  spaceId: string,
  userId: string,
  agentSource: string,
  sessionId: string,
): string | null {
  if (spaceId === "_default") return null;
  if ([spaceId, userId, agentSource, sessionId].some((value) => value.includes(":"))) {
    return null;
  }
  return `${spaceId || "_default"}:${userId}:${agentSource}:${sessionId}`;
}

/** Require legacy state itself to prove the authenticated owner and tuple. */
export function persistedStateOwnsIdentity(
  state: SessionInitState,
  identity: PersistedSessionIdentity,
  requireExplicitSpace = false,
): boolean {
  const owners = [state.userId, state.sessionInfo?.user_id].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  if (owners.length === 0 || owners.some((owner) => owner !== identity.userId)) return false;

  const sessions = [state.keyId, state.sessionInfo?.session_id].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  if (sessions.length === 0 || sessions.some((session) => session !== identity.sessionId)) {
    return false;
  }

  const storedSpace = state.sessionInfo?.space_id;
  if (requireExplicitSpace) return storedSpace === identity.spaceId;
  return storedSpace === undefined || storedSpace === identity.spaceId;
}

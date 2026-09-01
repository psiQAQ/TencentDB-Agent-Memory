import type { SessionInitState } from "./types.js";

/** Remove a legacy raw user credential before state reaches L1 or persistence. */
export function withoutPersistedCredential(state: SessionInitState): SessionInitState {
  const sessionInfo = state.sessionInfo;
  if (!sessionInfo || !("user_key" in sessionInfo)) return state;
  const { user_key: _credential, ...safeSessionInfo } = sessionInfo;
  return { ...state, sessionInfo: safeSessionInfo };
}

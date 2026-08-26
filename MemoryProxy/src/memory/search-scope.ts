/**
 * Resolve the task filter for a memory search target.
 *
 * A caller's current task only scopes its own Agent memory. Borrowed Chat
 * Memory belongs to another Agent and may have been written under a different
 * task, so applying the caller task to an imported target makes every valid
 * shared-memory hit disappear. An explicit task remains supported for callers
 * that intentionally want to narrow an imported Agent's history.
 */
export function taskIdForSearchTarget(
  isSelf: boolean,
  explicitTaskId?: string,
  callerTaskId?: string,
): string | undefined {
  return explicitTaskId ?? (isSelf ? callerTaskId : undefined);
}

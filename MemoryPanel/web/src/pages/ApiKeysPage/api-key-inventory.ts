import type { UserKey } from '@/lib/api/users';

export interface ApiKeyInventoryUser {
  user_id: string;
  username: string;
  display_name?: string;
}

export interface ApiKeyInventoryTeam {
  team_id: string;
  name: string;
}

export interface ApiKeySubject {
  userId: string;
  username: string;
  displayName?: string;
  teams: ApiKeyInventoryTeam[];
}

export interface ManagedUserKey extends UserKey {
  ownerUserId: string;
  ownerName: string;
  teamNames: string[];
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await mapper(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * system_admin 的管理范围是“所有 Team 的全部成员”，同时保留其自己的 Key 入口，
 * 即使 system_admin 本身尚未加入任何 Team。
 */
export function buildApiKeySubjects(
  users: ApiKeyInventoryUser[],
  teamsByUser: Map<string, ApiKeyInventoryTeam[]>,
  currentUserId: string,
): ApiKeySubject[] {
  return users
    .map((user) => ({
      userId: user.user_id,
      username: user.username,
      displayName: user.display_name,
      teams: teamsByUser.get(user.user_id) ?? [],
    }))
    .filter((subject) => subject.teams.length > 0 || subject.userId === currentUserId)
    .sort((a, b) => {
      if (a.userId === currentUserId) return -1;
      if (b.userId === currentUserId) return 1;
      return (a.displayName || a.username).localeCompare(b.displayName || b.username);
    });
}

/** 将逐用户 Key 查询结果合并成表格行，并保持既有“隐藏已吊销 Key”的行为。 */
export function buildManagedUserKeys(
  subjects: ApiKeySubject[],
  keysByUser: Map<string, UserKey[]>,
): ManagedUserKey[] {
  return subjects
    .flatMap((subject) =>
      (keysByUser.get(subject.userId) ?? [])
        .filter((key) => !key.revoked_at)
        .map((key) => ({
          ...key,
          ownerUserId: subject.userId,
          ownerName: subject.displayName || subject.username,
          teamNames: subject.teams.map((team) => team.name),
        })),
    )
    .sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''));
}

export async function loadSystemAdminApiKeyInventory(
  currentUserId: string,
  api: {
    listUsers: () => Promise<ApiKeyInventoryUser[]>;
    listTeamsForUser: (userId: string) => Promise<ApiKeyInventoryTeam[]>;
    listKeysForUser: (userId: string) => Promise<UserKey[]>;
  },
): Promise<{ subjects: ApiKeySubject[]; keys: ManagedUserKey[] }> {
  const users = await api.listUsers();
  const teamEntries = await mapWithConcurrency(
    users,
    8,
    async (user) => [user.user_id, await api.listTeamsForUser(user.user_id)] as const,
  );
  const subjects = buildApiKeySubjects(users, new Map(teamEntries), currentUserId);
  const keyEntries = await mapWithConcurrency(
    subjects,
    8,
    async (subject) => [subject.userId, await api.listKeysForUser(subject.userId)] as const,
  );
  return {
    subjects,
    keys: buildManagedUserKeys(subjects, new Map(keyEntries)),
  };
}

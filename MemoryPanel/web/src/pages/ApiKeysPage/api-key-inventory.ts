import type { UserKey } from '@/lib/api/users';

export type ApiKeyTeamRole = 'owner' | 'admin' | 'member' | 'reviewer';

export interface ApiKeyInventoryUser {
  user_id: string;
  username: string;
  display_name?: string;
  user_type?: string;
}

export interface ApiKeyInventoryTeam {
  team_id: string;
  name: string;
  owner_user_id?: string;
}

export interface ApiKeyInventoryMember {
  user_id: string;
  role: Exclude<ApiKeyTeamRole, 'owner'>;
}

export interface ApiKeyTeamMembership {
  teamId: string;
  teamName: string;
  roles: ApiKeyTeamRole[];
}

export interface ApiKeySubject {
  userId: string;
  username: string;
  displayName?: string;
  userType?: string;
  teams: ApiKeyTeamMembership[];
}

export interface ManagedUserKey extends UserKey {
  ownerUserId: string;
  ownerName: string;
  ownerUserType?: string;
  teamMemberships: ApiKeyTeamMembership[];
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

function toMembership(
  userId: string,
  team: ApiKeyInventoryTeam,
  members: ApiKeyInventoryMember[],
): ApiKeyTeamMembership {
  const roles: ApiKeyTeamRole[] = [];
  if (team.owner_user_id === userId) roles.push('owner');
  const memberRole = members.find((member) => member.user_id === userId)?.role;
  if (memberRole) roles.push(memberRole);
  return {
    teamId: team.team_id,
    teamName: team.name,
    roles: [...new Set(roles)],
  };
}

/**
 * system_admin 的管理范围是实例内全部账号（含 Teamless normal）及其 Key；
 * Team 信息只作为组织上下文展示。
 */
export function buildApiKeySubjects(
  users: ApiKeyInventoryUser[],
  teamsByUser: Map<string, ApiKeyInventoryTeam[]>,
  membersByTeam: Map<string, ApiKeyInventoryMember[]>,
  currentUserId: string,
): ApiKeySubject[] {
  return users
    .map((user) => ({
      userId: user.user_id,
      username: user.username,
      displayName: user.display_name,
      userType: user.user_type,
      teams: (teamsByUser.get(user.user_id) ?? []).map((team) =>
        toMembership(user.user_id, team, membersByTeam.get(team.team_id) ?? []),
      ),
    }))
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
          ownerUserType: subject.userType,
          teamMemberships: subject.teams,
        })),
    )
    .sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''));
}

export function filterApiKeySubjects(
  subjects: ApiKeySubject[],
  teamId: string,
  memberKeyword: string,
): ApiKeySubject[] {
  const keyword = memberKeyword.trim().toLocaleLowerCase();
  return subjects.filter((subject) => {
    if (teamId !== '*' && !subject.teams.some((team) => team.teamId === teamId)) return false;
    if (!keyword) return true;
    return [subject.userId, subject.username, subject.displayName]
      .filter(Boolean)
      .some((value) => value!.toLocaleLowerCase().includes(keyword));
  });
}

export function filterManagedUserKeys(
  keys: ManagedUserKey[],
  subjects: ApiKeySubject[],
): ManagedUserKey[] {
  const userIds = new Set(subjects.map((subject) => subject.userId));
  return keys.filter((key) => userIds.has(key.ownerUserId));
}

export type KeyRevokeBlockReason = 'bootstrap_admin_key' | 'last_active_key' | null;

export interface KeyRevokeContext {
  callerUserId?: string;
  callerIsSystemAdmin: boolean;
}

/** 镜像 Core：只保护部署 bootstrap Key；system_admin 可吊销其他 Key。 */
export function getKeyRevokeBlockReason(
  key: ManagedUserKey,
  activeKeys: ManagedUserKey[],
  context: KeyRevokeContext = { callerIsSystemAdmin: false },
): KeyRevokeBlockReason {
  if (key.ownerUserType === 'system_admin') {
    return key.is_default ? 'bootstrap_admin_key' : null;
  }
  const ownerActiveKeyCount = activeKeys.filter(
    (candidate) => candidate.ownerUserId === key.ownerUserId && !candidate.revoked_at,
  ).length;
  const systemAdminManagingAnotherUser =
    context.callerIsSystemAdmin && context.callerUserId !== key.ownerUserId;
  return ownerActiveKeyCount <= 1 && !systemAdminManagingAnotherUser ? 'last_active_key' : null;
}

export function getPrivilegedMemberships(key: ManagedUserKey): ApiKeyTeamMembership[] {
  return key.teamMemberships.filter((team) =>
    team.roles.some((role) => role === 'owner' || role === 'admin'),
  );
}

export async function loadSystemAdminApiKeyInventory<TUser extends ApiKeyInventoryUser>(
  currentUserId: string,
  api: {
    listUsers: () => Promise<TUser[]>;
    listTeamsForUser: (userId: string) => Promise<ApiKeyInventoryTeam[]>;
    listMembersForTeam: (teamId: string) => Promise<ApiKeyInventoryMember[]>;
    listKeysForUser: (userId: string) => Promise<UserKey[]>;
  },
): Promise<{ users: TUser[]; subjects: ApiKeySubject[]; keys: ManagedUserKey[] }> {
  const users = await api.listUsers();
  const teamEntries = await mapWithConcurrency(
    users,
    8,
    async (user) => [user.user_id, await api.listTeamsForUser(user.user_id)] as const,
  );
  const uniqueTeams = [
    ...new Map(
      teamEntries.flatMap(([, teams]) => teams).map((team) => [team.team_id, team]),
    ).values(),
  ];
  const memberEntries = await mapWithConcurrency(
    uniqueTeams,
    8,
    async (team) => [team.team_id, await api.listMembersForTeam(team.team_id)] as const,
  );
  const subjects = buildApiKeySubjects(
    users,
    new Map(teamEntries),
    new Map(memberEntries),
    currentUserId,
  );
  const keyEntries = await mapWithConcurrency(
    subjects,
    8,
    async (subject) => [subject.userId, await api.listKeysForUser(subject.userId)] as const,
  );
  return {
    users,
    subjects,
    keys: buildManagedUserKeys(subjects, new Map(keyEntries)),
  };
}

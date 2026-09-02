/** 无 React/路径别名依赖的 Team 角色纯函数，供 UI 与单元测试共用。 */
export type TeamRole = 'admin' | 'member' | 'reviewer';

export interface TeamRoleView {
  owner_user_id: string;
  members: Array<{ user_id: string; role: TeamRole }>;
}

export function roleInTeam(team: TeamRoleView | null | undefined, userId: string): TeamRole | null {
  if (!team) return null;
  const member = team.members.find((item) => item.user_id === userId);
  if (member) return member.role;
  return team.owner_user_id === userId ? 'admin' : null;
}

export function isTeamAdmin(team: TeamRoleView | null | undefined, userId: string): boolean {
  if (!team) return false;
  return team.owner_user_id === userId
    || team.members.some((item) => item.user_id === userId && item.role === 'admin');
}

export function isTeamMember(team: TeamRoleView | null | undefined, userId: string): boolean {
  return roleInTeam(team, userId) !== null;
}

export function canRemoveMember(
  team: TeamRoleView,
  targetUserId: string,
  currentUserId: string,
): boolean {
  if (targetUserId === team.owner_user_id || targetUserId === currentUserId) return false;
  return isTeamAdmin(team, currentUserId);
}

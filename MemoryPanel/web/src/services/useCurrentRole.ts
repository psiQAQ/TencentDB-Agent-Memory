/**
 * useCurrentRole — 获取当前登录用户的角色
 *
 * 返回当前 active Team 的真实角色；null 表示未加入/未选择 Team。
 * 全局账号类型只能从 AuthState.user_type / isAdmin 读取，绝不折叠进 Team role。
 */
import { useMemo } from 'react';
import { useTeams, roleInTeam } from '@/services';
import { useAuthStore } from '@/stores/auth';

export type TeamRole = 'admin' | 'member' | 'reviewer';

export function useCurrentRole(): TeamRole | null {
  const { auth } = useAuthStore();
  const { activeTeam } = useTeams();
  return useMemo(() => {
    if (!auth) return null;
    return roleInTeam(activeTeam, auth.user_id);
  }, [activeTeam, auth]);
}

/**
 * useCurrentRole — 获取当前登录用户的角色
 *
 * 返回 'admin' | 'member' | 'reviewer' | null（null = 未登录）。
 *
 * 这是用于导航和角色标签的“有效角色”：全局 system_admin 与当前 Team 的 admin
 * 都会返回字符串 'admin'。因此调用方不得用 `role === 'admin'` 判断全局权限；
 * 全局权限唯一权威字段是 `AuthState.isAdmin`。
 *
 * 判断顺序仍为：先判 system_admin；否则返回 active Team 中的成员角色。
 */
import { useMemo } from 'react';
import { useTeams, roleInTeam, isGlobalAdmin } from '@/services';
import { useAuthStore } from '@/stores/auth';

export type TeamRole = 'admin' | 'member' | 'reviewer';

export function useCurrentRole(): TeamRole | null {
  const { auth } = useAuthStore();
  const { activeTeam } = useTeams();
  return useMemo(() => {
    if (!auth) return null;
    // 全局 admin：独立于 team，始终是 admin（不依赖 activeTeam / team.members 查询结果）
    // isAdmin 来自 auth/verify 的 user_type === 'system_admin'，是唯一权威字段。
    if (isGlobalAdmin(auth.user, auth.isAdmin)) return 'admin';
    // 非 system_admin：角色取决于其在当前 active team 里的成员记录，可能是 team admin。
    return roleInTeam(activeTeam, auth.user_id);
  }, [activeTeam, auth]);
}

/**
 * RouteGuards — 路由级权限守卫
 *
 * - SystemAdminGuard：只允许 system_admin 访问全局人员管理。
 */
import { type ReactNode, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useCurrentRole, type TeamRole } from '@/services/useCurrentRole';
import { useAuthStore } from '@/stores/auth';

/** 资源页面不按账号类型拦截；Core 会按当前 Team membership 做最终鉴权。 */
export function ResourceGuard({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

export function SystemAdminGuard({ children }: { children: ReactNode }) {
  const { auth } = useAuthStore();
  const navigate = useNavigate();
  const blocked = !!auth && !auth.isAdmin;

  useEffect(() => {
    if (blocked) navigate('/', { replace: true });
  }, [blocked, navigate]);

  return blocked ? null : <>{children}</>;
}

/** 成员管理守卫：reviewer 不可见；member 仅可查看，人员变更由 Team owner/admin 控制。 */
export function MemberManageGuard({ children, allowedRoles }: {
  children: ReactNode;
  allowedRoles?: TeamRole[];
}) {
  const role = useCurrentRole();
  const navigate = useNavigate();
  const allowed = allowedRoles ?? ['admin', 'member'];
  const blocked = role !== null && !allowed.includes(role);

  useEffect(() => {
    if (blocked) navigate('/', { replace: true });
  }, [blocked, navigate]);

  return blocked ? null : <>{children}</>;
}

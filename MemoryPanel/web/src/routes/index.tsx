/**
 * 路由表定义
 *
 * 使用 react-router 的 createBrowserRouter / RouterProvider。
 * ConsoleLayout 作为父路由，各页面作为子路由。
 */
import { createHashRouter, type RouteObject } from 'react-router-dom';
import { ConsoleLayout } from '@/layouts/ConsoleLayout';

export const routes: RouteObject[] = [
  {
    path: '/',
    element: <ConsoleLayout />,
    children: [
      {
        index: true,
        lazy: async () => ({ Component: (await import('@/pages/WorkbenchPage')).WorkbenchPage }),
      },
      {
        path: 'wiki',
        lazy: async () => ({ Component: (await import('@/pages/WikiPage')).WikiPage }),
      },
      {
        path: 'code',
        lazy: async () => ({ Component: (await import('@/pages/CodePage')).CodePage }),
      },
      {
        path: 'skills',
        lazy: async () => ({ Component: (await import('@/pages/SkillsPage')).SkillsPage }),
      },
      {
        path: 'memory',
        lazy: async () => ({ Component: (await import('@/pages/ChatMemoryPage')).ChatMemoryPage }),
      },
      {
        path: 'team/members',
        lazy: async () => ({ Component: (await import('@/pages/MembersPage')).MembersPage }),
      },
      {
        path: 'team/agents',
        lazy: async () => ({ Component: (await import('@/pages/AgentsPage')).AgentsPage }),
      },
      {
        path: 'team/api-keys',
        lazy: async () => ({ Component: (await import('@/pages/ApiKeysPage')).ApiKeysPage }),
      },
      {
        path: 'guide',
        lazy: async () => ({ Component: (await import('@/pages/GuidePage')).GuidePage }),
      },
    ],
  },
];

/**
 * 使用 HashRouter — 保持与旧版 hash 路由兼容，
 * 避免刷新 404（静态部署不需要服务端 fallback 配置）。
 */
export const router = createHashRouter(routes);

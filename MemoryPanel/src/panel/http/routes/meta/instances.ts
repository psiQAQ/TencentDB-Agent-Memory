import type { Hono } from 'hono';
import type { PanelDeps } from '../../../panel-deps.js';

export function registerHealthRoutes(app: Hono): void {
  app.get('/health', (c) => c.json({ status: 'ok' }));
}

export function registerMetaInstanceRoutes(api: Hono, deps: PanelDeps): void {
  api.get('/meta/instances', async (c) => {
    const instances = await Promise.all(deps.instanceRegistry.listPublic().map(async (entry) => {
      const privateEntry = deps.instanceRegistry.resolve(entry.instance_id);
      const { upstream_model: _configuredModel, ...publicEntry } = entry;
      try {
        const response = await fetch(`${privateEntry.gateway_endpoint.replace(/\/+$/, '')}/v3/internal/meta/instance-upstream/model`, {
          method: 'POST', signal: AbortSignal.timeout(3000),
          headers: { authorization: `Bearer ${privateEntry.api_key}`, 'x-tdai-service-id': entry.instance_id,
            'content-type': 'application/json' }, body: '{}',
        });
        if (!response.ok) return publicEntry;
        const json = await response.json() as { data?: { model_id?: string | null } };
        const model = json.data?.model_id;
        return model ? { ...publicEntry, upstream_model: model } : publicEntry;
      } catch { return publicEntry; }
    }));
    return c.json({
      instances,
      // 面板级能力开关随实例列表顺带下发（不新增接口）：
      // 「可观测」入口是否开放由部署方通过 PANEL_FEATURE_ANALYTICS_ENABLED 控制，
      // 默认关闭；开启后前端再结合 /api/v1/analytics/config 的 CH 探测结果
      // 决定菜单/路由是否最终可见。
      capabilities: { analyticsEnabled: deps.config.featureAnalyticsEnabled },
    });
  });
}

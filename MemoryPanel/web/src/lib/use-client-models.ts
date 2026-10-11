import { useCallback, useEffect, useRef, useState } from 'react';
import { metaInstancesApi, type MetadataInstance } from './api/meta-instances';
import { onModelConfigChanged } from './model-config-events';

export function useClientModels(instanceId?: string) {
  const [instance, setInstance] = useState<MetadataInstance>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const sequence = useRef(0);
  const reload = useCallback(async () => {
    const request = ++sequence.current;
    if (!instanceId) { setInstance(undefined); setLoading(false); return; }
    setLoading(true); setError('');
    try {
      const entry = (await metaInstancesApi.list(true)).find((item) => item.instance_id === instanceId);
      if (request !== sequence.current) return;
      setInstance(entry);
      if (!entry || entry.model_status === 'unavailable') setError('无法读取当前模型分配，请检查 Core 服务后刷新配置。');
    } catch {
      if (request === sequence.current) {
        setInstance(undefined); setError('加载接入配置失败，请重试。');
      }
    } finally { if (request === sequence.current) setLoading(false); }
  }, [instanceId]);
  useEffect(() => {
    void reload();
    const refresh = () => { void reload(); };
    const visible = () => { if (document.visibilityState === 'visible') refresh(); };
    const unsubscribe = onModelConfigChanged(instanceId ?? '', refresh);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', visible);
    return () => {
      ++sequence.current; unsubscribe();
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [instanceId, reload]);
  return { instance: instance?.instance_id === instanceId ? instance : undefined, loading, error, reload };
}

const MODEL_CONFIG_CHANGED = 'models:configuration-changed';

export function notifyModelConfigChanged(instanceId: string, target: EventTarget = window): void {
  target.dispatchEvent(new CustomEvent(MODEL_CONFIG_CHANGED, { detail: instanceId }));
}

export function onModelConfigChanged(instanceId: string, reload: () => void, target: EventTarget = window): () => void {
  const listener = (event: Event) => { if ((event as CustomEvent<string>).detail === instanceId) reload(); };
  target.addEventListener(MODEL_CONFIG_CHANGED, listener);
  return () => target.removeEventListener(MODEL_CONFIG_CHANGED, listener);
}

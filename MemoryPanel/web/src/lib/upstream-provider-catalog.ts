export type UpstreamProtocol = 'chat' | 'responses' | 'anthropic';
export type ProviderId = 'deepseek' | 'openai' | 'anthropic' | 'gemini' | 'local' | 'custom';
export const LOCAL_ENDPOINT_DESCRIPTION = 'panel:local-model-endpoint:v1';

export interface ProviderPreset {
  id: Exclude<ProviderId, 'local' | 'custom'>;
  name: string;
  baseUrls: readonly string[];
  models: readonly string[];
  protocols: readonly UpstreamProtocol[];
}

// Small built-in catalog, following Pi's provider/model picker. The custom entry
// keeps newer model IDs usable without waiting for a Panel release.
export const PROVIDERS: readonly ProviderPreset[] = [
  {
    id: 'deepseek', name: 'DeepSeek',
    baseUrls: ['https://api.deepseek.com', 'https://api.deepseek.com/v1'],
    models: ['deepseek-flash', 'deepseek-v4-pro'],
    protocols: ['chat', 'responses', 'anthropic'],
  },
  {
    id: 'openai', name: 'OpenAI',
    baseUrls: ['https://api.openai.com/v1'],
    models: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'],
    protocols: ['chat', 'responses'],
  },
  {
    id: 'anthropic', name: 'Anthropic',
    baseUrls: ['https://api.anthropic.com/v1'],
    models: ['claude-sonnet-5', 'claude-opus-5', 'claude-sonnet-4-6', 'claude-opus-4-8'],
    protocols: ['anthropic'],
  },
  {
    id: 'gemini', name: 'Google Gemini',
    baseUrls: ['https://generativelanguage.googleapis.com/v1beta/openai'],
    models: ['gemini-flash-latest', 'gemini-pro-latest'],
    protocols: ['chat'],
  },
];

export function providerForUrl(baseUrl: string): ProviderId {
  try {
    const url = new URL(baseUrl);
    const preset = PROVIDERS.find((entry) => entry.baseUrls.some((value) => new URL(value).origin === url.origin));
    if (preset) return preset.id;
    return url.protocol === 'http:' || !!url.port ? 'local' : 'custom';
  } catch { return 'custom'; }
}

export function sameUpstreamOrigin(left: string, right: string): boolean {
  try { return new URL(left).origin === new URL(right).origin; }
  catch { return false; }
}

export function validLocalEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    const ipv4 = /^\d+\.\d+\.\d+\.\d+$/.test(url.hostname);
    return (url.protocol === 'http:' || url.protocol === 'https:') &&
      (!!url.port || (!ipv4 && url.protocol === 'https:')) &&
      !url.username && !url.password && !url.search && !url.hash &&
      url.hostname !== 'localhost' && url.hostname !== '127.0.0.1';
  } catch { return false; }
}

import type { ModelDraft } from './upstream-settings-form';
import { supportsSubscriptionAgent } from './upstream-settings-form';

export function subscriptionUsable(agents: string[], protocols: string[], extraction: boolean): boolean {
  return extraction || (agents.every(supportsSubscriptionAgent) &&
    protocols.every((protocol) => protocol === 'openai-chat' || protocol === 'openai-responses'));
}

export interface CatalogModel {
  id: string;
  provider_id: string;
  name: string;
  context_window?: number;
  max_input_tokens?: number;
  max_output_tokens?: number;
  input_modalities?: string[];
  effort_levels?: string[];
  lifecycle?: string;
  reasoning?: boolean;
  reference_price?: { input?: number; output?: number };
  protocols: string[];
  sources: string[];
}
export interface Snapshot {
  models: CatalogModel[];
  revision: string;
  updated_at: string;
  error?: string;
}
export interface Catalog {
  public_catalog: Snapshot;
  connections: Array<{
    group_id?: string;
    reference?: string;
    base_url?: string;
    provider_id: string;
    credential_kind: 'api_key' | 'chatgpt_oauth';
    snapshot: Snapshot | null;
  }>;
  subscriptions: Array<{ reference: string; email?: string; status: string }>;
}

/** Saved account results apply only while the editor still uses that saved credential. */
export function accountSnapshot(catalog: Catalog | null, draft: ModelDraft): Snapshot | undefined {
  const connection = catalog?.connections.find((entry) => {
    if (entry.provider_id !== draft.provider || entry.credential_kind !== draft.credential_kind)
      return false;
    if (draft.credential_kind === 'chatgpt_oauth')
      return !!draft.credential_ref && entry.reference === draft.credential_ref;
    return (
      draft.mode === 'custom_unified' &&
      !draft.api_key &&
      !!draft.group_id &&
      entry.group_id === draft.group_id &&
      entry.base_url === draft.base_url
    );
  });
  return connection?.snapshot ?? undefined;
}

export function catalogChoices(
  publicModels: CatalogModel[],
  accountModels: CatalogModel[] | undefined,
  subscription: boolean,
): CatalogModel[] {
  const merged = new Map(publicModels.map((model) => [model.id, model]));
  for (const account of accountModels ?? []) {
    const entry = merged.get(account.id);
    merged.set(
      account.id,
      entry
        ? {
            ...entry,
            ...Object.fromEntries(
              Object.entries(account).filter(([, value]) => value !== undefined),
            ),
            name: account.name === account.id ? entry.name : account.name,
            protocols: subscription
              ? account.protocols
              : account.protocols.filter((protocol) => entry.protocols.includes(protocol)),
            sources: [...new Set([...account.sources, ...entry.sources])],
          }
        : account,
    );
  }
  return subscription
    ? (accountModels ?? []).map((model) => merged.get(model.id)!)
    : [...merged.values()];
}

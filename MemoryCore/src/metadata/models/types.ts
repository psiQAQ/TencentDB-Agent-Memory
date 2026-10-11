export type ProviderId =
  "deepseek" | "openai" | "anthropic" | "gemini" | "local" | "custom";
export type CredentialKind = "api_key" | "chatgpt_oauth";
export interface ModelAuthFields {
  provider_id?: ProviderId;
  credential_kind?: CredentialKind;
  credential_ref?: string;
}
/** Dedicated instance-local state, never exposed through config-param/list. */
export interface ModelState {
  key: string;
  value: string;
  version: number;
  updated_at: string;
}
export interface CatalogModel {
  id: string;
  provider_id: ProviderId;
  name: string;
  context_window?: number;
  max_input_tokens?: number;
  max_output_tokens?: number;
  reasoning?: boolean;
  input_modalities?: string[];
  output_modalities?: string[];
  effort_levels?: string[];
  capabilities?: Record<string, boolean>;
  system_prompt_update?: string;
  lifecycle?: string;
  reference_price?: {
    input?: number;
    output?: number;
    cache_read?: number;
    cache_write?: number;
  };
  protocols: string[];
  sources: string[];
}
export interface ModelSnapshot {
  revision: string;
  updated_at: string;
  models: CatalogModel[];
  error?: string;
  attempted_at?: string;
}
export class ModelConnectionError extends Error {
  constructor(
    readonly code: string,
    readonly status = 400,
  ) {
    super(code);
    this.name = "ModelConnectionError";
  }
}

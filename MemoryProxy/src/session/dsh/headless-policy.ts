import type { SessionInitConfig } from "../../types.js";

export interface DshHeadlessPolicy {
  /** The client cannot render the interactive ask_user_question form. */
  noInteractiveForm: boolean;
  /** No validated header-driven identity can be attempted, so memory must stay off. */
  bypassMemory: boolean;
  /** Complete raw team + agent headers are present and still require metadata validation. */
  hasCompleteHeaderIdentity: boolean;
}

function toolName(tool: unknown): string | undefined {
  const candidate = tool as { function?: { name?: string }; name?: string };
  return candidate?.function?.name ?? candidate?.name;
}

export function resolveDshHeadlessPolicy(
  agentSource: string,
  body: { tools?: unknown },
  config: SessionInitConfig,
  headers: Record<string, string>,
): DshHeadlessPolicy {
  const tools = body.tools;
  const noInteractiveForm = agentSource === "dsh"
    && Array.isArray(tools)
    && tools.length > 0
    && !tools.some((tool) => toolName(tool) === "ask_user_question");

  const headerConfig = config.headerAutoSelect;
  const hasCompleteHeaderIdentity = !!(
    noInteractiveForm
    && headerConfig?.enabled
    && headers[headerConfig.teamHeader]?.trim()
    && headers[headerConfig.agentHeader]?.trim()
  );

  return {
    noInteractiveForm,
    hasCompleteHeaderIdentity,
    bypassMemory: noInteractiveForm && !hasCompleteHeaderIdentity,
  };
}

/**
 * A no-form client must never fall back to an interactive form after a header
 * mismatch. The normal metadata validation still runs; only its failure mode
 * changes from `form` to the safe `bypass` terminal state.
 */
export function sessionInitConfigForDshHeadless(
  config: SessionInitConfig,
  policy: DshHeadlessPolicy,
): SessionInitConfig {
  if (!policy.noInteractiveForm || !policy.hasCompleteHeaderIdentity || !config.headerAutoSelect) {
    return config;
  }
  return {
    ...config,
    headerAutoSelect: {
      ...config.headerAutoSelect,
      onMismatch: "bypass",
    },
  };
}

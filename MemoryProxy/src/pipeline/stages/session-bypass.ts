/** Preserve bypass and reset state while omitting caller identity from diagnostics. */

export interface SessionBypassInput {
  bypassed: boolean;
  resetFlow: boolean;
  sessionKey: string;
  /** log 前缀 (如 "[codex]" / "[workbuddy]" / "[session-init]") */
  logPrefix: string;
  /** wb 独有: log 里追加的 " (reason=xxx)" 段 (其他 3 家传空字符串) */
  extraLog?: string;
  /** wb 独有: bypass reset 时 resetFlowResult 字段用 teamIdShort 而非 teamId */
  useTeamIdShort?: boolean;
}

export interface ResetFlowBypassResult {
  agentName: string;
  agentIdShort: string;
  teamId?: string;
  teamIdShort?: string;
  bypassed: boolean;
}

export interface SessionBypassResult {
  /** 是否 bypass 生效 (caller 用来 set 自己那个变量: injectedSkipped 或 injectionSkipped) */
  skipInjection: boolean;
  /** bypass reset-flow 时的 _resetFlowResult 内容 (为 undefined 时 caller 不动) */
  resetFlowResult?: ResetFlowBypassResult;
}

export function stageSessionBypass(input: SessionBypassInput): SessionBypassResult {
  if (!input.bypassed) {
    return { skipInjection: false };
  }

  console.log(
    "[session-init] session=<redacted> bypassed → skipping injection",
  );

  if (input.resetFlow) {
    const resetFlowResult: ResetFlowBypassResult = input.useTeamIdShort
      ? { agentName: "", agentIdShort: "", teamIdShort: "", bypassed: true }
      : { agentName: "", agentIdShort: "", teamId: "", bypassed: true };
    return { skipInjection: true, resetFlowResult };
  }

  return { skipInjection: true };
}

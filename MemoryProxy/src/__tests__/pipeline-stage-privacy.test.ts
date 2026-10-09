import { afterEach, describe, expect, it, vi } from "vitest";
const { prewarm, processBody } = vi.hoisted(() => ({ prewarm: vi.fn(), processBody: vi.fn() }));
vi.mock("../injection/index.js", () => ({ prewarmFromConfig: prewarm, getInjectionPipeline: () => ({ process: processBody }) }));
import { DEFAULT_CONFIG } from "../config.js";
import { stagePrewarmInjection } from "../pipeline/stages/prewarm-injection.js";
import { stageInjectionRunner } from "../pipeline/stages/injection-runner.js";
import { stageSessionBypass } from "../pipeline/stages/session-bypass.js";

const PRIVATE = "private-stage-credential-and-identity";
afterEach(() => { vi.restoreAllMocks(); prewarm.mockReset(); processBody.mockReset(); });
describe("pipeline stage private diagnostics", () => {
  it("keeps prewarm failures optional without logging error details or caller identity", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    prewarm.mockRejectedValue(new Error(PRIVATE));
    const config = structuredClone(DEFAULT_CONFIG);
    config.injection.enabled = true;
    await stagePrewarmInjection({ bypassed: false, justRegistered: true, sessionInfo: {},
      agentDetail: null, taskDetail: null, memCommandPending: false, config,
      sessionKey: PRIVATE, userId: PRIVATE, agentSource: "codex", callerUserKey: PRIVATE, logTag: PRIVATE });
    expect(prewarm).toHaveBeenCalledOnce();
    expect(warning).toHaveBeenCalledWith("[hook-cache] prewarm failed category=unexpected_error");
    expect(JSON.stringify(warning.mock.calls)).not.toContain(PRIVATE);
  });
  it("retains the original request after an optional injection failure without exposing error details", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    processBody.mockRejectedValue(new Error(PRIVATE));
    const config = structuredClone(DEFAULT_CONFIG);
    config.injection.enabled = true;
    const body = { model: "test-model", messages: [{ role: "user", content: PRIVATE }] };
    const result = await stageInjectionRunner({ skip: false, config, body, protocol: "openai", messages: body.messages,
      traceId: "test-trace", keyId: PRIVATE, modelId: "test-model", isStream: false, agentSource: "codex",
      userId: PRIVATE, sessionKey: PRIVATE, spaceId: "test", sessionInfo: null,
      requestPath: "/codex/test/v1/chat/completions" });
    expect(processBody).toHaveBeenCalledOnce();
    expect(result).toEqual({ body, messages: body.messages });
    expect(JSON.stringify(error.mock.calls)).not.toContain(PRIVATE);
  });
  it("keeps bypass and reset state behavior while removing session identifiers from logs", () => {
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(stageSessionBypass({ bypassed: true, resetFlow: true, sessionKey: PRIVATE,
      logPrefix: PRIVATE, extraLog: PRIVATE })).toEqual({ skipInjection: true,
        resetFlowResult: { agentName: "", agentIdShort: "", teamId: "", bypassed: true } });
    expect(JSON.stringify(output.mock.calls)).not.toContain(PRIVATE);
  });
});

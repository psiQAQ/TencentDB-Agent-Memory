import { afterEach, describe, expect, it, vi } from "vitest";

const PRIVATE_VALUE = "private-prewarm-wrapper-value";

vi.mock("../injection/prewarm.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../injection/prewarm.js")>();
  return {
    ...original,
    prewarmAll: vi.fn(async () => { throw new Error(PRIVATE_VALUE, { cause: PRIVATE_VALUE }); }),
  };
});

import { DEFAULT_CONFIG } from "../config.js";
import {
  __resetInjectionPipelineForTests,
  prewarmFromConfig,
} from "../injection/index.js";

afterEach(() => {
  __resetInjectionPipelineForTests();
  vi.restoreAllMocks();
});

describe("prewarm wrapper diagnostic privacy", () => {
  it("uses a fixed category when the prewarm runner rejects", async () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const config = structuredClone(DEFAULT_CONFIG);
    config.injection.injectors = [];
    const result = await prewarmFromConfig(config, {
      keyId: PRIVATE_VALUE,
      userId: PRIVATE_VALUE,
      agentSource: PRIVATE_VALUE,
      sessionInfo: {
        session_id: PRIVATE_VALUE,
        team_id: PRIVATE_VALUE,
        agent_id: PRIVATE_VALUE,
        user_id: PRIVATE_VALUE,
      },
      agentDetail: null,
      taskDetail: null,
    });

    const hasPrivateValue = consoleWarn.mock.calls.some((call) =>
      call.some((value) => value instanceof Error
        ? value.message.includes(PRIVATE_VALUE)
        : String(value).includes(PRIVATE_VALUE)),
    );
    expect(hasPrivateValue).toBe(false);
    expect(result).toEqual({ cachedHookIds: [], skipped: [], durationMs: 0 });
    expect(consoleWarn).toHaveBeenCalledWith(
      "[hook-cache] prewarm_failed category=unexpected_error",
    );
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";

import registerTdaiProvider from "../index";

const ENV_KEYS = [
  "TDAI_USER_KEY",
  "TDAI_TEAM_ID",
  "TDAI_AGENT_ID",
  "TDAI_TASK_ID",
  "TDAI_MODEL",
] as const;

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

describe("Pi TDAI provider", () => {
  it("uses DeepSeek-compatible roles and a dynamic Pi conversation id", () => {
    process.env.TDAI_USER_KEY = "test-user-key";
    process.env.TDAI_TEAM_ID = "team-test";
    process.env.TDAI_AGENT_ID = "agent-test";
    process.env.TDAI_TASK_ID = "task-test";
    process.env.TDAI_MODEL = "deepseek-v4-flash";

    const registerProvider = vi.fn();
    const handlers = new Map<string, (event: any, ctx: any) => void>();
    const pi = {
      registerProvider,
      on: vi.fn((event: string, handler: (payload: any, ctx: any) => void) => {
        handlers.set(event, handler);
      }),
    };

    registerTdaiProvider(pi as any);

    const config = registerProvider.mock.calls[0][1];
    expect(config.models[0].compat).toEqual({
      supportsDeveloperRole: false,
      supportsReasoningEffort: true,
    });

    const event = { headers: {} as Record<string, string> };
    handlers.get("before_provider_headers")!(event, {
      model: { provider: "tdai" },
      sessionManager: { getSessionId: () => "session-test" },
    });
    expect(event.headers["x-conversation-id"]).toBe("pi-session-test");
  });
});

import { describe, expect, it } from "vitest";
import { getEmbeddedAgentRuntime } from "./clean-context-runner.js";

describe("optional embedded agent runtime", () => {
  it.each([undefined, {}, { agent: null }, { agent: { runEmbeddedPiAgent: "unavailable" } }])(
    "leaves absent or invalid capabilities for dist fallback: %s", (runtime) => {
      expect(getEmbeddedAgentRuntime(runtime)).toBeUndefined();
    },
  );
  it("keeps the host runtime object when a runner is available", () => {
    const agent = { runEmbeddedPiAgent: async () => ({ payloads: [{ text: "result" }] }) };
    expect(getEmbeddedAgentRuntime({ agent })).toBe(agent);
  });
});

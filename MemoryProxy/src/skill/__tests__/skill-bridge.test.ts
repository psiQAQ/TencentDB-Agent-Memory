import { describe, expect, it } from "vitest";

import { buildBridgeSessionKeyCandidates } from "../../session/bridge-key-candidates.js";

describe("buildBridgeSessionKeyCandidates", () => {
  it("covers every session-aware agent source for a bare conversation id", () => {
    expect(buildBridgeSessionKeyCandidates("session-1")).toEqual([
      "session-1",
      "codebuddy:session-1",
      "claude-code:session-1",
      "codex:session-1",
      "workbuddy:session-1",
      "dsh:session-1",
      "opencode:session-1",
      "hermes:session-1",
      "openclaw:session-1",
      "cursor:session-1",
    ]);
  });

  it("does not add prefixes to an already composite key", () => {
    expect(buildBridgeSessionKeyCandidates("codex:session-1")).toEqual(["codex:session-1"]);
  });
});

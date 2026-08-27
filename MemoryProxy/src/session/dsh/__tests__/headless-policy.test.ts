import { describe, expect, it } from "vitest";

import type { SessionInitConfig } from "../../../types.js";
import {
  resolveDshHeadlessPolicy,
  sessionInitConfigForDshHeadless,
} from "../headless-policy.js";

const config: SessionInitConfig = {
  enabled: true,
  maxRetries: 3,
  headerAutoSelect: {
    enabled: true,
    teamHeader: "x-team-id",
    agentHeader: "x-agent-id",
    taskHeader: "x-task-id",
    onMismatch: "form",
  },
};

const bashTool = { type: "function", function: { name: "Bash" } };

describe("resolveDshHeadlessPolicy", () => {
  it("allows header-driven memory for DSH headless with complete identity headers", () => {
    const policy = resolveDshHeadlessPolicy(
      "dsh",
      { tools: [bashTool] },
      config,
      { "x-team-id": "team-1", "x-agent-id": "agent-1", "x-task-id": "task-1" },
    );

    expect(policy).toEqual({
      noInteractiveForm: true,
      hasCompleteHeaderIdentity: true,
      bypassMemory: false,
    });
    expect(sessionInitConfigForDshHeadless(config, policy).headerAutoSelect?.onMismatch).toBe("bypass");
  });

  it("keeps memory bypassed when a DSH headless identity is incomplete", () => {
    const policy = resolveDshHeadlessPolicy(
      "dsh",
      { tools: [bashTool] },
      config,
      { "x-team-id": "team-1" },
    );

    expect(policy.noInteractiveForm).toBe(true);
    expect(policy.hasCompleteHeaderIdentity).toBe(false);
    expect(policy.bypassMemory).toBe(true);
  });

  it("uses the normal interactive path when ask_user_question is available", () => {
    const policy = resolveDshHeadlessPolicy(
      "dsh",
      { tools: [bashTool, { type: "function", function: { name: "ask_user_question" } }] },
      config,
      {},
    );

    expect(policy.noInteractiveForm).toBe(false);
    expect(policy.bypassMemory).toBe(false);
    expect(sessionInitConfigForDshHeadless(config, policy)).toBe(config);
  });

  it("does not classify non-DSH clients as headless", () => {
    const policy = resolveDshHeadlessPolicy(
      "opencode",
      { tools: [bashTool] },
      config,
      { "x-team-id": "team-1", "x-agent-id": "agent-1" },
    );

    expect(policy.noInteractiveForm).toBe(false);
    expect(policy.bypassMemory).toBe(false);
  });
});

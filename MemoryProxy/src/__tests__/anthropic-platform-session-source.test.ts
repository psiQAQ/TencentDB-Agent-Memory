import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_CONFIG } from "../config.js";
import { handleSessionInit } from "../session/index.js";
import { SessionStore } from "../session/store.js";

describe("Anthropic platform session source", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(["opencode", "pi"])("keeps %s in session storage and Core records", async (source) => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const appendParticipationLog = vi.fn(async () => undefined);
    const metadataClient = {
      listTeams: vi.fn(async () => [{ team_id: "team-1", name: "Team" }]),
      listAgents: vi.fn(async () => [{ agent_id: "agent-1", name: "Agent" }]),
      listTasks: vi.fn(async () => [{ task_id: "task-1", title: "Task" }]),
      getAgent: vi.fn(async () => ({ agent_id: "agent-1", name: "Agent" })),
      getTask: vi.fn(async () => ({ task_id: "task-1", title: "Task" })),
      appendParticipationLog,
    };
    const store = new SessionStore();
    const sessionId = `ses_${source}`;
    const compositeKey = `${source}:${sessionId}`;
    store.bind(compositeKey, {
      userId: "user-1",
      agentSource: source,
      sessionId,
      spaceId: "space-1",
    });

    const result = await handleSessionInit(
      sessionId,
      "user-1",
      [{ role: "user", content: "hello" }],
      structuredClone(DEFAULT_CONFIG.sessionInit),
      store,
      { stream: false, modelId: "test-model", protocol: "anthropic" },
      source,
      metadataClient as never,
      "memory-user-key",
      "space-1",
      { teamId: "team-1", agentId: "agent-1", taskId: "task-1" },
    );
    await Promise.resolve();

    expect(result.intercepted).toBe(false);
    expect(store.getBoundIdentity(compositeKey)?.agentSource).toBe(source);
    expect(store.get(compositeKey)?.sessionInfo?.session_id).toBe(sessionId);
    expect(appendParticipationLog).toHaveBeenCalledWith(expect.objectContaining({
      source: `context_proxy:${source}`,
    }));
    const output = [...log.mock.calls, ...error.mock.calls, ...warn.mock.calls]
      .flat()
      .map(String)
      .join("\n");
    expect(output).not.toContain(sessionId);
  });
});

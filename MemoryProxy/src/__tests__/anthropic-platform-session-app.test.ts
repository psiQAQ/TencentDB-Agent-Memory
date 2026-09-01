import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { initAuth } from "../auth.js";
import { DEFAULT_CONFIG } from "../config.js";
import { setMetadataClient } from "../meta/client.js";
import { createApp } from "../server.js";
import { __resetSessionStoreForTests } from "../session/store.js";
import type { ProxyConfig } from "../types.js";

const MARKER = "privacy_sentinel";

function sessionConfig(): ProxyConfig {
  const config = structuredClone(DEFAULT_CONFIG);
  config.auth = { enabled: true, url: "https://auth.invalid", timeoutMs: 1_000 };
  config.upstream.url = "https://global.invalid/anthropic/v1";
  config.upstream.agents = {
    opencode: { url: "https://opencode.upstream.invalid/anthropic/v1", apiKey: "opencode-key" },
    pi: { url: "https://pi.upstream.invalid/anthropic/v1", apiKey: "pi-key" },
  };
  config.sessionInit.enabled = true;
  config.injection.enabled = false;
  config.extraction = { enabled: false, extractors: [] };
  config.rateLimit = { tpm: 0, qpm: 0 };
  config.log.backend = "noop";
  config.tdai.endpoint = "https://tdai.invalid";
  return config;
}

function metadata(marker = "fixture") {
  const teamId = `team_${marker}`;
  const agentId = `agent_${marker}`;
  const taskId = `task_${marker}`;
  return {
    ids: { teamId, agentId, taskId },
    client: {
      listTeams: vi.fn(async () => [{ team_id: teamId, name: "Team" }]),
      listAgents: vi.fn(async () => [{ agent_id: agentId, team_id: teamId, name: "Agent" }]),
      listTasks: vi.fn(async () => [{ task_id: taskId, team_id: teamId, title: "Task" }]),
      getAgent: vi.fn(async () => ({ agent_id: agentId, team_id: teamId, name: "Agent" })),
      getTask: vi.fn(async () => ({ task_id: taskId, team_id: teamId, title: "Task" })),
      appendParticipationLog: vi.fn(async () => undefined),
    },
  };
}

function requestBody(stream: boolean): Record<string, unknown> {
  return {
    model: "test-model",
    max_tokens: 32,
    stream,
    system: "client system",
    messages: [{ role: "user", content: "hello" }],
  };
}

function requestInit(
  sessionId: string,
  ids: { teamId: string; agentId: string; taskId: string },
  stream: boolean,
): RequestInit {
  return {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": `key_${sessionId}`,
      "x-session-id": sessionId,
      "x-team-id": ids.teamId,
      "x-agent-id": ids.agentId,
      "x-task-id": ids.taskId,
    },
    body: JSON.stringify(requestBody(stream)),
  };
}

describe("Anthropic platform session app flow", () => {
  beforeEach(() => __resetSessionStoreForTests());

  afterEach(() => {
    setMetadataClient(null);
    __resetSessionStoreForTests();
    initAuth(DEFAULT_CONFIG.auth);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each([
    ["opencode", false],
    ["pi", true],
  ] as const)("keeps %s session context in top-level system (stream=%s)", async (source, stream) => {
    const config = sessionConfig();
    const fixture = metadata(source);
    const upstreamBodies: Record<string, unknown>[] = [];
    setMetadataClient(fixture.client as never);
    initAuth(config.auth);
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.endsWith("/v3/meta/auth/verify")) {
        return Response.json({ code: 0, data: { valid: true, user: { user_id: `user_${source}` } } });
      }
      if (url.endsWith("/v3/meta/config/user/get")) {
        return Response.json({ code: 0, data: { items: [] } });
      }
      if (url === `https://${source}.upstream.invalid/anthropic/v1/messages`) {
        upstreamBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        if (stream) {
          return new Response("data: {\"type\":\"message_stop\"}\n\n", {
            headers: { "content-type": "text/event-stream" },
          });
        }
        return Response.json({
          id: "msg-test",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "ok" }],
          model: "test-model",
          stop_reason: "end_turn",
        });
      }
      throw new Error(`unexpected fetch category: ${new URL(url).hostname}`);
    }));
    const app = createApp(config);
    const response = await app.request(
      `http://proxy/${source}/space-1/v1/messages`,
      requestInit(`ses_${source}`, fixture.ids, stream),
    );
    await response.text();

    expect(response.status).toBe(200);
    expect(upstreamBodies).toHaveLength(1);
    expect(upstreamBodies[0].messages).toEqual([{ role: "user", content: "hello" }]);
    expect(upstreamBodies[0].system).toContain("client system");
    expect(upstreamBodies[0].system).toContain("<session_context>");
    expect(upstreamBodies[0].system).toContain(fixture.ids.agentId);
    expect(upstreamBodies[0].system).toContain(fixture.ids.taskId);
  });

  it("redacts shared recovery and capability console paths", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const config = sessionConfig();
    const fixture = metadata(MARKER);
    const sessionId = `ses_${MARKER}`;
    setMetadataClient(fixture.client as never);
    initAuth(config.auth);
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.endsWith("/v3/meta/auth/verify")) {
        return Response.json({ code: 0, data: { valid: true, user: { user_id: `user_${MARKER}` } } });
      }
      if (url.endsWith("/v3/meta/config/user/get")) {
        return Response.json({ code: 0, data: { items: [] } });
      }
      if (url === "https://opencode.upstream.invalid/anthropic/v1/messages") {
        return Response.json({
          id: "msg-test",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "ok" }],
          model: "test-model",
          stop_reason: "end_turn",
        });
      }
      throw new Error("unexpected fetch category");
    }));
    const app = createApp(config);

    for (const content of ["register", "recover"]) {
      const response = await app.request(
        "http://proxy/opencode/space-1/v1/messages",
        {
          ...requestInit(sessionId, fixture.ids, false),
          body: JSON.stringify({ ...requestBody(false), messages: [{ role: "user", content }] }),
        },
      );
      expect(response.status).toBe(200);
    }

    const output = [...log.mock.calls, ...warn.mock.calls, ...error.mock.calls]
      .flat()
      .map(String)
      .join("\n");
    expect(output).toContain("[cache] session=<redacted>");
    expect(output).toContain("[cache] session=<redacted> L1 hit");
    expect(output).toContain("[asset-capability] resolved user=present");
    expect(output).not.toContain(MARKER);
  });
});

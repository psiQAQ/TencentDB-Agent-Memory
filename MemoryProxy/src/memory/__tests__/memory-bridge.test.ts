import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initAuth } from "../../auth.js";
import { DEFAULT_CONFIG } from "../../config.js";
import { createMemoryBridgeHandler } from "../memory-bridge.js";

const metadata = vi.hoisted(() => ({ getAgentFixedAssets: vi.fn(), getAgent: vi.fn() }));
const session = vi.hoisted(() => ({ getOrRecover: vi.fn() }));
vi.mock("../../session/store.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../session/store.js")>(),
  getSessionStore: () => session,
}));
vi.mock("../../meta/client.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../meta/client.js")>(),
  getMetadataClient: () => metadata,
}));
vi.mock("../bridge-telemetry.js", () => ({ emitBridgeToolCallTelemetry: vi.fn() }));

const headers = {
  authorization: "Bearer synthetic-reader-key", "content-type": "application/json",
  "x-conversation-id": "session-reader", "x-tdai-service-id": "instance-1", "x-tdai-agent-source": "codex",
};
const reader = { agent_id: "agt-reader", owner_user_id: "reader", team_id: "team-1", name: "Reader" };
const writer = { agent_id: "agt-writer", owner_user_id: "writer", team_id: "team-1", name: "Writer" };

beforeEach(() => {
  vi.resetAllMocks();
  initAuth({ enabled: true, url: "https://auth.invalid", timeoutMs: 100 });
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ code: 0, data: { valid: true, user: { user_id: "reader" } } })));
  session.getOrRecover.mockResolvedValue({
    status: "initialized", keyId: "session-reader", userId: "reader", startedAt: 0, attemptCount: 0,
    sessionInfo: { session_id: "session-reader", user_id: "reader", team_id: "team-1", agent_id: "agt-reader", task_id: "reader-task", space_id: "instance-1" },
  });
  metadata.getAgentFixedAssets.mockResolvedValue({ agent: reader, items: [{ asset_id: "chat_memory-team-1-agt-writer", asset_type: "chat_memory", name: "Writer memory" }] });
  metadata.getAgent.mockResolvedValue(writer);
});

afterEach(() => {
  initAuth(DEFAULT_CONFIG.auth);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function fixture(fetcher = vi.fn<typeof fetch>(async (_url, init) => {
  const body = JSON.parse(String(init?.body));
  const row = { id: body.agent_id, score: body.agent_id === reader.agent_id ? 0.2 : 0.9 };
  return Response.json({ code: 0, data: { items: [row], messages: [row] } });
})) {
  const config = structuredClone(DEFAULT_CONFIG);
  config.coreSkill.endpoint = "https://core.invalid";
  config.coreSkill.serviceToken = "synthetic-service-token";
  const handler = createMemoryBridgeHandler(config, { fetcher });
  const app = new Hono();
  app.all("/memory-bridge/*", handler);
  const call = (sub: string, body: Record<string, unknown> = {}) => app.request(`/memory-bridge/v3/${sub}`, { method: "POST", headers, body: JSON.stringify(body) });
  const outbound = () => fetcher.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
  return { call, fetcher, outbound };
}

describe("memory bridge shared retrieval", () => {
  it.each([["atomic/search", "items"], ["conversation/search", "messages"]])("merges %s targets with authoritative identities and source attribution", async (path, resultKey) => {
    const { call, fetcher, outbound } = fixture();
    const response = await call(path, { query: "shared fact", user_id: "forged-user", team_id: "forged-team" });
    expect(response.status).toBe(200);
    expect(outbound()).toEqual([
      { query: "shared fact", user_id: "reader", team_id: "team-1", agent_id: "agt-reader", task_id: "reader-task" },
      { query: "shared fact", user_id: "writer", team_id: "team-1", agent_id: "agt-writer" },
    ]);
    const result = await response.json();
    expect(result.data[resultKey]).toEqual([
      { id: "agt-writer", score: 0.9, source_agent_id: "agt-writer", source_agent_name: "Writer", source_agent_role: "imported_from" },
      { id: "agt-reader", score: 0.2, source_agent_id: "agt-reader", source_agent_name: "Reader", source_agent_role: "self" },
    ]);
    expect(result.data.searched_agents).toEqual([
      { agent_id: "agt-reader", name: "Reader", role: "self" },
      { agent_id: "agt-writer", name: "Writer", role: "imported_from" },
    ]);
    for (const [url, init] of fetcher.mock.calls) {
      expect(url).toBe(`https://core.invalid/v3/${path}`);
      expect(init?.redirect).toBe("manual");
      expect(new Headers(init?.headers).get("x-tdai-service-id")).toBe("instance-1");
      expect(new Headers(init?.headers).get("authorization")).not.toContain("reader-key");
    }
  });

  it("uses an explicitly selected imported Agent and allows an explicit historical session", async () => {
    const { call, outbound } = fixture();
    await call("conversation/query", { agent_id: "agt-writer", session_id: "older-session", task_id: "reader-task" });
    expect(outbound()).toEqual([{ agent_id: "agt-writer", user_id: "writer", team_id: "team-1", session_id: "older-session", task_id: "reader-task" }]);
  });

  it("does not query an Agent outside the resolved binding set", async () => {
    const { call, outbound } = fixture();
    await call("atomic/search", { agent_id: "agt-outsider" });
    expect(outbound().map((body) => body.agent_id)).toEqual(["agt-reader"]);
  });

  it("rejects a forged task before resolving bindings or calling Core", async () => {
    const { call, fetcher } = fixture();
    const response = await call("atomic/search", { task_id: "another-task" });
    expect(response.status).toBe(403);
    expect((await response.json()).code).toBe(40303);
    expect(fetcher).not.toHaveBeenCalled();
    expect(metadata.getAgentFixedAssets).not.toHaveBeenCalled();
  });

  it("stops searching a revoked binding on the next request", async () => {
    const { call, fetcher, outbound } = fixture();
    await call("atomic/search");
    expect(outbound().map((body) => body.agent_id)).toEqual(["agt-reader", "agt-writer"]);
    metadata.getAgentFixedAssets.mockResolvedValueOnce({ agent: reader, items: [] });
    fetcher.mockClear();
    await call("atomic/search");
    expect(outbound().map((body) => body.agent_id)).toEqual(["agt-reader"]);
  });

  it.each(["network", "http", "malformed"])("preserves healthy search results when another target has a %s failure", async (failure) => {
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      const { agent_id } = JSON.parse(String(init?.body));
      if (agent_id === "agt-writer") {
        if (failure === "network") throw new Error("unavailable");
        return new Response(failure === "malformed" ? "not-json" : "unavailable", { status: failure === "http" ? 503 : 200 });
      }
      return Response.json({ code: 0, data: { items: [{ id: "healthy", score: 1 }] } });
    });
    const { call } = fixture(fetcher);
    const response = await call("atomic/search");
    expect(response.status).toBe(200);
    expect((await response.json()).data.items).toEqual([expect.objectContaining({ id: "healthy", source_agent_role: "self" })]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([[undefined, 5], [0, 5], [-1, 5], [2.8, 2], [1000, 50]])("applies limit %s after merging and sorting", async (limit, expected) => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ code: 0, data: { items: Array.from({ length: 30 }, (_, score) => ({ score })) } }));
    const { call } = fixture(fetcher);
    const result = await (await call("atomic/search", { limit })).json();
    expect(result.data.items).toHaveLength(expected!);
    expect(result.data.items[0].score).toBe(29);
    expect(result.data.items.map((row: { score: number }) => row.score)).toEqual([...result.data.items].map((row: { score: number }) => row.score).sort((a: number, b: number) => b - a));
  });

  it("keeps an upstream exception in a single-target query as an error", async () => {
    const { call } = fixture(vi.fn<typeof fetch>().mockRejectedValue(new Error("offline")));
    expect((await call("conversation/query")).status).toBe(502);
  });
});

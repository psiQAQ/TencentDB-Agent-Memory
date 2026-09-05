import { afterEach, describe, expect, it, vi } from "vitest";
import { MetadataClient } from "../client.js";

afterEach(() => vi.restoreAllMocks());

describe("MetadataClient fixed asset pagination after visibility filtering", () => {
  const agent = { agent_id: "agt-reader", team_id: "team-1", owner_user_id: "reader" };
  const item = (id: string) => ({ asset_id: id, asset_type: "chat_memory", name: id });
  function fixture(pages: Record<number, ReturnType<typeof item>[]>, total: number) {
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      const { offset } = JSON.parse(String(init?.body));
      return Response.json({ code: 0, data: { agent, items: pages[offset] ?? [], total, offset, limit: 100 } });
    });
    const client = new MetadataClient({ endpoint: "http://core.test", serviceToken: "synthetic-token", timeoutMs: 1_000 }, "instance", "synthetic-key", fetcher);
    const requests = () => fetcher.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
    return { client, fetcher, requests };
  }

  it.each([0, 1])("continues past a filtered first page containing %i rows", async (count) => {
    const first = count ? [item("first")] : [];
    const { client, requests } = fixture({ 0: first, 100: [item("later")] }, 101);
    expect(await client.getAgentFixedAssets(agent.agent_id)).toEqual({ agent, items: [...first, item("later")], total: 101 });
    expect(requests()).toEqual([0, 100].map((offset) => ({ agent_id: agent.agent_id, offset, limit: 100, apply_visibility_filter: true })));
  });

  it("terminates at the raw total when every page is filtered out", async () => {
    const { client, requests } = fixture({}, 201);
    expect((await client.getAgentFixedAssets(agent.agent_id)).items).toEqual([]);
    expect(requests().map((r) => r.offset)).toEqual([0, 100, 200]);
  });

  it("bounds raw scanning to 500 rows even when no visible rows accumulate", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { client, requests } = fixture({}, 10_000);
    await client.getAgentFixedAssets(agent.agent_id);
    expect(requests().map((r) => r.offset)).toEqual([0, 100, 200, 300, 400]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("truncated at 500"));
  });

  it("loads an unfiltered full page and the last page without an extra request", async () => {
    const first = Array.from({ length: 100 }, (_, i) => item(`memory-${i}`));
    const { client, requests } = fixture({ 0: first, 100: [item("last")] }, 101);
    expect((await client.getAgentFixedAssets(agent.agent_id, { applyVisibilityFilter: false })).items).toEqual([...first, item("last")]);
    expect(requests().map((r) => [r.offset, r.apply_visibility_filter])).toEqual([[0, false], [100, false]]);
  });

  it("returns the Agent once when it has no bindings", async () => {
    const { client, fetcher } = fixture({}, 0);
    expect(await client.getAgentFixedAssets(agent.agent_id)).toEqual({ agent, items: [], total: 0 });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("propagates a later-page failure instead of returning a silently partial binding list", async () => {
    const { client, fetcher } = fixture({ 0: [item("first")] }, 101);
    fetcher.mockImplementationOnce(async () => Response.json({ code: 0, data: { agent, items: [item("first")], total: 101 } }))
      .mockRejectedValueOnce(new Error("metadata unavailable"));
    await expect(client.getAgentFixedAssets(agent.agent_id)).rejects.toThrow("metadata unavailable");
  });
});

describe("MetadataClient task creation", () => {
  it("sends linked_agents using the Core taskCreateSchema contract", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      new Response(
        JSON.stringify({
          code: 0,
          data: {
            task_id: "task-1",
            team_id: "team-1",
            creator_user_id: "user-1",
            title: "Ship Atlas",
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const client = new MetadataClient(
      {
        endpoint: "http://memory-core.test",
        serviceToken: "service-token",
        timeoutMs: 1_000,
      },
      "instance-1",
      "user-key",
      fetcher,
    );

    await client.createTask({
      team_id: "team-1",
      creator_user_id: "user-1",
      title: "Ship Atlas",
      description: "Make Task relationships visible",
      linked_agents: [{ agent_id: "agent-1", role_in_task: "implementer" }],
    });

    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe("http://memory-core.test/v3/meta/task/create");
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body).toEqual({
      team_id: "team-1",
      creator_user_id: "user-1",
      title: "Ship Atlas",
      description: "Make Task relationships visible",
      linked_agents: [{ agent_id: "agent-1", role_in_task: "implementer" }],
    });
    expect(body).not.toHaveProperty("agent_id");
  });
});

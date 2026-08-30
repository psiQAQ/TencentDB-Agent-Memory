import { describe, expect, it, vi } from "vitest";
import { MetadataClient } from "../client.js";

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

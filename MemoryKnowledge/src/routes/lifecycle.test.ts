import { describe, expect, it } from "vitest";

import { createLifecycleRoutes } from "./lifecycle.js";

function request(path: string, token = "secret", body?: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-tdai-service-id": "default",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("internal knowledge lifecycle routes", () => {
  it("fails closed without configured auth and rejects a wrong token", async () => {
    const store = {} as any;
    expect((await createLifecycleRoutes({ store, authToken: "" }).fetch(request("/integrity/inventory"))).status).toBe(503);
    expect((await createLifecycleRoutes({ store, authToken: "secret" }).fetch(request("/integrity/inventory", "wrong"))).status).toBe(401);
  });

  it("compare-and-swaps Wiki ownership and returns content-free inventory", async () => {
    const wiki = { wiki_id: "wiki-1", owner_user_id: "old", status: "ready" };
    const store = {
      getWikiById: () => wiki,
      getCodeGraphById: () => null,
      transferWikiOwner: (_service: string, _id: string, from: string, to: string) => {
        if (wiki.owner_user_id !== from) return null;
        wiki.owner_user_id = to;
        return wiki;
      },
      listIntegrityInventory: () => [{
        resource_type: "llm_wiki", resource_id: "wiki-1", team_id: "team-1",
        owner_user_id: wiki.owner_user_id, name: "wiki", status: "ready",
        created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
      }],
    } as any;
    const app = createLifecycleRoutes({ store, authToken: "secret" });
    const transfer = await app.fetch(request("/ownership/transfer", "secret", {
      resource_type: "llm_wiki", resource_id: "wiki-1",
      from_owner_user_id: "old", to_owner_user_id: "new",
    }));
    expect(transfer.status).toBe(200);
    expect((await transfer.json()).data).toMatchObject({ owner_user_id: "new" });

    const inventory = await app.fetch(request("/integrity/inventory"));
    expect((await inventory.json()).data.items).toEqual([expect.objectContaining({
      resource_id: "wiki-1", owner_user_id: "new",
    })]);
  });
});

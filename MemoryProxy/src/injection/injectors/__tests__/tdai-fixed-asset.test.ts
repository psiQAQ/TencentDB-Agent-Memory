import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentContext } from "../../types.js";
import type { MetadataClient } from "../../../meta/client.js";
import type { TdaiIdentity } from "../../../tdai/types.js";
import { resolveFixedAssetCtxs } from "../tdai-fixed-asset.js";

const identity: TdaiIdentity = { teamId: "team-1", userId: "reader", agentId: "agt-reader", sessionId: "session-1" };
const request = (): AgentContext => ({ messages: [], tools: [], requestParams: {}, metadata: { protocol: "anthropic", traceId: "trace", keyId: "session-1", modelId: "model", stream: false, agentSource: "test", custom: {} } });
const self = { teamId: "team-1", userId: "reader", agentId: "agt-reader", agentName: "agt-reader", isSelf: true };
const memory = (id: string, assetType = "chat_memory") => ({ asset_id: id, asset_type: assetType, name: id });

function fixture(items = [memory("chat_memory-team-1-agt-writer")]) {
  const getAgentFixedAssets = vi.fn().mockResolvedValue({ agent: { agent_id: "agt-reader", team_id: "team-1", owner_user_id: "reader" }, items });
  const getAgent = vi.fn(async (id: string) => ({ agent_id: id, team_id: "team-1", owner_user_id: `owner-${id}`, name: `name-${id}` }));
  return { client: { getAgentFixedAssets, getAgent } as unknown as MetadataClient, getAgentFixedAssets, getAgent };
}

afterEach(() => vi.restoreAllMocks());

describe("shared Chat Memory target resolution", () => {
  it("keeps self first and limits imported sources to two", async () => {
    const { client } = fixture(["a", "b", "c"].map((id) => memory(`chat_memory-team-1-agt-${id}`)));
    expect(await resolveFixedAssetCtxs(request(), identity, client)).toEqual([
      self,
      ...["a", "b"].map((id) => ({ teamId: "team-1", userId: `owner-agt-${id}`, agentId: `agt-${id}`, agentName: `name-agt-${id}`, isSelf: false })),
    ]);
  });

  it("ignores non-memory, malformed, self and cross-Team bindings before looking up sources", async () => {
    const { client, getAgent } = fixture([
      memory("chat_memory-team-1-agt-skill", "skill"), memory("manual-memory"), memory("chat_memory-invalid"),
      memory("chat_memory-team-1-agt-reader"), memory("chat_memory-other-team-agt-outsider"),
    ]);
    expect(await resolveFixedAssetCtxs(request(), identity, client)).toEqual([self]);
    expect(getAgent).not.toHaveBeenCalled();
  });

  it("skips unavailable and cross-Team source Agents without losing healthy sources", async () => {
    const { client, getAgent } = fixture(["missing", "moved", "ok"].map((id) => memory(`chat_memory-team-1-agt-${id}`)));
    getAgent.mockRejectedValueOnce(new Error("not found"))
      .mockResolvedValueOnce({ agent_id: "agt-moved", team_id: "other-team", owner_user_id: "other-user", name: "Moved" });
    const result = await resolveFixedAssetCtxs(request(), identity, client);
    expect(result.map((target) => target.agentId)).toEqual(["agt-reader", "agt-ok"]);
    expect(result[1].userId).toBe("owner-agt-ok");
  });

  it("falls back to self on missing client or metadata failure", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { client, getAgentFixedAssets, getAgent } = fixture();
    getAgentFixedAssets.mockRejectedValueOnce(new Error("synthetic-private-error"));
    expect(await resolveFixedAssetCtxs(request(), identity, null)).toEqual([self]);
    expect(await resolveFixedAssetCtxs(request(), identity, client)).toEqual([self]);
    expect(getAgent).not.toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).not.toContain("synthetic-private-error");
  });

  it("reuses targets only within one request and observes revoked sharing on the next request", async () => {
    const { client, getAgentFixedAssets } = fixture();
    const ctx = request();
    const first = await resolveFixedAssetCtxs(ctx, identity, client);
    expect(first).toHaveLength(2);
    expect(await resolveFixedAssetCtxs(ctx, identity, client)).toBe(first);
    expect(getAgentFixedAssets).toHaveBeenCalledOnce();
    getAgentFixedAssets.mockResolvedValueOnce({ agent: {}, items: [] });
    expect(await resolveFixedAssetCtxs(request(), identity, client)).toEqual([self]);
    expect(getAgentFixedAssets).toHaveBeenCalledTimes(2);
  });
});

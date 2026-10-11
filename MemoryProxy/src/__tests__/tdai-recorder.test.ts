import { afterEach, expect, it, vi } from "vitest";
import { TdaiClient } from "../tdai/client.js";
import { recordTdaiTurn } from "../tdai/recorder.js";

const identity = { teamId: "team", userId: "user", agentId: "agent", sessionId: "session" };
const client = new TdaiClient({
  enabled: true, endpoint: "http://memory.test", apiKey: "synthetic", serviceId: "test",
  writeL0: true, recallL1: false, injectL2L3: false, l1Limit: 10, l2Limit: 10, timeoutMs: 1000,
});

afterEach(() => vi.unstubAllGlobals());

it("archives the final assistant continuation without duplicating its human input", async () => {
  const requests: Array<{ messages: Array<{ role: string; content: string }> }> = [];
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)));
    return Response.json({ code: 0 });
  }));
  await recordTdaiTurn(client, identity, { role: "user", content: "Run a tool and confirm the decision" }, "tool call");
  await recordTdaiTurn(client, identity, null, "The tool succeeded; confirmed decision");
  expect(requests.map((request) => request.messages)).toEqual([
    [{ role: "user", content: "Run a tool and confirm the decision" }, { role: "assistant", content: "tool call" }],
    [{ role: "assistant", content: "The tool succeeded; confirmed decision" }],
  ]);
});

it("does not archive without an identity or with an empty continuation", async () => {
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  await recordTdaiTurn(client, null, null, "answer");
  await recordTdaiTurn(client, identity, null, "  ");
  expect(fetcher).not.toHaveBeenCalled();
});

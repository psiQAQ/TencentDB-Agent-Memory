import { describe, expect, it, vi } from "vitest";

import type { IMemoryStore } from "../core/store/types.js";
import { handleConversationAdd, type V2RouterDeps } from "./v2-router.js";

describe("handleConversationAdd L0 persistence failures", () => {
  it("returns a retryable HTTP envelope and does not notify the pipeline", async () => {
    const store = {
      upsertL0: vi.fn().mockResolvedValue(false),
    } as unknown as IMemoryStore;
    const notifyPipeline = vi.fn();
    const deps: V2RouterDeps = {
      getStore: () => store,
      getEmbedding: () => undefined,
      getStorage: () => undefined,
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
      deployMode: "service",
      notifyPipeline,
    };

    const response = await handleConversationAdd(
      {
        session_id: "session-write-failure",
        messages: [{ role: "user", content: "must be persisted" }],
      },
      { apiKey: "test-key", serviceId: "test-service" },
      "request-write-failure",
      deps,
    );

    expect(response).toMatchObject({
      code: 503,
      message: "Failed to persist conversation message",
      request_id: "request-write-failure",
    });
    expect(store.upsertL0).toHaveBeenCalledTimes(1);
    expect(notifyPipeline).not.toHaveBeenCalled();
  });
});

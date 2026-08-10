import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { initAuth } from "../auth.js";
import { DEFAULT_CONFIG } from "../config.js";
import { createApp } from "../server.js";
import { _resetSystemUsersForTest, initSystemUsers } from "../systemUser.js";

function listen(server: Server): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

describe("upstream redirect privacy", () => {
  let redirector: Server;
  let receiver: Server;
  let redirectorOrigin: string;
  let receiverOrigin: string;
  let receiverRequests: number;
  let receiverSawServerKey: boolean;

  beforeAll(async () => {
    receiver = createServer((request, response) => {
      receiverRequests += 1;
      receiverSawServerKey ||= request.headers["x-api-key"] === "server-key";
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        id: "redirected",
        type: "message",
        role: "assistant",
        content: [],
        model: "test",
        input_tokens: 7,
      }));
    });
    receiverOrigin = await listen(receiver);

    redirector = createServer((request, response) => {
      if (request.url?.endsWith("/v3/meta/auth/verify")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          code: 0,
          data: { valid: true, user: { user_id: "system-user-1" } },
        }));
        return;
      }
      response.writeHead(302, { location: `${receiverOrigin}/capture` });
      response.end();
    });
    redirectorOrigin = await listen(redirector);
  });

  beforeEach(() => {
    receiverRequests = 0;
    receiverSawServerKey = false;
  });

  afterEach(() => {
    initAuth(DEFAULT_CONFIG.auth);
    _resetSystemUsersForTest();
  });

  afterAll(async () => {
    await Promise.all([close(redirector), close(receiver)]);
  });

  function config() {
    const value = structuredClone(DEFAULT_CONFIG);
    value.auth = { enabled: true, url: redirectorOrigin, timeoutMs: 1_000 };
    value.upstream.url = `${redirectorOrigin}/anthropic/v1`;
    value.upstream.apiKey = "server-key";
    value.upstream.agents["claude-code"] = {
      url: `${redirectorOrigin}/anthropic/v1`,
      apiKey: "server-key",
    };
    value.rateLimit = { tpm: 0, qpm: 0 };
    value.extraction = { enabled: false, extractors: [] };
    value.creditReport.url = "";
    value.log.backend = "noop";
    return value;
  }

  function request(path: string) {
    return {
      url: `http://proxy${path}`,
      init: {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": "memory-user-key",
          "x-session-id": "session-1",
        },
        body: JSON.stringify({
          model: "test-model",
          max_tokens: 16,
          messages: [{ role: "user", content: "hello" }],
        }),
      } satisfies RequestInit,
    };
  }

  it("does not follow a primary Anthropic redirect", async () => {
    const value = config();
    initAuth(value.auth);
    const app = createApp(value);
    const input = request("/claude-code/space-1/v1/messages");

    const response = await app.request(input.url, input.init);

    expect(receiverSawServerKey).toBe(false);
    expect(receiverRequests).toBe(0);
    expect(response.status).toBe(502);
  });

  it("does not follow a count_tokens redirect", async () => {
    const value = config();
    initAuth(value.auth);
    const app = createApp(value);
    const input = request("/claude-code/space-1/v1/messages/count_tokens");

    const response = await app.request(input.url, input.init);

    expect(response.status).toBe(502);
    expect(receiverRequests).toBe(0);
    expect(receiverSawServerKey).toBe(false);
  });

  it("does not follow a system-user redirect", async () => {
    const value = config();
    initAuth(value.auth);
    initSystemUsers([{ name: "memory", userId: "system-user-1", displayName: "Memory" }]);
    const app = createApp(value);
    const input = request("/claude-code/space-1/v1/messages");

    const response = await app.request(input.url, input.init);

    expect(response.status).toBe(502);
    expect(receiverRequests).toBe(0);
    expect(receiverSawServerKey).toBe(false);
  });
});

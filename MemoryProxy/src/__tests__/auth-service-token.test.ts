import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { initAuth, verifyUserKey } from "../auth.js";
import { buildConfig, DEFAULT_CONFIG } from "../config.js";

interface CapturedRequest {
  headers: IncomingHttpHeaders;
  body: string;
}

async function startAuthServer() {
  let capture!: (request: CapturedRequest) => void;
  const received = new Promise<CapturedRequest>((resolve) => {
    capture = resolve;
  });
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    capture({ headers: request.headers, body: Buffer.concat(chunks).toString("utf8") });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ code: 0, data: { valid: true, user: { user_id: "resolved-user" } } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    received,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

afterEach(() => initAuth(DEFAULT_CONFIG.auth));

describe("auth service token", () => {
  it("preserves auth.serviceToken from YAML config", async () => {
    const directory = await mkdtemp(join(tmpdir(), "memory-proxy-auth-"));
    const configPath = join(directory, "config.yaml");
    try {
      await writeFile(configPath, [
        "auth:",
        "  enabled: true",
        "  url: http://auth.invalid",
        "  serviceToken: '${MEMORY_CORE_SERVICE_TOKEN}'",
        "  timeoutMs: 1000",
      ].join("\n"));

      expect(buildConfig({ configFile: configPath }).auth.serviceToken)
        .toBe("${MEMORY_CORE_SERVICE_TOKEN}");
    } finally {
      await rm(directory, { recursive: true });
    }
  });

  it("uses only the server token as Bearer authorization", async () => {
    const authServer = await startAuthServer();
    try {
      initAuth({
        enabled: true,
        url: authServer.url,
        serviceToken: "server-auth-token",
        timeoutMs: 1000,
      });

      await expect(verifyUserKey("caller-user-key", "tenant-service")).resolves.toEqual({
        userId: "resolved-user",
        rejected: false,
      });
      const request = await authServer.received;
      expect(request.headers.authorization).toBe("Bearer server-auth-token");
      expect(request.headers["x-tdai-service-id"]).toBe("tenant-service");
      expect(request.headers["x-tdai-user-key"]).toBeUndefined();
      expect(JSON.stringify(request.headers)).not.toContain("caller-user-key");
      expect(JSON.parse(request.body)).toEqual({ user_key: "caller-user-key" });
    } finally {
      await authServer.close();
    }
  });

  it("omits Authorization when no server token is configured", async () => {
    const authServer = await startAuthServer();
    try {
      initAuth({ enabled: true, url: authServer.url, timeoutMs: 1000 });

      await verifyUserKey("caller-user-key", "tenant-service");
      const request = await authServer.received;
      expect(request.headers.authorization).toBeUndefined();
      expect(request.headers["x-tdai-service-id"]).toBe("tenant-service");
      expect(JSON.parse(request.body)).toEqual({ user_key: "caller-user-key" });
    } finally {
      await authServer.close();
    }
  });
});

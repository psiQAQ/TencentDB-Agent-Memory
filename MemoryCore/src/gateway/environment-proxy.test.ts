import { execFile } from "node:child_process";
import { createServer, request as httpRequest, type Server } from "node:http";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const run = promisify(execFile);

describe("gateway environment proxy with Core dependencies", () => {
  let origin: Server;
  let proxy: Server;
  let originPort: number;
  let proxyPort: number;
  let connections: string[];

  async function listen(server: Server): Promise<number> {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No test port");
    return address.port;
  }

  beforeEach(async () => {
    connections = [];
    origin = createServer((_req, res) => res.end("synthetic-model-response"));
    originPort = await listen(origin);
    proxy = createServer((req, res) => {
      connections.push(req.url ?? "");
      // Only forward to this test's local origin; no external traffic.
      const target = httpRequest(
        { hostname: "127.0.0.1", port: originPort, path: new URL(req.url!).pathname, method: req.method },
        (upstream) => {
          res.writeHead(upstream.statusCode!, upstream.headers);
          upstream.pipe(res);
        },
      );
      target.on("error", () => res.destroy());
      req.pipe(target);
    });
    proxyPort = await listen(proxy);
  });

  afterEach(async () => {
    for (const server of [proxy, origin]) {
      server?.closeAllConnections();
      if (server?.listening) {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }
  });

  async function request(enabled: boolean, noProxy = "") {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      NODE_OPTIONS: "",
      NODE_USE_ENV_PROXY: enabled ? "1" : "0",
      HTTP_PROXY: `http://127.0.0.1:${proxyPort}`,
      HTTPS_PROXY: `http://127.0.0.1:${proxyPort}`,
      NO_PROXY: noProxy,
    };
    for (const key of ["http_proxy", "https_proxy", "no_proxy"]) delete env[key];
    const { stdout } = await run(
      process.execPath,
      [
        "--import", "tsx", "--input-type=module", "-e",
        `
          // Load the same Undici dependency as the gateway before initializing network policy.
          await import(${JSON.stringify(new URL("../core/store/tcvdb/client.ts", import.meta.url).href)});
          const { configureEnvironmentProxy } = await import(${JSON.stringify(new URL("./environment-proxy.ts", import.meta.url).href)});
          configureEnvironmentProxy();
          const { modelRequest } = await import(${JSON.stringify(new URL("../metadata/models/http.ts", import.meta.url).href)});
          const { text } = await modelRequest("http://127.0.0.1:${originPort}/models");
          console.log(text);
          const { getGlobalDispatcher } = await import("undici");
          await getGlobalDispatcher().close();
        `,
      ],
      {
        cwd: new URL("../../", import.meta.url),
        timeout: 10_000,
        env,
      },
    );
    expect(stdout.trim()).toBe("synthetic-model-response");
  }

  it("routes model requests through the configured proxy after loading Core dependencies", async () => {
    await request(true);
    expect(connections).toEqual([`http://127.0.0.1:${originPort}/models`]);
  });

  it("keeps NO_PROXY destinations direct", async () => {
    await request(true, "127.0.0.1");
    expect(connections).toEqual([]);
  });

  it("does not enable proxy routing without the explicit opt-in", async () => {
    await request(false);
    expect(connections).toEqual([]);
  });
});

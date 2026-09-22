import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";

import { loadConfig } from "../config.js";
import { createServiceAuthMiddleware, verifyBearer } from "./auth.js";

afterEach(() => vi.unstubAllEnvs());

describe("Knowledge credential separation", () => {
  it("requires distinct configured service and lifecycle credentials", () => {
    vi.stubEnv("KNOWLEDGE_SERVICE_KEY", "same-key");
    vi.stubEnv("KNOWLEDGE_LIFECYCLE_AUTH_TOKEN", "same-key");
    expect(() => loadConfig()).toThrow("must be different");
  });

  it("accepts only the matching credential for general writes and lifecycle operations", async () => {
    const app = new Hono();
    const api = new Hono();
    api.use("*", createServiceAuthMiddleware({ serviceKey: "service-key" }, "/v3"));
    for (const path of ["/wiki/delete", "/wiki/raw/rm", "/wiki/page/rm", "/code-graph/delete"]) {
      api.use(path, async (c, next) => {
        if (!verifyBearer(c.req.header("authorization"), "lifecycle-key")) return c.text("denied", 401);
        await next();
      });
    }
    api.post("/wiki/ingest", (c) => c.text("ok"));
    api.post("/wiki/get", (c) => c.text("ok"));
    api.post("/wiki/delete", (c) => c.text("ok"));
    api.post("/wiki/raw/rm", (c) => c.text("ok"));
    api.post("/wiki/page/rm", (c) => c.text("ok"));
    api.post("/code-graph/delete", (c) => c.text("ok"));
    api.route("/internal/lifecycle", new Hono().post("/integrity/inventory", (c) =>
      verifyBearer(c.req.header("authorization"), "lifecycle-key") ? c.text("ok") : c.text("denied", 401)));
    app.route("/v3", api);

    const post = (path: string, token?: string) => app.request(`http://localhost/v3${path}`, {
      method: "POST",
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
    expect((await post("/wiki/get")).status).toBe(200);
    expect((await post("/wiki/ingest")).status).toBe(401);
    expect((await post("/wiki/ingest", "lifecycle-key")).status).toBe(401);
    expect((await post("/wiki/ingest", "service-key")).status).toBe(200);
    expect((await post("/wiki/delete", "service-key")).status).toBe(401);
    expect((await post("/wiki/delete", "lifecycle-key")).status).toBe(200);
    expect((await post("/wiki/raw/rm", "service-key")).status).toBe(401);
    expect((await post("/wiki/raw/rm", "lifecycle-key")).status).toBe(200);
    expect((await post("/wiki/page/rm", "service-key")).status).toBe(401);
    expect((await post("/wiki/page/rm", "lifecycle-key")).status).toBe(200);
    expect((await post("/code-graph/delete", "service-key")).status).toBe(401);
    expect((await post("/code-graph/delete", "lifecycle-key")).status).toBe(200);
    expect((await post("/internal/lifecycle/integrity/inventory", "service-key")).status).toBe(401);
    expect((await post("/internal/lifecycle/integrity/inventory", "lifecycle-key")).status).toBe(200);
  });
});

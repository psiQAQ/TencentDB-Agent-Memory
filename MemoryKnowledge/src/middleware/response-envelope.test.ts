import { Hono } from "hono";
import { expect, it } from "vitest";

import { accessLog } from "./response-envelope.js";

it("preserves JSON request bodies for handlers after access logging", async () => {
  const app = new Hono();
  app.use("*", accessLog());
  app.post("/write", async (c) => c.json(await c.req.json()));

  const response = await app.request("http://localhost/write", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ team_id: "team-1" }),
  });

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ team_id: "team-1" });
});

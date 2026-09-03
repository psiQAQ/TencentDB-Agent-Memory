import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";

import { isValidIdSegment, wrapError, wrapOk } from "../api-helpers.js";
import type { IKnowledgeStore } from "../store/index.js";

interface LifecycleRouteDeps {
  store: IKnowledgeStore;
  authToken: string;
}

function tokenMatches(header: string | undefined, expected: string): boolean {
  if (!expected || !header?.startsWith("Bearer ")) return false;
  const actual = Buffer.from(header.slice(7), "utf8");
  const wanted = Buffer.from(expected, "utf8");
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

/**
 * Trusted lifecycle coordination endpoint. It is intentionally separate from
 * user-facing Wiki/Code Graph routes: only the Panel control plane receives
 * KNOWLEDGE_AUTH_TOKEN, and the update remains compare-and-swap on from_owner.
 */
export function createLifecycleRoutes(deps: LifecycleRouteDeps): Hono {
  const app = new Hono();

  app.use("*", async (c, next) => {
    if (!deps.authToken) return c.json(wrapError(503, "lifecycle auth is not configured"), 503);
    if (!tokenMatches(c.req.header("authorization"), deps.authToken)) {
      return c.json(wrapError(401, "invalid lifecycle authorization"), 401);
    }
    await next();
  });

  app.post("/ownership/transfer", async (c) => {
    const serviceId = c.req.header("x-tdai-service-id");
    if (!isValidIdSegment(serviceId)) {
      return c.json(wrapError(400, "x-tdai-service-id header is required"), 400);
    }
    const body: Record<string, unknown> = await c.req.json<Record<string, unknown>>().catch(() => ({}));
    const type = body.resource_type;
    const resourceId = typeof body.resource_id === "string" ? body.resource_id.trim() : "";
    const fromOwner = typeof body.from_owner_user_id === "string" ? body.from_owner_user_id.trim() : "";
    const toOwner = typeof body.to_owner_user_id === "string" ? body.to_owner_user_id.trim() : "";
    if ((type !== "llm_wiki" && type !== "code_graph") || !resourceId || !fromOwner || !toOwner) {
      return c.json(wrapError(400, "invalid ownership transfer request"), 400);
    }

    const current = type === "llm_wiki"
      ? deps.store.getWikiById(serviceId, resourceId)
      : deps.store.getCodeGraphById(serviceId, resourceId);
    if (!current) return c.json(wrapError(404, "knowledge resource not found"), 404);
    if (current.owner_user_id === toOwner) {
      return c.json(wrapOk({
        resource_type: type,
        resource_id: resourceId,
        owner_user_id: current.owner_user_id,
        status: current.status,
        idempotent: true,
      }));
    }
    if (current.owner_user_id !== fromOwner) {
      return c.json(wrapError(409, "backing owner changed"), 409);
    }
    if (current.status === "processing") {
      return c.json(wrapError(409, "knowledge resource is processing"), 409);
    }

    const updated = type === "llm_wiki"
      ? deps.store.transferWikiOwner(serviceId, resourceId, fromOwner, toOwner)
      : deps.store.transferCodeGraphOwner(serviceId, resourceId, fromOwner, toOwner);
    if (!updated) return c.json(wrapError(409, "ownership compare-and-swap failed"), 409);
    return c.json(wrapOk({
      resource_type: type,
      resource_id: resourceId,
      owner_user_id: updated.owner_user_id,
      status: updated.status,
    }));
  });

  app.post("/integrity/inventory", (c) => {
    const serviceId = c.req.header("x-tdai-service-id");
    if (!isValidIdSegment(serviceId)) {
      return c.json(wrapError(400, "x-tdai-service-id header is required"), 400);
    }
    return c.json(wrapOk({ items: deps.store.listIntegrityInventory(serviceId) }));
  });

  return app;
}

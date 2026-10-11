import type { Hono } from "hono";
import { z } from "zod";
import type { PanelDeps } from "../../panel-deps.js";
import type { MetaCallContext } from "../../kernel/types.js";
import type { MetaEnvelope } from "../../kernel/envelope.js";
import { validatePanelMetaHeaders } from "../middleware/validate-panel-headers.js";
import {
  buildCtx,
  isCallerSystemAdmin,
  okEnvelope,
} from "./knowledge/common.js";
import { respondControlError } from "../envelope.js";

interface Pending {
  ctx: MetaCallContext;
  reference: string;
  expires: number;
  result?: MetaEnvelope;
  completing?: boolean;
}
const startSchema = z.object({
  reference: z.string().max(128).optional(),
  callback_port: z.number().int().min(1024).max(65535).default(8125),
});

/** Loopback callback bridges only an admin's pending attempt; Core owns PKCE and token storage. */
export function registerChatGPTRoutes(
  app: Hono,
  api: Hono,
  deps: PanelDeps,
): void {
  const pending = new Map<string, Pending>();
  const expire = () => {
    for (const [key, value] of pending)
      if (value.expires < Date.now()) pending.delete(key);
  };
  api.post(
    "/meta/model-connections/chatgpt/start",
    validatePanelMetaHeaders(deps),
    async (c) => {
      const ctx = buildCtx(c);
      if (!(await isCallerSystemAdmin(deps, ctx)))
        return respondControlError(c, 403, "permission_denied");
      const parsed = startSchema.safeParse(
        await c.req.json().catch(() => null),
      );
      if (!parsed.success) return respondControlError(c, 400, "INVALID_PARAM");
      expire();
      if (pending.size >= 100)
        return respondControlError(c, 429, "CHATGPT_LOGIN_BUSY");
      const result = await deps.metaKernel.invoke(
        "model-connections/chatgpt/start",
        parsed.data,
        ctx,
      );
      if (result.code === 0) {
        const data = result.data as {
          state: string;
          reference: string;
          expires_at: number;
        };
        pending.set(data.state, {
          ctx,
          reference: data.reference,
          expires: data.expires_at,
        });
      }
      c.header("Cache-Control", "no-store");
      return c.json(result);
    },
  );
  api.post(
    "/meta/model-connections/chatgpt/result",
    validatePanelMetaHeaders(deps),
    async (c) => {
      const ctx = buildCtx(c);
      if (!(await isCallerSystemAdmin(deps, ctx)))
        return respondControlError(c, 403, "permission_denied");
      const body = (await c.req.json().catch(() => null)) as {
        state?: string;
      } | null;
      expire();
      const attempt = body?.state ? pending.get(body.state) : undefined;
      if (
        !attempt ||
        attempt.ctx.instanceId !== ctx.instanceId ||
        attempt.ctx.userKey !== ctx.userKey
      )
        return respondControlError(c, 404, "CHATGPT_LOGIN_EXPIRED");
      c.header("Cache-Control", "no-store");
      return c.json(
        okEnvelope(c, {
          pending: !attempt.result,
          result: attempt.result ?? null,
        }),
      );
    },
  );
  // Prevent bypassing the callback binding through the generic public proxy.
  api.post("/meta/model-connections/chatgpt/complete", (c) =>
    respondControlError(c, 400, "CHATGPT_CALLBACK_REQUIRED"),
  );
  app.get("/auth/callback", async (c) => {
    expire();
    c.header("Cache-Control", "no-store");
    c.header("Referrer-Policy", "no-referrer");
    c.header(
      "Content-Security-Policy",
      "default-src 'none'; frame-ancestors 'none'",
    );
    const state = c.req.query("state") ?? "";
    const attempt = pending.get(state);
    if (!attempt || attempt.result || attempt.completing)
      return c.text("登录请求已过期，请返回模型设置重新登录。", 400);
    attempt.completing = true;
    try {
      attempt.result = await deps.metaKernel.invoke(
        "model-connections/chatgpt/complete",
        {
          reference: attempt.reference,
          state,
          authorization_code: c.req.query("code"),
          client_id: c.req.query("client_id"),
          error: c.req.query("error"),
        },
        attempt.ctx,
      );
    } catch {
      attempt.result = {
        code: 502,
        message: "CHATGPT_LOGIN_UNAVAILABLE",
        data: null,
        request_id: "",
      };
    }
    return c.text(
      attempt.result.code === 0
        ? "ChatGPT 登录完成。请关闭此页面，返回模型设置。"
        : "ChatGPT 登录未完成。请返回模型设置查看结果并重新登录。",
      attempt.result.code === 0 ? 200 : 400,
    );
  });
}

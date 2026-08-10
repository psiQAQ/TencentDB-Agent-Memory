/**
 * Request debug log — logs every intercepted LLM API request body via structured log system.
 * Only active when log.level === "debug".
 */

import type { ProxyConfig } from "./types.js";
import { log } from "./report/log.js";

/** Write privacy-safe request shape metadata. Only writes if level=debug. */
export function writeRequestLog(config: ProxyConfig, body: Record<string, unknown>): void {
  if (config.log.level !== "debug") return;
  const modelConfigured = typeof body.model === "string" && body.model.length > 0;
  const msgCount = Array.isArray(body.messages) ? body.messages.length : 0;
  const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
  log.debug("request.body", { modelConfigured, msgCount, hasTools, stream: body.stream === true });
}

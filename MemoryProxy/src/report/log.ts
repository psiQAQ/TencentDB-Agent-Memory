/**
 * Structured logging facade — the single entry point for all logging.
 *
 * Usage:
 *   import { log } from "./report/log.js";
 *
 *   log.info("forward_done", { status: 200, latencyMs: 42 });
 *   log.error("upstream_timeout", { url }, err);
 *   log.debug("routing_request", { model, messages: msgCount });
 *
 * Architecture:
 *   log.info() → emit() → FileLogger (local file) + ILogBackend (remote/console)
 *
 * Design principles (from offload_server's log.ts):
 * 1. Simple API: log.info(msg, data), log.error(msg, data, err)
 * 2. Dual-write: local file + backend simultaneously
 * 3. Error-silent: log failures never block or crash
 * 4. Level filtering: respects minimum log level
 */

import { FileLogger } from "./file-logger.js";
import { ConsoleLogBackend } from "./backends/console.js";
import { NoopLogBackend } from "./backends/noop.js";
import type { ILogBackend, LogAttrs, LogConfig, LogLevel } from "./types.js";
import { LOG_LEVEL_PRIORITY } from "./types.js";

// ─── Module State ────────────────────────────────────────────────────────────

let fileLogger: FileLogger | null = null;
let backend: ILogBackend = new NoopLogBackend();
let minLevel: LogLevel = "info";

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Initialize the logging system.
 * Must be called once at startup (in index.ts).
 * Idempotent: subsequent calls are ignored.
 *
 * @param config Log configuration from ProxyConfig
 * @param customBackend Optional custom ILogBackend (for testing/extension)
 */
export function initLogger(config: LogConfig, customBackend?: ILogBackend): void {
  minLevel = config.level;

  // Initialize file logger
  if (config.filePath) {
    try {
      fileLogger = new FileLogger({
        dir: config.filePath,
        filename: "proxy.log",
        rotateSizeBytes: config.rotate.maxSizeBytes,
        rotateBackupLimit: config.rotate.backupLimit,
      });
    } catch {
      process.stderr.write("[log] failed to init file logger category=filesystem_error\n");
    }
  }

  // Set backend
  if (customBackend) {
    backend = customBackend;
  } else {
    switch (config.backend) {
      case "console":
        backend = new ConsoleLogBackend();
        break;
      default:
        backend = new NoopLogBackend();
        break;
    }
  }
}

/**
 * Graceful shutdown: flush all pending data and close streams.
 * Should be called on process exit.
 */
export async function shutdownLogger(): Promise<void> {
  if (fileLogger) {
    await fileLogger.shutdown();
  }
  if (backend) {
    await backend.shutdown();
  }
}

/** Get the current log level (useful for conditional debug). */
export function getLogLevel(): LogLevel {
  return minLevel;
}

// ─── Structured Log API ──────────────────────────────────────────────────────

export const log = {
  /**
   * DEBUG level — verbose diagnostic information.
   * Use for: detailed request/response dumps, internal state transitions.
   */
  debug(event: string, data?: Record<string, unknown>): void {
    emit("debug", event, data);
  },

  /**
   * INFO level — normal operational events.
   * Use for: request lifecycle, routing decisions, usage records.
   */
  info(event: string, data?: Record<string, unknown>): void {
    emit("info", event, data);
  },

  /**
   * WARN level — non-fatal issues that may need attention.
   * Use for: retry attempts, degraded routing, near-limit conditions.
   */
  warn(event: string, data?: Record<string, unknown>): void {
    emit("warn", event, data);
  },

  /**
   * ERROR level — failures that affect the current request.
   * Use for: upstream timeouts, parse errors, 4xx/5xx responses.
   * The err parameter is optional but recommended for stack trace capture.
   */
  error(event: string, data?: Record<string, unknown>, err?: Error): void {
    emit("error", event, data, err);
  },
};

// ─── Internal ────────────────────────────────────────────────────────────────

const SAFE_STRING_FIELDS = new Set([
  "backend",
  "category",
  "effective",
  "event",
  "level",
  "protocol",
  "requested",
  "source",
  "stage",
  "status",
]);

function sanitizeLogAttrs(data?: Record<string, unknown>, err?: Error): LogAttrs {
  const attrs: LogAttrs = {};
  for (const [key, value] of Object.entries(data ?? {})) {
    if (value === null || value === undefined) continue;
    if (typeof value === "number" && Number.isFinite(value)) {
      attrs[key] = value;
    } else if (typeof value === "boolean") {
      attrs[key] = value;
    } else if (
      typeof value === "string"
      && SAFE_STRING_FIELDS.has(key)
      && value.length <= 64
      && /^[A-Za-z0-9_.:-]+$/.test(value)
    ) {
      attrs[key] = value;
    } else if (typeof value === "string") {
      attrs[key] = "[redacted]";
    } else if (Array.isArray(value)) {
      attrs[`${key}.count`] = value.length;
    } else if (typeof value === "object") {
      attrs[`${key}.fieldCount`] = Object.keys(value as Record<string, unknown>).length;
    }
  }
  if (err) attrs.errorCategory = "error";
  return attrs;
}

function emit(
  level: LogLevel,
  event: string,
  data?: Record<string, unknown>,
  err?: Error,
): void {
  // Level filtering
  if (LOG_LEVEL_PRIORITY[level] < LOG_LEVEL_PRIORITY[minLevel]) return;

  try {
    const attrs = sanitizeLogAttrs(data, err);

    // Dual-write: local file + backend
    fileLogger?.write(level.toUpperCase(), event, attrs);

    switch (level) {
      case "debug":
        backend.debug(event, attrs);
        break;
      case "info":
        backend.info(event, attrs);
        break;
      case "warn":
        backend.warn(event, attrs);
        break;
      case "error":
        backend.error(event, attrs);
        break;
    }
  } catch {
    // Logging errors must never propagate
  }
}

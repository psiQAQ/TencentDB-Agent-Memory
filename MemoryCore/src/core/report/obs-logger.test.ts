import { describe, expect, it, vi } from "vitest";

const sinks = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), file: vi.fn() }));
vi.mock("./factory.js", () => ({ getObservabilityBackend: () => ({ log: sinks }) }));
vi.mock("./file-logger.js", () => ({ FileLogger: class { write = sinks.file; } }));

import { obsLogger } from "./obs-logger.js";

describe("observability attributes", () => {
  it.each(["info", "warn"] as const)("%s omits absent fields and keeps zero, false and empty strings", (level) => {
    obsLogger[level]("event", { missing: undefined, empty: null, count: 0, enabled: false, value: "" });
    const attributes = { count: 0, enabled: false, value: "" };
    expect(sinks[level]).toHaveBeenCalledWith("event", attributes);
    expect(sinks.file).toHaveBeenCalledWith(level.toUpperCase(), "event", attributes);
  });

  it("preserves error details without mutating caller attributes", () => {
    const attrs = { instance_id: undefined, count: 1 };
    const error = new TypeError("invalid event");
    obsLogger.error("failed", attrs, error);
    const expected = { count: 1, "error.message": "invalid event", "error.type": "TypeError" };
    expect(sinks.error).toHaveBeenCalledWith("failed", expected, error);
    expect(sinks.file).toHaveBeenCalledWith("ERROR", "failed", expected);
    expect(attrs).toEqual({ instance_id: undefined, count: 1 });
  });
});

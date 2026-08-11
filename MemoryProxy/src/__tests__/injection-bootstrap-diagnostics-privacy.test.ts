import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const PRIVATE_VALUE = "private-injection-bootstrap-value";

const {
  getHookCacheRepo,
  getProxyStorage,
  getRedisClient,
} = vi.hoisted(() => ({
  getHookCacheRepo: vi.fn(),
  getProxyStorage: vi.fn(),
  getRedisClient: vi.fn(),
}));

vi.mock("../db/hookCacheRepo.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../db/hookCacheRepo.js")>();
  return { ...original, getHookCacheRepo };
});

vi.mock("../db/redis-client.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../db/redis-client.js")>();
  return { ...original, getRedisClient };
});

vi.mock("../storage/factory.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../storage/factory.js")>();
  return { ...original, getProxyStorage };
});

import { DEFAULT_CONFIG } from "../config.js";
import {
  __resetInjectionPipelineForTests,
  getInjectionPipeline,
  tryActivateRedis,
  tryActivateStorage,
} from "../injection/index.js";

function containsPrivateValue(value: unknown): boolean {
  const seen = new Set<object>();
  const visit = (item: unknown): boolean => {
    if (typeof item === "string") return item.includes(PRIVATE_VALUE);
    if (item instanceof AggregateError) {
      return visit(item.message) || visit(item.stack) || visit(item.cause) || visit(item.errors);
    }
    if (item instanceof Error) return visit(item.message) || visit(item.stack) || visit(item.cause);
    if (!item || typeof item !== "object" || seen.has(item)) return false;
    seen.add(item);
    return Object.entries(item).some(([key, nested]) => visit(key) || visit(nested));
  };
  return visit(value);
}

function config() {
  const value = structuredClone(DEFAULT_CONFIG);
  value.storage.enabled = false;
  value.redis.enabled = false;
  value.injection.injectors = [];
  return value;
}

beforeEach(() => {
  getHookCacheRepo.mockReset().mockReturnValue(undefined);
  getProxyStorage.mockReset();
  getRedisClient.mockReset().mockReturnValue(null);
});

afterEach(() => {
  __resetInjectionPipelineForTests();
  vi.restoreAllMocks();
});

describe("injection bootstrap diagnostic privacy", () => {
  it("reports a fixed ProxyStorage initialization failure", () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    getProxyStorage.mockImplementationOnce(() => {
      throw new Error(PRIVATE_VALUE, { cause: PRIVATE_VALUE });
    });
    const value = config();
    value.storage.enabled = true;

    expect(tryActivateStorage(value)).toBe(false);
    expect(containsPrivateValue(consoleWarn.mock.calls)).toBe(false);
    expect(consoleWarn).toHaveBeenCalledWith(
      "[injection] storage_init_failed backend=proxy_storage category=initialization_error fallback=true",
    );
  });

  it("reports a fixed Redis initialization failure", () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    getRedisClient.mockImplementationOnce(() => {
      throw new Error(PRIVATE_VALUE, { cause: PRIVATE_VALUE });
    });
    const value = config();
    value.redis.enabled = true;

    expect(tryActivateRedis(value)).toBe(false);
    expect(containsPrivateValue(consoleWarn.mock.calls)).toBe(false);
    expect(consoleWarn).toHaveBeenCalledWith(
      "[injection] storage_init_failed backend=redis category=initialization_error fallback=true",
    );
  });

  it("reports a fixed hook-cache initialization failure", () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    getHookCacheRepo.mockImplementationOnce(() => {
      throw new Error(PRIVATE_VALUE, { cause: PRIVATE_VALUE });
    });

    getInjectionPipeline(config());

    expect(containsPrivateValue(consoleWarn.mock.calls)).toBe(false);
    expect(consoleWarn).toHaveBeenCalledWith(
      "[injection] hook_cache_unavailable category=initialization_error caching=false",
    );
  });

  it("does not log a configured external gateway URL", () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const value = config();
    value.injection.injectors = ["skill"];
    value.injection.externalGatewayUrl = `https://${PRIVATE_VALUE}.invalid`;

    getInjectionPipeline(value);

    expect(containsPrivateValue(consoleLog.mock.calls)).toBe(false);
    expect(consoleLog).toHaveBeenCalledWith(
      "[injection] gateway_config source=external present=true",
    );
  });

  it("does not log a fallback gateway URL", () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const value = config();
    value.injection.injectors = ["skill"];
    value.injection.externalGatewayUrl = "";
    value.server.host = PRIVATE_VALUE;

    getInjectionPipeline(value);

    expect(containsPrivateValue(consoleWarn.mock.calls)).toBe(false);
    expect(consoleWarn).toHaveBeenCalledWith(
      "[injection] gateway_config source=fallback present=true multi_node_safe=false",
    );
  });
});

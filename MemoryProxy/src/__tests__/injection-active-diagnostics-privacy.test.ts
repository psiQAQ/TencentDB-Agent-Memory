import { afterEach, describe, expect, it, vi } from "vitest";

import type { HookCacheRepo } from "../db/hookCacheRepo.js";
import { OpenAIAdapter } from "../injection/adapters/openai.js";
import type { AgentProfile } from "../injection/agents/interface.js";
import { LoggingInjectionObserver } from "../injection/observer.js";
import { InjectionPipeline } from "../injection/pipeline.js";
import { prewarmAll } from "../injection/prewarm.js";
import { HookRegistryImpl } from "../injection/registry.js";
import type {
  AgentContextMetadata,
  CacheStrategy,
  InjectionHook,
  InjectionPoint,
  PrewarmInput,
} from "../injection/types.js";
import { log } from "../report/log.js";

const PRIVATE_VALUE = "private-injection-diagnostics-value";

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

function metadata(): AgentContextMetadata {
  return {
    protocol: "openai",
    traceId: PRIVATE_VALUE,
    keyId: PRIVATE_VALUE,
    modelId: PRIVATE_VALUE,
    stream: false,
    agentSource: PRIVATE_VALUE,
    userId: PRIVATE_VALUE,
    spaceId: PRIVATE_VALUE,
    sessionKey: PRIVATE_VALUE,
    custom: { session: { session_id: PRIVATE_VALUE } },
  };
}

function cacheRepo(overrides: Partial<HookCacheRepo> = {}): HookCacheRepo {
  return {
    put: () => {},
    putMany: () => {},
    get: async () => null,
    getAllForSession: async () => [],
    clearBySession: () => {},
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("active injection diagnostic privacy", () => {
  it("keeps injected content, identity, hook, cache, and anchor values out of active sinks", async () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const info = vi.spyOn(log, "info").mockImplementation(() => {});
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    const error = vi.spyOn(log, "error").mockImplementation(() => {});

    const registry = new HookRegistryImpl();
    registry.register({
      id: `${PRIVATE_VALUE}-success-hook`,
      point: "system.prefix",
      anchor: { slot: PRIVATE_VALUE, relation: "before" },
      priority: 1,
      description: PRIVATE_VALUE,
      cacheStrategy: "session_init",
      execute: () => [
        { type: "text", content: PRIVATE_VALUE, metadata: { source: PRIVATE_VALUE } },
        {
          type: "custom",
          content: PRIVATE_VALUE,
          metadata: { tool_name: PRIVATE_VALUE, source: PRIVATE_VALUE },
        },
      ],
    });
    registry.register({
      id: `${PRIVATE_VALUE}-error-hook`,
      point: "user.after",
      priority: 2,
      description: PRIVATE_VALUE,
      execute: () => {
        throw new Error(PRIVATE_VALUE, { cause: PRIVATE_VALUE });
      },
    });
    const toolName = `${PRIVATE_VALUE}-tool`;
    const toolDescription = `${PRIVATE_VALUE}-tool-description`;
    registry.register({
      id: `${PRIVATE_VALUE}-tool-hook`,
      point: "tools.append",
      priority: 3,
      description: PRIVATE_VALUE,
      cacheStrategy: PRIVATE_VALUE as CacheStrategy,
      execute: () => [{
        type: "custom",
        content: toolDescription,
        metadata: {
          tool_name: toolName,
          parameters: { type: "object", properties: {} },
        },
      }],
    });

    const profile: AgentProfile = {
      id: PRIVATE_VALUE,
      protocol: "openai",
      detect: () => true,
      parse: (text) => [{
        id: "safe-segment",
        kind: "plain",
        key: "safe-key",
        rawText: text,
        innerText: text,
        index: 0,
      }],
      resolveSlot: () => PRIVATE_VALUE,
      applyAnchor: (segments) => segments,
      rebuild: (segments) => segments.map((segment) => segment.rawText).join(""),
    };
    const repo = cacheRepo({
      put: () => { throw new Error(PRIVATE_VALUE, { cause: PRIVATE_VALUE }); },
    });
    const pipeline = new InjectionPipeline(
      registry,
      new Map([["openai", new OpenAIAdapter()]]),
      {
        hookCacheRepo: repo,
        agentProfiles: new Map([[PRIVATE_VALUE, profile]]),
      },
      new LoggingInjectionObserver(),
    );

    const result = await pipeline.process({
      model: PRIVATE_VALUE,
      messages: [
        { role: "system", content: "safe system" },
        { role: "user", content: "safe user" },
      ],
    }, metadata());

    expect(result.messages).toEqual([
      { role: "system", content: `${PRIVATE_VALUE}\nsafe system` },
      { role: "user", content: "safe user" },
    ]);
    expect(result.tools).toEqual([{
      type: "function",
      function: {
        name: toolName,
        description: toolDescription,
        parameters: { type: "object", properties: {} },
      },
    }]);

    const consoleCalls = [
      ...consoleLog.mock.calls,
      ...consoleWarn.mock.calls,
      ...consoleError.mock.calls,
    ];
    const structuredCalls = [...info.mock.calls, ...warn.mock.calls, ...error.mock.calls];
    expect(containsPrivateValue(consoleCalls)).toBe(false);
    expect(containsPrivateValue(structuredCalls)).toBe(false);
    expect(consoleLog).toHaveBeenCalledWith(
      "[injection] hook_done point=system.prefix blocks=2 cacheStrategy=session_init",
    );
    expect(consoleLog).toHaveBeenCalledWith(
      "[injection] hook_done point=tools.append blocks=1 cacheStrategy=unknown",
    );
    expect(consoleWarn).toHaveBeenCalledWith(
      "[hook-cache] self_heal_failed category=storage_error",
    );
    expect(consoleWarn).toHaveBeenCalledWith(
      "[injection] anchor_unresolved point=system.prefix fallback=true",
    );
    expect(consoleError).toHaveBeenCalledWith(
      "[injection] hook_error point=user.after category=execution_failed",
    );
    expect(info.mock.calls.map((call) => call[0])).toEqual(expect.arrayContaining([
      "injection.pipeline.start",
      "injection.hook.start",
      "injection.hook.done",
      "injection.pipeline.done",
    ]));
    expect(warn).toHaveBeenCalledWith("injection.hook.error", expect.objectContaining({
      point: "user.after",
      category: "hook_error",
    }));
  });

  it("runtime-normalizes direct LoggingInjectionObserver inputs", () => {
    const info = vi.spyOn(log, "info").mockImplementation(() => {});
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    const error = vi.spyOn(log, "error").mockImplementation(() => {});
    const observer = new LoggingInjectionObserver();
    const unsafeMetadata = {
      ...metadata(),
      protocol: PRIVATE_VALUE,
    } as unknown as AgentContextMetadata;
    const unsafePoint = PRIVATE_VALUE as unknown as InjectionPoint;
    const unsafeHook = {
      id: PRIVATE_VALUE,
      point: unsafePoint,
      priority: 1,
      description: PRIVATE_VALUE,
      cacheStrategy: PRIVATE_VALUE,
      execute: () => [],
    } as unknown as InjectionHook;

    observer.onPipelineStart(unsafeMetadata);
    observer.onHookStart(unsafeHook, unsafePoint);
    observer.onHookDone(unsafeHook, unsafePoint, [
      { type: "text", content: PRIVATE_VALUE, metadata: { source: PRIVATE_VALUE } },
      { type: "custom", content: PRIVATE_VALUE, metadata: { tool_name: PRIVATE_VALUE } },
    ], 5, PRIVATE_VALUE);
    observer.onHookError(unsafeHook, unsafePoint, new Error(PRIVATE_VALUE), 6);
    observer.onPipelineError(unsafeMetadata, new Error(PRIVATE_VALUE, { cause: PRIVATE_VALUE }));

    const calls = [...info.mock.calls, ...warn.mock.calls, ...error.mock.calls];
    expect(containsPrivateValue(calls)).toBe(false);
    expect(info).toHaveBeenCalledWith("injection.pipeline.start", {
      protocol: "unknown",
      stream: false,
    });
    expect(info).toHaveBeenCalledWith("injection.hook.done", {
      point: "unknown",
      blockCount: 2,
      textBlockCount: 1,
      customBlockCount: 1,
      otherBlockCount: 0,
      durationMs: 5,
      cacheStrategy: "unknown",
    });
    expect(warn).toHaveBeenCalledWith("injection.hook.error", {
      point: "unknown",
      category: "hook_error",
      durationMs: 6,
    });
    expect(error).toHaveBeenCalledWith("injection.pipeline.error", {
      protocol: "unknown",
      category: "pipeline_error",
    });
  });

  it("keeps prewarm session, hook, and failure values out of console", async () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const registry = new HookRegistryImpl();
    registry.register({
      id: `${PRIVATE_VALUE}-cached-hook`,
      point: "system.prefix",
      priority: 1,
      description: PRIVATE_VALUE,
      cacheStrategy: "session_init",
      prewarm: () => [{ type: "text", content: PRIVATE_VALUE }],
      execute: () => [],
    });
    registry.register({
      id: `${PRIVATE_VALUE}-failed-hook`,
      point: "system.suffix",
      priority: 2,
      description: PRIVATE_VALUE,
      cacheStrategy: "hybrid",
      prewarm: () => { throw new Error(PRIVATE_VALUE, { cause: PRIVATE_VALUE }); },
      execute: () => [],
    });
    const input: PrewarmInput = {
      keyId: PRIVATE_VALUE,
      userId: PRIVATE_VALUE,
      agentSource: PRIVATE_VALUE,
      spaceId: PRIVATE_VALUE,
      sessionInfo: {
        session_id: PRIVATE_VALUE,
        team_id: PRIVATE_VALUE,
        agent_id: PRIVATE_VALUE,
        user_id: PRIVATE_VALUE,
      },
      agentDetail: null,
      taskDetail: null,
    };

    const result = await prewarmAll(registry, cacheRepo(), input, { totalTimeoutMs: 50 });

    const calls = [...consoleLog.mock.calls, ...consoleWarn.mock.calls];
    expect(containsPrivateValue(calls)).toBe(false);
    expect(result.cachedHookIds).toHaveLength(1);
    expect(result.skipped).toHaveLength(1);
    expect(consoleLog).toHaveBeenCalledWith(expect.stringMatching(
      /^\[hook-cache\] prewarm_done cached=1 skipped=1 durationMs=\d+$/,
    ));
  });

  it("reports a fixed category when no hook is eligible for prewarm", async () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const input: PrewarmInput = {
      keyId: PRIVATE_VALUE,
      userId: PRIVATE_VALUE,
      agentSource: PRIVATE_VALUE,
      sessionInfo: {
        session_id: PRIVATE_VALUE,
        team_id: PRIVATE_VALUE,
        agent_id: PRIVATE_VALUE,
        user_id: PRIVATE_VALUE,
      },
      agentDetail: null,
      taskDetail: null,
    };

    const result = await prewarmAll(new HookRegistryImpl(), cacheRepo(), input);

    expect(containsPrivateValue(consoleLog.mock.calls)).toBe(false);
    expect(result.cachedHookIds).toEqual([]);
    expect(consoleLog).toHaveBeenCalledWith(
      "[hook-cache] prewarm_skipped reason=no_eligible_hooks",
    );
  });
});

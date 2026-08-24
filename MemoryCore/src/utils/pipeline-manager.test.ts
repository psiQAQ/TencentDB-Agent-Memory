import { describe, expect, it, vi } from "vitest";

import { MemoryPipelineManager, type PipelineConfig } from "./pipeline-manager.js";

const config: PipelineConfig = {
  everyNConversations: 1,
  enableWarmup: false,
  l1: { idleTimeoutSeconds: 60 },
  l2: {
    delayAfterL1Seconds: 60,
    minIntervalSeconds: 60,
    maxIntervalSeconds: 3600,
    sessionActiveWindowHours: 24,
  },
};

describe("MemoryPipelineManager", () => {
  it("drains buffered L1 through L2 and L3 during shutdown", async () => {
    const shutdownConfig: PipelineConfig = {
      ...config,
      everyNConversations: 10,
    };
    const l1Runs = vi.fn(async () => ({ processedCount: 1 }));
    const l2Runs = vi.fn(async () => ({ latestCursor: "2026-08-19T00:00:00.000Z" }));
    const l3Runs = vi.fn(async () => {});
    const manager = new MemoryPipelineManager(shutdownConfig);

    manager.setL1Runner(l1Runs);
    manager.setL2Runner(l2Runs);
    manager.setL3Runner(l3Runs);

    await manager.notifyConversation("session-buffered", [{
      role: "user",
      content: "Below the normal L1 threshold",
      timestamp: "2026-08-19T00:00:00.000Z",
    }]);

    expect(l1Runs).not.toHaveBeenCalled();
    await manager.destroy();

    expect(l1Runs).toHaveBeenCalledTimes(1);
    expect(l2Runs).toHaveBeenCalledTimes(1);
    expect(l3Runs).toHaveBeenCalledTimes(1);
    expect(manager.getSessionState("session-buffered")?.l2_pending_l1_count).toBe(0);
  });

  it("makes concurrent destroy callers wait for the same drain", async () => {
    let releaseL1!: () => void;
    const l1Finished = new Promise<void>((resolve) => {
      releaseL1 = resolve;
    });
    const manager = new MemoryPipelineManager({ ...config, everyNConversations: 10 });
    manager.setL1Runner(async () => {
      await l1Finished;
      return { processedCount: 1 };
    });
    manager.setL2Runner(async () => ({ skipped: true }));

    await manager.notifyConversation("session-concurrent", [{
      role: "user",
      content: "Pending at shutdown",
      timestamp: "2026-08-19T00:00:00.000Z",
    }]);

    let secondFinished = false;
    const first = manager.destroy();
    const second = manager.destroy().then(() => {
      secondFinished = true;
    });
    await Promise.resolve();
    expect(secondFinished).toBe(false);

    releaseL1();
    await Promise.all([first, second]);
    expect(secondFinished).toBe(true);
  });

  it("drains the L3 cascade produced by a flushed L2 task", async () => {
    const l2Runs = vi.fn();
    const l3Runs = vi.fn();
    let releaseL3!: () => void;
    const l3Finished = new Promise<void>((resolve) => {
      releaseL3 = resolve;
    });
    const manager = new MemoryPipelineManager(config);

    manager.setL1Runner(async () => ({ processedCount: 1 }));
    manager.setL2Runner(async () => {
      l2Runs();
      return { latestCursor: "2026-08-19T00:00:00.000Z" };
    });
    manager.setL3Runner(async () => {
      l3Runs();
      await l3Finished;
    });

    await manager.notifyConversation("session-1", [{
      role: "user",
      content: "A captured message",
      timestamp: "2026-08-19T00:00:00.000Z",
    }]);

    await vi.waitFor(() => {
      expect(manager.getSessionState("session-1")?.l2_pending_l1_count).toBe(1);
    });
    expect(l2Runs).not.toHaveBeenCalled();
    expect(l3Runs).not.toHaveBeenCalled();

    let destroyFinished = false;
    const destroyPromise = manager.destroy().then(() => {
      destroyFinished = true;
    });

    await vi.waitFor(() => {
      expect(l3Runs).toHaveBeenCalledTimes(1);
    });
    expect(destroyFinished).toBe(false);

    releaseL3();
    await destroyPromise;

    expect(l2Runs).toHaveBeenCalledTimes(1);
    expect(l3Runs).toHaveBeenCalledTimes(1);
    expect(manager.getQueueSizes()).toMatchObject({
      l1Idle: true,
      l2Idle: true,
      l3Idle: true,
    });
  });
});

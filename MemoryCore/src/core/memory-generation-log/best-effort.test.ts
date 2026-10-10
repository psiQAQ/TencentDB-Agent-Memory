import { describe, expect, it, vi } from "vitest";
import { writeGenerationProvenanceBestEffort } from "./best-effort.js";

describe("generation provenance", () => {
  it("writes synchronous references after the generation log completes", async () => {
    const order: string[] = [];
    await writeGenerationProvenanceBestEffort({
      layer: "l1",
      writeLog: async () => { await Promise.resolve(); order.push("log"); },
      writeRefs: () => { order.push("refs"); },
    });
    expect(order).toEqual(["log", "refs"]);
  });

  it("reports a synchronous reference failure without failing memory generation", async () => {
    const warn = vi.fn();
    await expect(writeGenerationProvenanceBestEffort({
      layer: "l2", logger: { info: vi.fn(), warn, error: vi.fn() },
      writeLog: async () => {},
      writeRefs: () => { throw new Error("reference write failed"); },
    })).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("l2 reference write failed"));
  });

  it("does not write references when the generation log cannot be stored", async () => {
    const writeRefs = vi.fn();
    await writeGenerationProvenanceBestEffort({
      layer: "l3", writeRefs,
      writeLog: async () => { throw new Error("log write failed"); },
    });
    expect(writeRefs).not.toHaveBeenCalled();
  });
});

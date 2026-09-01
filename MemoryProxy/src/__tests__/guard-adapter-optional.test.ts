import { describe, expect, it } from "vitest";

import { isUsableCostGuardModule } from "../guard-adapter.js";

describe("optional cost-guard package", () => {
  it("rejects the public-build stub when it has no CostGuard class", () => {
    expect(isUsableCostGuardModule({ CostGuard: undefined })).toBe(false);
  });

  it("accepts a module that exports a CostGuard class", () => {
    expect(isUsableCostGuardModule({ CostGuard: class CostGuard {} })).toBe(true);
  });
});

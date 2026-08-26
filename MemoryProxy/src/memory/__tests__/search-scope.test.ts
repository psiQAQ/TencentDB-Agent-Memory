import { describe, expect, it } from "vitest";

import { taskIdForSearchTarget } from "../search-scope.js";

describe("taskIdForSearchTarget", () => {
  it("keeps the caller task when searching self memory", () => {
    expect(taskIdForSearchTarget(true, undefined, "task-reader")).toBe("task-reader");
  });

  it("does not apply the reader task to imported Agent memory", () => {
    expect(taskIdForSearchTarget(false, undefined, "task-reader")).toBeUndefined();
  });

  it("honors an explicit task when intentionally narrowing an imported Agent", () => {
    expect(taskIdForSearchTarget(false, "task-writer", "task-reader")).toBe("task-writer");
  });
});

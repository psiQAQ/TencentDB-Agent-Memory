import { describe, expect, it, vi } from "vitest";
import { handleDelete, handleUpdate, type SkillRouterDeps } from "./skill-handlers.js";

describe("locked Skill writes", () => {
  it("forwards the requested deletion version to SkillCore", async () => {
    const remove = vi.fn().mockResolvedValue({ skill_id: "skl-1", archived: true });
    const deps = {
      getSkillCore: () => ({ delete: remove }),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as unknown as SkillRouterDeps;
    const result = await handleDelete({ skill_id: "skl-1", expected_version: 2 },
      { apiKey: "gateway", serviceId: "default" }, "versioned-delete", deps);
    expect(result.code).toBe(0);
    expect(remove).toHaveBeenCalledWith({ skill_id: "skl-1", expected_version: 2 });
  });

  it("rejects deletion and content updates before invoking SkillCore", async () => {
    const remove = vi.fn();
    const update = vi.fn();
    const deps = {
      getSkillCore: () => ({ delete: remove, update }),
      getMetadataService: async () => ({
        getAssetById: async () => ({
          asset_type: "skill", metadata_json: JSON.stringify({ skill_lock: { locked: true } }),
        }),
      }),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as unknown as SkillRouterDeps;
    const auth = { apiKey: "gateway", serviceId: "default" };
    const deleted = await handleDelete({ skill_id: "skl-1", team_id: "team-1" }, auth, "r1", deps);
    const edited = await handleUpdate({
      skill_id: "skl-1", team_id: "team-1", expected_version: 1, content: "edited",
    }, auth, "r2", deps);
    expect(deleted).toMatchObject({ code: 42301, message: "SKILL_LOCKED" });
    expect(edited).toMatchObject({ code: 42301, message: "SKILL_LOCKED" });
    expect(remove).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });
});

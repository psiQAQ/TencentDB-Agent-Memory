import { describe, expect, it, vi } from "vitest";
import { SkillCore, type SkillCoreOptions } from "./skill-core.js";

describe("Skill delete version compatibility", () => {
  it.each([undefined, 2, 1])("accepts upstream callers and validates an optional governance version: %s", async (expected_version) => {
    const deleteSkill = vi.fn().mockResolvedValue(2);
    const core = new SkillCore({
      store: { getHeadIncludingArchived: async () => ({ skill_id: "skill", team_id: "team", owner_agent_id: "agent", version: 2 }) },
      resources: {}, versioning: { deleteSkill },
    } as unknown as SkillCoreOptions);
    const result = core.delete({ skill_id: "skill", team_id: "team", agent_id: "agent", expected_version });
    if (expected_version === 1) {
      await expect(result).rejects.toMatchObject({ code: "SKILL_VERSION_STALE" });
      expect(deleteSkill).not.toHaveBeenCalled();
    } else {
      await expect(result).resolves.toEqual({ skill_id: "skill", archived: true });
      expect(deleteSkill).toHaveBeenCalledWith("skill", "team");
    }
  });
});

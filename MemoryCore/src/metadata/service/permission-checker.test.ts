import { describe, expect, it } from "vitest";
import { canReadTeamMembersGlobally } from "./permission-checker.js";

describe("team member read scope", () => {
  it("allows only system_admin to read member roles without joining the Team", () => {
    expect(canReadTeamMembersGlobally(true)).toBe(true);
    expect(canReadTeamMembersGlobally(false)).toBe(false);
  });
});

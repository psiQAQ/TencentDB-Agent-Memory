import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const apiKeyPage = readFileSync(
  new URL(
    "../web/src/pages/ApiKeysPage/components/ApiKeyPanel.tsx",
    import.meta.url,
  ),
  "utf8",
);
const usersPage = readFileSync(
  new URL("../web/src/pages/UsersPage/index.tsx", import.meta.url),
  "utf8",
);

describe("API Key management placement", () => {
  it("keeps the standalone API Key page self-only for every account type", () => {
    expect(apiKeyPage).toContain("const ownKeys = await userKeysApi.list();");
    expect(apiKeyPage).toContain("const key = await userKeysApi.create({");
    expect(apiKeyPage).not.toContain("loadSystemAdminApiKeyInventory");
    expect(apiKeyPage).not.toContain("filterTeamId");
    expect(apiKeyPage).not.toContain("user_id: auth");
  });

  it("puts global inventory, Team filtering, and expandable Key rows in User Management", () => {
    expect(usersPage).toContain("loadSystemAdminApiKeyInventory");
    expect(usersPage).toContain(
      "filterApiKeySubjects(subjects, filterTeamId, keyword)",
    );
    expect(usersPage).toContain("expandable({");
    expect(usersPage).toContain("header: t('users.column.teams')");
    expect(usersPage).toContain("<UserKeysTable");
    expect(usersPage).toContain("user_id: user.user_id");
  });
});

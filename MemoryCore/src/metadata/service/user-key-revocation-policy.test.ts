import { describe, expect, it } from "vitest";
import { getUserKeyRevocationBlockReason } from "./user-key-revocation-policy.js";

describe("user Key revocation policy", () => {
  it("lets system_admin revoke another normal user's last active Key", () => {
    expect(
      getUserKeyRevocationBlockReason({
        ownerUserId: "normal-user",
        ownerUserType: "normal",
        isDefaultKey: true,
        activeKeyCount: 1,
        callerUserId: "system-admin",
        callerIsSystemAdmin: true,
      }),
    ).toBeNull();
  });

  it("protects a normal user's own last active Key", () => {
    expect(
      getUserKeyRevocationBlockReason({
        ownerUserId: "normal-user",
        ownerUserType: "normal",
        isDefaultKey: true,
        activeKeyCount: 1,
        callerUserId: "normal-user",
        callerIsSystemAdmin: false,
      }),
    ).toBe("last_active_key");
  });

  it("allows a normal user to revoke one of multiple active Keys", () => {
    expect(
      getUserKeyRevocationBlockReason({
        ownerUserId: "normal-user",
        ownerUserType: "normal",
        isDefaultKey: true,
        activeKeyCount: 2,
        callerUserId: "normal-user",
        callerIsSystemAdmin: false,
      }),
    ).toBeNull();
  });

  it("protects only the bootstrap system_admin Key", () => {
    expect(
      getUserKeyRevocationBlockReason({
        ownerUserId: "system-admin",
        ownerUserType: "system_admin",
        isDefaultKey: true,
        activeKeyCount: 2,
        callerUserId: "system-admin",
        callerIsSystemAdmin: true,
      }),
    ).toBe("bootstrap_admin_key");
    expect(
      getUserKeyRevocationBlockReason({
        ownerUserId: "system-admin",
        ownerUserType: "system_admin",
        isDefaultKey: false,
        activeKeyCount: 1,
        callerUserId: "system-admin",
        callerIsSystemAdmin: true,
      }),
    ).toBeNull();
  });
});

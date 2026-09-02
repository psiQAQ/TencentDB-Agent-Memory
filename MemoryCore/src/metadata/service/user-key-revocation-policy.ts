import type { UserType } from "../types.js";

export type UserKeyRevocationBlockReason =
  | "system_admin_key"
  | "last_active_key"
  | null;

export interface UserKeyRevocationPolicyInput {
  ownerUserId: string;
  ownerUserType: UserType;
  activeKeyCount: number;
  callerUserId?: string;
  callerIsSystemAdmin: boolean;
}

/**
 * system_admin Key 永不允许吊销。普通用户自行操作时保留最后一把有效 Key；
 * 另一个 system_admin 可吊销普通用户的最后一把 Key，以显式禁用该用户。
 */
export function getUserKeyRevocationBlockReason(
  input: UserKeyRevocationPolicyInput,
): UserKeyRevocationBlockReason {
  if (input.ownerUserType === "system_admin") return "system_admin_key";
  const systemAdminManagingAnotherUser =
    input.callerIsSystemAdmin && input.callerUserId !== input.ownerUserId;
  if (input.activeKeyCount <= 1 && !systemAdminManagingAnotherUser) {
    return "last_active_key";
  }
  return null;
}

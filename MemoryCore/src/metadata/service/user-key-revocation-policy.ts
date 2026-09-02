import type { UserType } from "../types.js";

export type UserKeyRevocationBlockReason =
  | "bootstrap_admin_key"
  | "last_active_key"
  | null;

export interface UserKeyRevocationPolicyInput {
  ownerUserId: string;
  ownerUserType: UserType;
  isDefaultKey: boolean;
  activeKeyCount: number;
  callerUserId?: string;
  callerIsSystemAdmin: boolean;
}

/**
 * init-admin 生成的 system_admin 默认 Key 对应部署持久化的 `.admin-key`，必须保留。
 * 其他 system_admin Key 可吊销；普通用户自行操作时保留最后一把有效 Key，
 * 另一个 system_admin 可吊销普通用户的最后一把 Key，以显式禁用该用户。
 */
export function getUserKeyRevocationBlockReason(
  input: UserKeyRevocationPolicyInput,
): UserKeyRevocationBlockReason {
  if (input.ownerUserType === "system_admin") {
    return input.isDefaultKey ? "bootstrap_admin_key" : null;
  }
  const systemAdminManagingAnotherUser =
    input.callerIsSystemAdmin && input.callerUserId !== input.ownerUserId;
  if (input.activeKeyCount <= 1 && !systemAdminManagingAnotherUser) {
    return "last_active_key";
  }
  return null;
}

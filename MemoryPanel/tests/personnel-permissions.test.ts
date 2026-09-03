import { describe, expect, it } from 'vitest';
import {
  canManageOwnedResource,
  canRemoveMember,
  roleInTeam,
  type TeamRoleView,
} from '../web/src/services/team-role.js';

function team(): TeamRoleView {
  return {
    owner_user_id: 'owner',
    members: [
      { user_id: 'team-admin', role: 'admin' },
      { user_id: 'system-admin', role: 'member' },
      { user_id: 'member', role: 'member' },
    ],
  };
}

describe('Panel account type and Team role separation', () => {
  it('derives only the actual Team role and treats a missing owner row as admin', () => {
    const value = team();
    expect(roleInTeam(value, 'system-admin')).toBe('member');
    expect(roleInTeam(value, 'outsider')).toBeNull();
    expect(roleInTeam(value, 'owner')).toBe('admin');
  });

  it('allows only Team owner/admin to remove another non-owner member', () => {
    const value = team();
    expect(canRemoveMember(value, 'member', 'team-admin')).toBe(true);
    expect(canRemoveMember(value, 'owner', 'team-admin')).toBe(false);
    expect(canRemoveMember(value, 'team-admin', 'team-admin')).toBe(false);
    expect(canRemoveMember(value, 'member', 'system-admin')).toBe(false);
  });

  it('does not let Team or system administrators mutate another owner resource', () => {
    expect(canManageOwnedResource('member', 'member')).toBe(true);
    expect(canManageOwnedResource('member', 'team-admin')).toBe(false);
    expect(canManageOwnedResource('member', 'system-admin')).toBe(false);
  });
});

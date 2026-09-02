import { useAuthStore } from '@/stores/auth';
import TeamManagementPanel from '@/components/team/TeamManagementPanel';

export function MembersPage() {
  const { auth } = useAuthStore();
  if (!auth) return null;

  return (
    <TeamManagementPanel
      currentUser={auth.user_id}
      section="members"
    />
  );
}

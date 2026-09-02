import { useAuthStore } from '@/stores/auth';
import TeamManagementPanel from '@/components/team/TeamManagementPanel';

export function AgentsPage() {
  const { auth } = useAuthStore();
  if (!auth) return null;

  return (
    <TeamManagementPanel
      currentUser={auth.user_id}
      instanceId={auth.instance_id}
      isAdmin={auth.isAdmin === true}
      section="agents"
    />
  );
}

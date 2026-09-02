import { ResourcePage } from '@/pages/ResourcePage';
import SkillsPanel from './components/SkillsPanel';
import { useAuthStore } from '@/stores/auth';

export function SkillsPage() {
  const { auth } = useAuthStore();
  if (!auth) return null;

  return (
    <ResourcePage>
      <SkillsPanel currentUser={auth.user_id} isAdmin={auth.isAdmin === true} />
    </ResourcePage>
  );
}

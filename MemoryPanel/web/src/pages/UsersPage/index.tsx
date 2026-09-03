/** system_admin 的全局账号管理；Team 角色仍在各 Team 的成员管理中自治。 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Form,
  H3,
  Input,
  Justify,
  Modal,
  SearchBox,
  Switch,
  Table,
  Tag,
  Text,
} from 'tea-component';
import { AddIcon } from 'tea-icons-react';
import { useTranslation } from 'react-i18next';
import {
  ApiError,
  usersApi,
  type OwnedResourceDependency,
  type PublicUser,
  type UserDependencies,
} from '@/lib/teamApi';
import { useAuthStore } from '@/stores/auth';
import { tea } from '@/lib/tea-bridge';
import { getErrorMessage } from '@/lib/error-message';
import { CreatedUserKeyModal } from '@/components/team/MemberSection';
import './users-page.css';

const { autotip } = Table.addons;

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
}

export function UsersPage() {
  const { t } = useTranslation();
  const { auth } = useAuthStore();
  const [users, setUsers] = useState<PublicUser[]>([]);
  const [keyword, setKeyword] = useState('');
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [detail, setDetail] = useState<{ user: PublicUser; dependencies: UserDependencies } | null>(null);
  const [fresh, setFresh] = useState<{ username: string; userId: string; keyValue: string } | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setUsers(await usersApi.list());
    } catch (err) {
      tea.notify.error(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const visibleUsers = useMemo(() => {
    const q = keyword.trim().toLocaleLowerCase();
    if (!q) return users;
    return users.filter((user) =>
      [user.user_id, user.username, user.user_type]
        .some((value) => value.toLocaleLowerCase().includes(q)),
    );
  }, [keyword, users]);

  async function showDetail(userId: string) {
    try {
      const [user, dependencies] = await Promise.all([
        usersApi.get(userId),
        usersApi.dependenciesAll(userId),
      ]);
      setDetail({ user, dependencies });
    } catch (err) {
      tea.notify.error(getErrorMessage(err));
    }
  }

  async function deleteUser(user: PublicUser) {
    let dependencies: UserDependencies;
    try {
      dependencies = await usersApi.dependenciesAll(user.user_id);
    } catch (err) {
      tea.notify.error(getErrorMessage(err));
      return;
    }
    if (dependencies.counts.total > 0) {
      setDetail({ user, dependencies });
      return;
    }
    const ok = await tea.confirm({
      message: t('users.delete.confirm', { username: user.username }),
      description: t('users.delete.desc', { userId: user.user_id }),
      okText: t('common.delete'),
    });
    if (!ok) return;
    try {
      await usersApi.delete(user.user_id);
      await refresh();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && err.data) {
        try {
          setDetail({ user, dependencies: await usersApi.dependenciesAll(user.user_id) });
        } catch (refreshErr) {
          tea.notify.error(getErrorMessage(refreshErr));
        }
      } else {
        tea.notify.error(getErrorMessage(err));
      }
    }
  }

  return (
    <div className="_memory-users-page">
      <Justify
        left={
          <div>
            <H3>{t('users.title')}</H3>
            <Text theme="text" parent="div" style={{ marginTop: 4 }}>{t('users.desc')}</Text>
          </div>
        }
        right={
          <Button type="primary" onClick={() => setCreateOpen(true)} data-guide="create-user">
            <AddIcon size={14} /> {t('users.create')}
          </Button>
        }
      />

      <Card>
        <Card.Body>
          <Table.ActionPanel>
            <Justify
              left={<Text theme="weak">{t('users.total', { count: visibleUsers.length })}</Text>}
              right={<SearchBox value={keyword} onChange={setKeyword} placeholder={t('users.search')} />}
            />
          </Table.ActionPanel>
          <Table
            records={visibleUsers}
            recordKey="user_id"
            addons={[autotip({ isLoading: loading })]}
            columns={[
              {
                key: 'username',
                header: t('users.column.username'),
                render: (user: PublicUser) => <Text theme="strong">{user.username}</Text>,
              },
              {
                key: 'user_id',
                header: 'user_id',
                render: (user: PublicUser) => <code>{user.user_id}</code>,
              },
              {
                key: 'user_type',
                header: t('users.column.type'),
                render: (user: PublicUser) => (
                  <Tag theme={user.user_type === 'system_admin' ? 'primary' : 'default'} variant="soft">
                    {user.user_type}
                  </Tag>
                ),
              },
              {
                key: 'created_at',
                header: t('users.column.createdAt'),
                render: (user: PublicUser) => formatTime(user.created_at),
              },
              {
                key: 'actions',
                header: t('users.column.actions'),
                width: 180,
                render: (user: PublicUser) => (
                  <div className="_memory-users-actions">
                    <Button type="link" onClick={() => void showDetail(user.user_id)}>{t('users.detail')}</Button>
                    <Button
                      type="link"
                      disabled={user.user_type === 'system_admin' || user.user_id === auth?.user_id}
                      title={user.user_type === 'system_admin' ? t('users.delete.systemAdminLocked') : undefined}
                      onClick={() => void deleteUser(user)}
                    >
                      {t('common.delete')}
                    </Button>
                  </div>
                ),
              },
            ]}
          />
        </Card.Body>
      </Card>

      {createOpen && (
        <CreateUserDialog
          onClose={() => setCreateOpen(false)}
          onCreated={(info) => {
            setCreateOpen(false);
            setFresh(info);
            void refresh();
          }}
        />
      )}
      {fresh && <CreatedUserKeyModal info={fresh} onClose={() => setFresh(null)} />}
      {detail && (
        <UserDetailModal
          user={detail.user}
          dependencies={detail.dependencies}
          onClose={() => setDetail(null)}
        />
      )}
    </div>
  );
}

function CreateUserDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (info: { username: string; userId: string; keyValue: string }) => void;
}) {
  const { t } = useTranslation();
  const [username, setUsername] = useState('');
  const [customKeyEnabled, setCustomKeyEnabled] = useState(false);
  const [customKey, setCustomKey] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    const name = username.trim();
    if (!name) return;
    if (!/^[A-Za-z0-9_]+$/.test(name)) {
      setError(t('users.create.invalidUsername'));
      return;
    }
    if (customKeyEnabled && !customKey.trim()) {
      setError(t('users.create.emptyKey'));
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const created = customKeyEnabled
        ? await usersApi.createWithKey({ username: name, user_key: customKey.trim() })
        : await usersApi.create({ username: name, auth_provider: 'api_key', external_id: name });
      onCreated({ username: name, userId: created.user_id, keyValue: created.default_user_key });
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal visible caption={t('users.create.caption')} size="m" onClose={onClose} disableEscape={submitting}>
      <Modal.Body>
        <Alert type="info">{t('users.create.typeFixed')}</Alert>
        <Form>
          <Form.Item label={t('users.column.username')} required>
            <Input
              autoFocus
              size="full"
              value={username}
              onChange={(value) => { setUsername(value); setError(null); }}
              onPressEnter={() => void submit()}
              placeholder={t('users.create.usernamePlaceholder')}
            />
          </Form.Item>
          <Form.Item label={t('users.create.customKey')}>
            <div>
              <Switch
                value={customKeyEnabled}
                onChange={(value) => { setCustomKeyEnabled(value); setError(null); }}
              />
              <div className="_memory-users-hint">{t('users.create.customKeyHint')}</div>
            </div>
          </Form.Item>
          {customKeyEnabled && (
            <Form.Item label="User_Key" required>
              <Input.Password
                size="full"
                value={customKey}
                onChange={(value) => { setCustomKey(value); setError(null); }}
                placeholder="sk-mem-…"
              />
            </Form.Item>
          )}
          {error && <Form.Item><Alert type="error">{error}</Alert></Form.Item>}
        </Form>
      </Modal.Body>
      <Modal.Footer>
        <Button
          type="primary"
          loading={submitting}
          disabled={!username.trim() || submitting || (customKeyEnabled && !customKey.trim())}
          onClick={() => void submit()}
        >
          {t('users.create.submit')}
        </Button>
        <Button disabled={submitting} onClick={onClose}>{t('addMember.cancel')}</Button>
      </Modal.Footer>
    </Modal>
  );
}

function UserDetailModal({
  user,
  dependencies,
  onClose,
}: {
  user: PublicUser;
  dependencies: UserDependencies;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Modal visible caption={t('users.detail.caption')} size="l" onClose={onClose}>
      <Modal.Body>
        <Form>
          <Form.Item label={t('users.column.username')}><Input value={user.username} readonly size="full" /></Form.Item>
          <Form.Item label="user_id"><Input value={user.user_id} readonly size="full" /></Form.Item>
          <Form.Item label={t('users.column.type')}><Input value={user.user_type} readonly size="full" /></Form.Item>
          <Form.Item label={t('users.column.createdAt')}><Input value={formatTime(user.created_at)} readonly size="full" /></Form.Item>
        </Form>
        <div style={{ marginTop: 16 }}>
          <H3>{t('users.dependencies.title')}</H3>
          <Text theme="weak" parent="div" style={{ marginTop: 4 }}>
            {t('users.dependencies.counts', dependencies.counts)}
          </Text>
          {dependencies.counts.total > 0 && (
            <Alert type="warning" style={{ marginTop: 12 }}>
              {t('users.dependencies.blockedWorkflow')}
            </Alert>
          )}
          <UserDependencyList items={dependencies.items} />
        </div>
      </Modal.Body>
      <Modal.Footer><Button type="primary" onClick={onClose}>{t('header.profile.close')}</Button></Modal.Footer>
    </Modal>
  );
}

function UserDependencyList({ items }: { items: OwnedResourceDependency[] }) {
  const { t } = useTranslation();
  if (items.length === 0) return <Alert type="success">{t('users.dependencies.empty')}</Alert>;
  return (
    <div style={{ marginTop: 12, maxHeight: 360, overflow: 'auto' }}>
      {items.map((item) => (
        <div key={`${item.resource_type}:${item.resource_id}`} style={{ padding: '9px 0', borderBottom: '1px solid var(--tea-color-border-secondary)' }}>
          <div>
            <Tag size="sm">{item.resource_type}</Tag>{' '}
            <strong>{item.name || item.resource_id}</strong>{' '}
            <Tag size="sm" theme={item.membership_status === 'absent' ? 'error' : 'default'}>
              {item.membership_status === 'absent' ? t('users.dependencies.orphan') : item.membership_status}
            </Tag>
          </div>
          <div style={{ marginTop: 4, color: 'var(--tea-color-text-secondary)' }}>
            <code>{item.resource_id}</code> · {item.team_name || item.team_id} · {item.status}
          </div>
        </div>
      ))}
    </div>
  );
}

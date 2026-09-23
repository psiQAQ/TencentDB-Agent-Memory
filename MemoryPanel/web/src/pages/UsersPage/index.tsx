/** system_admin 的全局账号管理；Team 角色仍在各 Team 的成员管理中自治。 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Moment } from 'moment';
import moment from 'moment';
import {
  Alert,
  Button,
  Card,
  DatePicker,
  Form,
  H3,
  Input,
  Justify,
  Modal,
  SearchBox,
  Select,
  Switch,
  Table,
  Tag,
  Text,
} from 'tea-component';
import { AddIcon } from 'tea-icons-react';
import { useTranslation } from 'react-i18next';
import {
  ApiError,
  membersApi,
  teamsApi,
  userKeysApi,
  usersApi,
  type OwnedResourceDependency,
  type PublicUser,
  type UserDependencies,
} from '@/lib/teamApi';
import { useAuthStore } from '@/stores/auth';
import { tea } from '@/lib/tea-bridge';
import { getErrorMessage } from '@/lib/error-message';
import {
  filterApiKeySubjects,
  getKeyRevokeBlockReason,
  getPrivilegedMemberships,
  loadSystemAdminApiKeyInventory,
  type ApiKeySubject,
  type ApiKeyTeamRole,
  type ManagedUserKey,
} from '@/pages/ApiKeysPage/api-key-inventory';
import './users-page.css';

const { autotip, expandable } = Table.addons;

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
}

export function UsersPage() {
  const { t } = useTranslation();
  const { auth } = useAuthStore();
  const [users, setUsers] = useState<PublicUser[]>([]);
  const [subjects, setSubjects] = useState<ApiKeySubject[]>([]);
  const [keys, setKeys] = useState<ManagedUserKey[]>([]);
  const [copyingKeyId, setCopyingKeyId] = useState<string | null>(null);
  const [keyword, setKeyword] = useState('');
  const [filterTeamId, setFilterTeamId] = useState('*');
  const [expandedUserIds, setExpandedUserIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [createKeyFor, setCreateKeyFor] = useState<PublicUser | null>(null);
  const [detail, setDetail] = useState<{ user: PublicUser; dependencies: UserDependencies } | null>(
    null,
  );

  const refresh = useCallback(async () => {
    if (!auth?.user_id) return;
    setLoading(true);
    try {
      const inventory = await loadSystemAdminApiKeyInventory(auth.user_id, {
        listUsers: usersApi.list,
        listTeamsForUser: teamsApi.listForUser,
        listMembersForTeam: membersApi.list,
        listKeysForUser: userKeysApi.list,
      });
      setUsers(inventory.users);
      setSubjects(inventory.subjects);
      setKeys(inventory.keys);
      setFilterTeamId((current) =>
        current === '*' ||
        inventory.subjects.some((subject) => subject.teams.some((team) => team.teamId === current))
          ? current
          : '*',
      );
      setExpandedUserIds((current) =>
        current.filter((userId) => inventory.users.some((user) => user.user_id === userId)),
      );
    } catch (err) {
      tea.notify.error(getErrorMessage(err));
      setUsers([]);
      setSubjects([]);
      setKeys([]);
    } finally {
      setLoading(false);
    }
  }, [auth?.user_id]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const visibleUsers = useMemo(() => {
    const visibleIds = new Set(
      filterApiKeySubjects(subjects, filterTeamId, keyword).map((subject) => subject.userId),
    );
    return users.filter((user) => visibleIds.has(user.user_id));
  }, [filterTeamId, keyword, subjects, users]);

  const allTeams = useMemo(
    () =>
      [
        ...new Map(
          subjects.flatMap((subject) => subject.teams).map((team) => [team.teamId, team]),
        ).values(),
      ].sort((a, b) => a.teamName.localeCompare(b.teamName)),
    [subjects],
  );

  const subjectByUserId = useMemo(
    () => new Map(subjects.map((subject) => [subject.userId, subject])),
    [subjects],
  );

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

  async function revokeKey(key: ManagedUserKey) {
    const blockReason = getKeyRevokeBlockReason(key, keys, {
      callerUserId: auth?.user_id,
      callerIsSystemAdmin: true,
    });
    if (blockReason) {
      tea.notify.warning(t(`apiKey.revoke.disabled.${blockReason}`));
      return;
    }
    const ownerKeys = keys.filter((candidate) => candidate.ownerUserId === key.ownerUserId);
    const privilegedMemberships = getPrivilegedMemberships(key);
    const roleLabel = (role: ApiKeyTeamRole) => t(`apiKey.role.${role}`);
    const managedTeams = privilegedMemberships
      .map(
        (team) =>
          `${team.teamName} (${team.roles
            .filter((role) => role === 'owner' || role === 'admin')
            .map(roleLabel)
            .join(', ')})`,
      )
      .join('；');
    const ok = await tea.confirm({
      message: t('apiKey.confirm.revoke', { name: key.key_prefix || key.key_id }),
      description: privilegedMemberships.length
        ? t(
            ownerKeys.length === 1
              ? 'apiKey.confirm.revoke.privilegedLast.desc'
              : 'apiKey.confirm.revoke.privileged.desc',
            { teams: managedTeams },
          )
        : t(
            ownerKeys.length === 1
              ? 'apiKey.confirm.revoke.last.desc'
              : 'apiKey.confirm.revoke.desc',
          ),
      okText: t('apiKey.confirm.revoke.ok'),
    });
    if (!ok) return;
    try {
      await userKeysApi.revoke(key.key_id);
      await refresh();
    } catch (err) {
      tea.notify.error(getErrorMessage(err));
    }
  }

  async function copyKey(key: ManagedUserKey) {
    setCopyingKeyId(key.key_id);
    try {
      const revealed = await userKeysApi.reveal(key.key_id);
      if (revealed.key_id !== key.key_id || !revealed.key_value) {
        throw new Error(t('apiKey.copy.invalidResponse'));
      }
      if (!navigator.clipboard?.writeText) {
        throw new Error(t('apiKey.copy.unavailable'));
      }
      await navigator.clipboard.writeText(revealed.key_value);
      tea.notify.success(t('apiKey.copy.success'));
    } catch (err) {
      tea.notify.error(getErrorMessage(err));
    } finally {
      setCopyingKeyId(null);
    }
  }

  return (
    <div className="_memory-users-page">
      <Justify
        left={
          <div>
            <H3>{t('users.title')}</H3>
            <Text theme="text" parent="div" style={{ marginTop: 4 }}>
              {t('users.desc')}
            </Text>
          </div>
        }
        right={
          <Button type="primary" onClick={() => setCreateOpen(true)} data-guide="create-user">
            <AddIcon size={14} /> {t('users.create')}
          </Button>
        }
      />

      <Card>
        <Card.Body title={t('apiKey.scope.title')}>
          <div className="_memory-users-scope-filters">
            <div className="_memory-users-scope-field">
              <Text theme="label" parent="label">
                {t('apiKey.scope.team')}
              </Text>
              <Select
                size="full"
                searchable
                value={filterTeamId}
                onChange={(teamId) => {
                  setFilterTeamId(teamId);
                  setKeyword('');
                }}
                options={[
                  { value: '*', text: t('apiKey.scope.allTeams') },
                  ...allTeams.map((team) => ({ value: team.teamId, text: team.teamName })),
                ]}
              />
            </div>
            <div className="_memory-users-scope-field">
              <Text theme="label" parent="label">
                {t('apiKey.scope.member')}
              </Text>
              <SearchBox
                value={keyword}
                onChange={setKeyword}
                placeholder={t('apiKey.scope.member.placeholder')}
              />
            </div>
          </div>
        </Card.Body>
      </Card>

      <Card>
        <Card.Body>
          <Table.ActionPanel>
            <Justify
              left={<Text theme="weak">{t('users.total', { count: visibleUsers.length })}</Text>}
            />
          </Table.ActionPanel>
          <Table
            records={visibleUsers}
            recordKey="user_id"
            addons={[
              expandable({
                expandedKeys: expandedUserIds,
                onExpandedKeysChange: setExpandedUserIds,
                render: (user: PublicUser) => (
                  <UserKeysTable
                    user={user}
                    keys={keys.filter((key) => key.ownerUserId === user.user_id)}
                    allKeys={keys}
                    onCreate={() => setCreateKeyFor(user)}
                    onCopy={(key) => void copyKey(key)}
                    copyingKeyId={copyingKeyId}
                    onRevoke={(key) => void revokeKey(key)}
                  />
                ),
              }),
              autotip({ isLoading: loading }),
            ]}
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
                key: 'teams',
                header: t('users.column.teams'),
                render: (user: PublicUser) => {
                  const teams = subjectByUserId.get(user.user_id)?.teams ?? [];
                  return teams.length ? (
                    <div className="_memory-users-team-list">
                      {teams.map((team) => (
                        <div key={team.teamId} className="_memory-users-team-line">
                          <span>{team.teamName}</span>{' '}
                          <Text theme="weak">
                            ({team.roles.map((role) => t(`apiKey.role.${role}`)).join(', ')})
                          </Text>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <Text theme="weak">{t('apiKey.noTeam')}</Text>
                  );
                },
              },
              {
                key: 'user_type',
                header: t('users.column.type'),
                render: (user: PublicUser) => (
                  <Tag
                    theme={user.user_type === 'system_admin' ? 'primary' : 'default'}
                    variant="soft"
                  >
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
                    <Button type="link" onClick={() => void showDetail(user.user_id)}>
                      {t('users.detail')}
                    </Button>
                    <Button
                      type="link"
                      disabled={user.user_type === 'system_admin' || user.user_id === auth?.user_id}
                      title={
                        user.user_type === 'system_admin'
                          ? t('users.delete.systemAdminLocked')
                          : undefined
                      }
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
            setExpandedUserIds((current) => [...new Set([...current, info.userId])]);
            tea.notify.success(t('users.create.success', { username: info.username }));
            void refresh();
          }}
        />
      )}
      {createKeyFor && (
        <CreateManagedKeyDialog
          user={createKeyFor}
          onClose={() => setCreateKeyFor(null)}
          onCreated={() => {
            const user = createKeyFor;
            setCreateKeyFor(null);
            setExpandedUserIds((current) => [...new Set([...current, user.user_id])]);
            tea.notify.success(t('users.keys.createdSuccess', { username: user.username, userId: user.user_id }));
            void refresh();
          }}
        />
      )}
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

function UserKeysTable({
  user,
  keys,
  allKeys,
  onCreate,
  onCopy,
  copyingKeyId,
  onRevoke,
}: {
  user: PublicUser;
  keys: ManagedUserKey[];
  allKeys: ManagedUserKey[];
  onCreate: () => void;
  onCopy: (key: ManagedUserKey) => void;
  copyingKeyId: string | null;
  onRevoke: (key: ManagedUserKey) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="_memory-users-key-panel">
      <Justify
        left={
          <Text theme="weak">
            {t('users.keys.total', { username: user.username, count: keys.length })}
          </Text>
        }
        right={
          <Button onClick={onCreate}>
            <AddIcon size={14} /> {t('apiKey.create')}
          </Button>
        }
      />
      <div className="_memory-users-key-table-scroll">
        <Table
          verticalTop
          records={keys}
          recordKey="key_id"
          columns={[
            {
              key: 'name',
              header: t('apiKey.table.name'),
              width: '18%',
              render: (key: ManagedUserKey) =>
                key.name ? <Text>{key.name}</Text> : <Text theme="weak">{t('apiKey.noName')}</Text>,
            },
            {
              key: 'key_id',
              header: t('apiKey.table.keyId'),
              width: '23%',
              render: (key: ManagedUserKey) => (
                <Text parent="code" copyable className="_memory-users-key-code">
                  {key.key_id}
                </Text>
              ),
            },
            {
              key: 'key_prefix',
              header: t('apiKey.table.keyPrefix'),
              width: '15%',
              render: (key: ManagedUserKey) => <code>{key.key_prefix || '—'}</code>,
            },
            {
              key: 'created_at',
              header: t('apiKey.table.createdAt'),
              width: '14%',
              render: (key: ManagedUserKey) => formatTime(key.created_at ?? ''),
            },
            {
              key: 'expires_at',
              header: t('apiKey.table.expiresAt'),
              width: '14%',
              render: (key: ManagedUserKey) =>
                key.expires_at ? (
                  formatTime(key.expires_at)
                ) : (
                  <Text theme="weak">{t('apiKey.neverExpire')}</Text>
                ),
            },
            {
              key: 'actions',
              header: t('apiKey.table.actions'),
              width: '16%',
              align: 'right',
              render: (key: ManagedUserKey) => {
                const blockReason = getKeyRevokeBlockReason(key, allKeys, {
                  callerIsSystemAdmin: true,
                });
                return (
                  <span className="_memory-users-key-actions">
                    <Button
                      type="text"
                      disabled={copyingKeyId === key.key_id}
                      onClick={() => onCopy(key)}
                    >
                      {t('createdUserKey.copy')}
                    </Button>
                    <span title={blockReason ? t(`apiKey.revoke.disabled.${blockReason}`) : undefined}>
                      <Button type="text" disabled={!!blockReason} onClick={() => onRevoke(key)}>
                        {t('apiKey.revoke')}
                      </Button>
                    </span>
                  </span>
                );
              },
            },
          ]}
          addons={[autotip({ emptyText: t('users.keys.empty') })]}
        />
      </div>
    </div>
  );
}

function CreateManagedKeyDialog({
  user,
  onClose,
  onCreated,
}: {
  user: PublicUser;
  onClose: () => void;
  onCreated: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [expiresAt, setExpiresAt] = useState<Moment | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      await userKeysApi.create({
        user_id: user.user_id,
        name: name.trim() || undefined,
        expires_at: expiresAt ? expiresAt.endOf('day').toISOString() : undefined,
        return_key_value: false,
      });
      onCreated();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      visible
      caption={t('users.keys.createCaption', { username: user.username })}
      size="s"
      onClose={onClose}
      disableEscape={submitting}
    >
      <Modal.Body>
        <Form>
          <Form.Item label={t('apiKey.create.name')} extra={t('apiKey.create.name.extra')}>
            <Input
              size="full"
              value={name}
              onChange={(value) => {
                setName(value.slice(0, 128));
                setError(null);
              }}
              placeholder={t('apiKey.create.name.placeholder')}
            />
          </Form.Item>
          <Form.Item
            label={t('apiKey.create.expiresAt')}
            extra={t('apiKey.create.expiresAt.extra')}
          >
            <DatePicker
              value={expiresAt ?? undefined}
              onChange={setExpiresAt}
              disabledDate={(date) => date.isBefore(moment().startOf('day'))}
              placeholder={t('apiKey.create.expiresAt.placeholder')}
            />
          </Form.Item>
          {error && (
            <Form.Item>
              <Alert type="error">{error}</Alert>
            </Form.Item>
          )}
        </Form>
      </Modal.Body>
      <Modal.Footer>
        <Button
          type="primary"
          loading={submitting}
          disabled={submitting}
          onClick={() => void submit()}
        >
          {t('apiKey.create.submit')}
        </Button>
        <Button disabled={submitting} onClick={onClose}>
          {t('apiKey.create.cancel')}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}

function CreateUserDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (info: { username: string; userId: string }) => void;
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
        ? await usersApi.createWithKey({ username: name, user_key: customKey.trim(), return_key_value: false })
        : await usersApi.create({ username: name, auth_provider: 'api_key', external_id: name, return_key_value: false });
      onCreated({ username: name, userId: created.user_id });
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      visible
      caption={t('users.create.caption')}
      size="m"
      onClose={onClose}
      disableEscape={submitting}
    >
      <Modal.Body>
        <Alert type="info">{t('users.create.typeFixed')}</Alert>
        <Form>
          <Form.Item label={t('users.column.username')} required>
            <Input
              autoFocus
              size="full"
              value={username}
              onChange={(value) => {
                setUsername(value);
                setError(null);
              }}
              onPressEnter={() => void submit()}
              placeholder={t('users.create.usernamePlaceholder')}
            />
          </Form.Item>
          <Form.Item label={t('users.create.customKey')}>
            <div>
              <Switch
                value={customKeyEnabled}
                onChange={(value) => {
                  setCustomKeyEnabled(value);
                  setError(null);
                }}
              />
              <div className="_memory-users-hint">{t('users.create.customKeyHint')}</div>
            </div>
          </Form.Item>
          {customKeyEnabled && (
            <Form.Item label="User_Key" required>
              <Input.Password
                size="full"
                value={customKey}
                onChange={(value) => {
                  setCustomKey(value);
                  setError(null);
                }}
                placeholder="sk-mem-…"
              />
            </Form.Item>
          )}
          {error && (
            <Form.Item>
              <Alert type="error">{error}</Alert>
            </Form.Item>
          )}
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
        <Button disabled={submitting} onClick={onClose}>
          {t('addMember.cancel')}
        </Button>
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
          <Form.Item label={t('users.column.username')}>
            <Input value={user.username} readonly size="full" />
          </Form.Item>
          <Form.Item label="user_id">
            <Input value={user.user_id} readonly size="full" />
          </Form.Item>
          <Form.Item label={t('users.column.type')}>
            <Input value={user.user_type} readonly size="full" />
          </Form.Item>
          <Form.Item label={t('users.column.createdAt')}>
            <Input value={formatTime(user.created_at)} readonly size="full" />
          </Form.Item>
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
      <Modal.Footer>
        <Button type="primary" onClick={onClose}>
          {t('header.profile.close')}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}

function UserDependencyList({ items }: { items: OwnedResourceDependency[] }) {
  const { t } = useTranslation();
  if (items.length === 0) return <Alert type="success">{t('users.dependencies.empty')}</Alert>;
  return (
    <div style={{ marginTop: 12, maxHeight: 360, overflow: 'auto' }}>
      {items.map((item) => (
        <div
          key={`${item.resource_type}:${item.resource_id}`}
          style={{ padding: '9px 0', borderBottom: '1px solid var(--tea-color-border-secondary)' }}
        >
          <div>
            <Tag size="sm">{item.resource_type}</Tag>{' '}
            <strong>{item.name || item.resource_id}</strong>{' '}
            <Tag size="sm" theme={item.membership_status === 'absent' ? 'error' : 'default'}>
              {item.membership_status === 'absent'
                ? t('users.dependencies.orphan')
                : item.membership_status}
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

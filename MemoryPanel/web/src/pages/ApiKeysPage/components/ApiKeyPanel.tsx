/**
 * ApiKeyPanel — User_Key 管理（组织与权限分组）。
 *
 * 普通用户列表展示自己的 Key；system_admin 额外展示用户与所属 Team，
 * 并可为指定成员创建或吊销 Key。
 * Tea 组件：列表用 Table + autotip，头部用 Justify + H3，
 * 破坏性操作统一走 Modal.confirm 二次确认，新建弹窗复用全站统一的 Modal 外壳。
 *
 * 后端链路：新面板（stateless）走 meta action `user-key/list|create|revoke`，
 * 由 Control 透明代理到内核 /v3/meta。前端不直接调内核，也不走旧 REST 路径。
 * 普通用户不传 user_id，只能管理自己的 Key；system_admin 显式传 user_id，
 * 可管理所有 Team 成员的 Key。两种路径都由内核 assertUserScope 最终鉴权。
 *
 * 安全设计（内核既有行为，不是本组件的取舍）：
 *   - key 明文只在 `create` 响应里出现这一次，之后 list/get 都不会再回传；
 *   - `key_prefix` 是内核给的可展示前缀（如 `sk-mem-ab12****`），用于免密识别
 *     具体是哪把 key，不等同于明文；
 *   - 因此列表里已存在的 key 无法「展开显示完整 key」，只能吊销。
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Moment } from 'moment';
import moment from 'moment';
import {
  Table,
  Card,
  Button,
  Alert,
  Copy,
  Text,
  DatePicker,
  Input,
  Justify,
  H3,
  Form,
  Modal,
  SearchBox,
  Select,
} from 'tea-component';
import { AddIcon } from 'tea-icons-react';
import { userKeysApi, usersApi, teamsApi, membersApi, metaInstancesApi } from '@/lib/teamApi';
import { useAuthStore } from '@/stores/auth';
import { tea } from '@/lib/tea-bridge';
import { getErrorMessage } from '@/lib/error-message';
import {
  buildManagedUserKeys,
  filterApiKeySubjects,
  filterManagedUserKeys,
  getKeyRevokeBlockReason,
  getPrivilegedMemberships,
  loadSystemAdminApiKeyInventory,
  type ApiKeySubject,
  type ApiKeyTeamRole,
  type ManagedUserKey,
} from '../api-key-inventory';
import { buildClientAccessConfigs } from '../client-access-config';
import '../styles/api-key-panel.css';

const { autotip } = Table.addons;

export default function ApiKeyPanel() {
  const { t } = useTranslation();
  const { auth } = useAuthStore();
  const isSystemAdmin = auth?.isAdmin === true;
  const [keys, setKeys] = useState<ManagedUserKey[]>([]);
  const [subjects, setSubjects] = useState<ApiKeySubject[]>([]);
  const [selectedUserId, setSelectedUserId] = useState(auth?.user_id ?? '');
  const [filterTeamId, setFilterTeamId] = useState('*');
  const [memberKeyword, setMemberKeyword] = useState('');
  const [loading, setLoading] = useState(true);
  // 客户端接入 base 地址（来自当前登录的 instance 元数据；每个实例不同）。
  // 优先取 proxy_endpoint —— 开源本地部署 core+proxy 分开时客户端要接的是 proxy；
  // 未配置时回落 gateway_endpoint，等同老行为（线上 gateway 前置 proxy，两者合一）。
  const [clientBaseUrl, setClientBaseUrl] = useState<string | null>(null);
  const [clientUpstreamModel, setClientUpstreamModel] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!auth?.instance_id) {
      setClientBaseUrl(null);
      setClientUpstreamModel(null);
      return;
    }
    void metaInstancesApi
      .list()
      .then((list) => {
        if (cancelled) return;
        const hit = list.find((i) => i.instance_id === auth.instance_id);
        setClientBaseUrl(hit?.proxy_endpoint ?? hit?.gateway_endpoint ?? null);
        setClientUpstreamModel(hit?.upstream_model ?? null);
      })
      .catch(() => {
        if (!cancelled) {
          setClientBaseUrl(null);
          setClientUpstreamModel(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [auth?.instance_id]);

  const refresh = useCallback(async () => {
    if (!auth) return;
    setLoading(true);
    try {
      if (!isSystemAdmin) {
        const ownSubject: ApiKeySubject = {
          userId: auth.user_id,
          username: auth.user,
          userType: auth.isAdmin ? 'system_admin' : 'user',
          teams: [],
        };
        const ownKeys = await userKeysApi.list();
        setSubjects([ownSubject]);
        setSelectedUserId(auth.user_id);
        setKeys(buildManagedUserKeys([ownSubject], new Map([[auth.user_id, ownKeys]])));
        return;
      }

      // 内核没有“列出所有 Team”端点：先列出实例用户，再按 user_id 拉所属 Team，
      // 由 user_id 去重后即可覆盖所有 Team 的所有成员。
      const inventory = await loadSystemAdminApiKeyInventory(auth.user_id, {
        listUsers: usersApi.list,
        listTeamsForUser: teamsApi.listForUser,
        listMembersForTeam: membersApi.list,
        listKeysForUser: userKeysApi.list,
      });
      const nextSubjects = inventory.subjects;
      setSubjects(nextSubjects);
      setFilterTeamId((current) =>
        current === '*' ||
        nextSubjects.some((subject) => subject.teams.some((team) => team.teamId === current))
          ? current
          : '*',
      );
      setSelectedUserId((current) =>
        nextSubjects.some((subject) => subject.userId === current)
          ? current
          : (nextSubjects[0]?.userId ?? auth.user_id),
      );
      setKeys(inventory.keys);
    } catch (e) {
      tea.notify.error(e);
      setSubjects([]);
      setKeys([]);
    } finally {
      setLoading(false);
    }
  }, [auth, isSystemAdmin]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // ---- 新建弹窗 ----
  const [showCreate, setShowCreate] = useState(false);
  const [newKeyName, setNewKeyName] = useState('');
  const [newExpiresAt, setNewExpiresAt] = useState<Moment | null>(null);
  const [creating, setCreating] = useState(false);
  // 刚创建出来的 key（含完整明文，仅展示一次）
  const [freshKey, setFreshKey] = useState<{
    keyId: string;
    secret: string;
    ownerName: string;
  } | null>(null);

  async function handleCreate() {
    const target = subjects.find((subject) => subject.userId === selectedUserId);
    if (!target) return;
    setCreating(true);
    try {
      const key = await userKeysApi.create({
        name: newKeyName.trim() || undefined,
        expires_at: newExpiresAt ? newExpiresAt.endOf('day').toISOString() : undefined,
        user_id: isSystemAdmin ? target.userId : undefined,
      });
      setNewExpiresAt(null);
      setNewKeyName('');
      setShowCreate(false);
      if (key.key_value) {
        setFreshKey({
          keyId: key.key_id,
          secret: key.key_value,
          ownerName: target.displayName || target.username,
        });
      }
      await refresh();
    } catch (e) {
      tea.notify.error(e);
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete(key: ManagedUserKey) {
    const revokeContext = {
      callerUserId: auth?.user_id,
      callerIsSystemAdmin: isSystemAdmin,
    };
    const blockReason = getKeyRevokeBlockReason(key, keys, revokeContext);
    if (blockReason) {
      tea.notify.warning(t(`apiKey.revoke.disabled.${blockReason}`));
      return;
    }
    const isLastActiveKey =
      keys.filter((candidate) => candidate.ownerUserId === key.ownerUserId).length === 1;
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
            isLastActiveKey
              ? 'apiKey.confirm.revoke.privilegedLast.desc'
              : 'apiKey.confirm.revoke.privileged.desc',
            { teams: managedTeams },
          )
        : t(
            isLastActiveKey
              ? 'apiKey.confirm.revoke.last.desc'
              : 'apiKey.confirm.revoke.desc',
          ),
      okText: t('apiKey.confirm.revoke.ok'),
    });
    if (!ok) return;
    try {
      await userKeysApi.revoke(key.key_id);
      await refresh();
    } catch (e) {
      const message = getErrorMessage(e);
      tea.notify.error(
        message.includes('last_key_cannot_revoke') || String(e).includes('last_key_cannot_revoke')
          ? t('apiKey.revoke.disabled.last_active_key')
          : e,
      );
    }
  }

  const formatTime = (iso?: string) => {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };
  const allTeams = useMemo(
    () =>
      [
        ...new Map(
          subjects.flatMap((subject) => subject.teams).map((team) => [team.teamId, team]),
        ).values(),
      ].sort((a, b) => a.teamName.localeCompare(b.teamName)),
    [subjects],
  );
  const filteredSubjects = useMemo(
    () => filterApiKeySubjects(subjects, filterTeamId, memberKeyword),
    [filterTeamId, memberKeyword, subjects],
  );
  const visibleKeys = useMemo(
    () => filterManagedUserKeys(keys, filteredSubjects),
    [filteredSubjects, keys],
  );
  const clientAccessConfigs = useMemo(() => {
    if (!clientBaseUrl || !clientUpstreamModel || !auth?.instance_id) return [];
    return buildClientAccessConfigs(clientBaseUrl, auth.instance_id, clientUpstreamModel);
  }, [auth?.instance_id, clientBaseUrl, clientUpstreamModel]);
  return (
    <div className="_memory-apikey-body">
      {/* ===== 刚创建的 Key 提示（仅展示一次） ===== */}
      {freshKey && (
        <Alert type="success" onClose={() => setFreshKey(null)}>
          <div className="_memory-apikey-fresh">
            <p className="_memory-apikey-fresh-desc">
              {t('apiKey.fresh.desc', { keyId: freshKey.keyId })}
            </p>
            {isSystemAdmin && (
              <p className="_memory-apikey-fresh-desc">
                {t('apiKey.fresh.owner', { name: freshKey.ownerName })}
              </p>
            )}
            <div className="_memory-apikey-fresh-code-row">
              <code className="_memory-apikey-fresh-code">{freshKey.secret}</code>
              <Copy
                text={freshKey.secret}
                onCopy={() => {
                  // 复制成功后自动关闭完整 Key 显示，避免明文长时间停留在屏幕上
                  setFreshKey(null);
                }}
              />
            </div>
          </div>
        </Alert>
      )}

      {/* ===== 页面头部（Justify 左右布局） ===== */}
      <Justify
        left={
          <div>
            <H3>{t('apiKey.title')}</H3>
            <Text theme="text" parent="div" style={{ marginTop: 4 }}>
              {t(isSystemAdmin ? 'apiKey.desc.admin' : 'apiKey.desc')}
            </Text>
          </div>
        }
        right={
          <Button
            type="primary"
            disabled={subjects.length === 0}
            onClick={() => {
              setShowCreate(true);
              setNewKeyName('');
              setNewExpiresAt(null);
            }}
            data-guide="create-key"
          >
            <AddIcon size={14} />
            {t('apiKey.create')}
          </Button>
        }
      />

      {isSystemAdmin && (
        <Card>
          <Card.Body title={t('apiKey.scope.title')}>
            <div className="_memory-apikey-scope-filters">
              <div className="_memory-apikey-scope-field">
                <Text theme="label" parent="label">
                  {t('apiKey.scope.team')}
                </Text>
                <Select
                  size="full"
                  searchable
                  value={filterTeamId}
                  onChange={(teamId) => {
                    setFilterTeamId(teamId);
                    setMemberKeyword('');
                  }}
                  options={[
                    { value: '*', text: t('apiKey.scope.allTeams') },
                    ...allTeams.map((team) => ({
                      value: team.teamId,
                      text: team.teamName,
                    })),
                  ]}
                />
              </div>
              <div className="_memory-apikey-scope-field">
                <Text theme="label" parent="label">
                  {t('apiKey.scope.member')}
                </Text>
                <SearchBox
                  value={memberKeyword}
                  onChange={setMemberKeyword}
                  placeholder={t('apiKey.scope.member.placeholder')}
                />
              </div>
            </div>
          </Card.Body>
        </Card>
      )}

      {/* ===== Key 列表：key_id / key_prefix / 创建时间 + 操作 ===== */}
      <Card>
        <div className="_memory-apikey-table-scroll">
          <Table
            verticalTop
            records={visibleKeys}
            recordKey="key_id"
            columns={[
            ...(isSystemAdmin
              ? [
                  {
                    key: 'owner',
                    header: t('apiKey.table.owner'),
                    width: '15%',
                    render: (key: ManagedUserKey) => (
                      <div className="_memory-apikey-cell">
                        <Text theme="strong" parent="div">
                          {key.ownerName}
                        </Text>
                        <Text theme="weak" parent="code" style={{ fontSize: 11 }}>
                          {key.ownerUserId}
                        </Text>
                      </div>
                    ),
                  },
                  {
                    key: 'teams',
                    header: t('apiKey.table.teams'),
                    width: '16%',
                    render: (key: ManagedUserKey) => (
                      <div className="_memory-apikey-cell _memory-apikey-team-list">
                        {key.teamMemberships.length ? (
                          key.teamMemberships.map((team) => (
                            <div className="_memory-apikey-team-line" key={team.teamId}>
                              <span>{team.teamName}</span>{' '}
                              <Text theme="weak">
                                ({team.roles.map((role) => t(`apiKey.role.${role}`)).join(', ')})
                              </Text>
                            </div>
                          ))
                        ) : (
                          <Text theme="weak">{t('apiKey.noTeam')}</Text>
                        )}
                      </div>
                    ),
                  },
                ]
              : []),
            {
              key: 'name',
              header: t('apiKey.table.name'),
              width: isSystemAdmin ? '14%' : '18%',
              render: (key) =>
                key.name ? (
                  <Text className="_memory-apikey-cell">{key.name}</Text>
                ) : (
                  <Text theme="weak">{t('apiKey.noName')}</Text>
                ),
            },
            {
              key: 'key_id',
              header: t('apiKey.table.keyId'),
              width: isSystemAdmin ? '15%' : '23%',
              render: (key) => (
                <Text
                  parent="code"
                  copyable
                  className="_memory-apikey-cell _memory-apikey-code-cell"
                >
                  {key.key_id}
                </Text>
              ),
            },
            {
              key: 'key_prefix',
              header: t('apiKey.table.keyPrefix'),
              width: isSystemAdmin ? '14%' : '22%',
              render: (key) => (
                <Text parent="code" className="_memory-apikey-cell _memory-apikey-code-cell">
                  {key.key_prefix || '—'}
                </Text>
              ),
            },
            {
              key: 'created_at',
              header: t('apiKey.table.createdAt'),
              width: isSystemAdmin ? '10%' : '14%',
              render: (key) => (
                <Text theme="text" className="_memory-apikey-time">
                  {formatTime(key.created_at)}
                </Text>
              ),
            },
            {
              key: 'expires_at',
              header: t('apiKey.table.expiresAt'),
              width: isSystemAdmin ? '9%' : '14%',
              render: (key) => {
                if (key.revoked_at) return <Text theme="weak">{t('apiKey.revoked')}</Text>;
                return key.expires_at ? (
                  <Text theme="text" className="_memory-apikey-time">
                    {formatTime(key.expires_at)}
                  </Text>
                ) : (
                  <Text theme="weak">{t('apiKey.neverExpire')}</Text>
                );
              },
            },
            {
              key: 'actions',
              header: t('apiKey.table.actions'),
              width: isSystemAdmin ? '7%' : '9%',
              align: 'right',
              render: (key) => {
                const blockReason = getKeyRevokeBlockReason(key, keys, {
                  callerUserId: auth?.user_id,
                  callerIsSystemAdmin: isSystemAdmin,
                });
                return (
                  <span
                    className="_memory-apikey-action"
                    title={blockReason ? t(`apiKey.revoke.disabled.${blockReason}`) : undefined}
                  >
                    <Button
                      type="text"
                      disabled={!!key.revoked_at || !!blockReason}
                      onClick={() => void handleDelete(key)}
                    >
                      {t('apiKey.revoke')}
                    </Button>
                  </span>
                );
              },
            },
            ]}
            addons={[
            autotip({
              isLoading: loading,
              emptyText: (
                <div className="_memory-apikey-empty">
                  <div className="_memory-apikey-empty-title">
                    {t(isSystemAdmin ? 'apiKey.empty.admin.title' : 'apiKey.empty.title')}
                  </div>
                  <div className="_memory-apikey-empty-desc">
                    {t(isSystemAdmin ? 'apiKey.empty.admin.desc' : 'apiKey.empty.desc')}
                  </div>
                </div>
              ),
              onRetry: () => void refresh(),
            }),
            ]}
          />
        </div>
      </Card>

      {/* ===== 各客户端完整接入配置（Key 只展示占位符，model 来自实例运行配置） ===== */}
      {/*
        instance-id 从当前登录态注入（auth.instance_id）—— 用户不用再手工替换
        [instance-id] 占位符，也不用去别处找自己现在连的是哪个实例。
        未登录理论上不会走到这个页（LoginGate 挡在外面），仍保留占位 fallback 兜底。
      */}
      <Card>
        <Card.Body title={t('apiKey.endpoint.title')}>
          {auth?.instance_name && (
            <div
              style={{ marginBottom: 8, fontSize: 11, color: 'var(--tea-color-text-secondary)' }}
            >
              {t('apiKey.endpoint.current')}
              <code>{auth.instance_name}</code>
              <span style={{ opacity: 0.6, marginLeft: 6 }}>({auth.instance_id})</span>
              {clientUpstreamModel && (
                <>
                  <span style={{ marginLeft: 12 }}>{t('apiKey.endpoint.model')}</span>
                  <code>{clientUpstreamModel}</code>
                </>
              )}
            </div>
          )}
          <div className="_memory-apikey-endpoints">
            {!clientBaseUrl ? (
              <Text theme="weak" style={{ fontSize: 11 }}>
                {t('apiKey.endpoint.loading')}
              </Text>
            ) : !clientUpstreamModel ? (
              <Alert type="warning">{t('apiKey.endpoint.modelMissing')}</Alert>
            ) : (
              clientAccessConfigs.map((config) => (
                <div className="_memory-apikey-endpoint" key={config.id}>
                  <div className="_memory-apikey-endpoint-header">
                    <div>
                      <Text theme="label" parent="div">
                        {config.name}
                      </Text>
                      <Text theme="weak" parent="code" className="_memory-apikey-endpoint-target">
                        {t(`apiKey.endpoint.kind.${config.kind}`)} · {config.target}
                      </Text>
                    </div>
                    <Copy text={config.content}>
                      <Button>{t('apiKey.endpoint.copyConfig')}</Button>
                    </Copy>
                  </div>
                  <pre className="_memory-apikey-endpoint-code">{config.content}</pre>
                </div>
              ))
            )}
          </div>
        </Card.Body>
      </Card>
      {/* ===== 新建弹窗：备注名可选，过期时间留空表示永不过期 ===== */}
      {showCreate && (
        <Modal
          visible
          caption={t('apiKey.create.caption')}
          size="s"
          onClose={() => setShowCreate(false)}
          disableEscape={creating}
        >
          <Modal.Body>
            <Form>
              {isSystemAdmin && (
                <Form.Item label={t('apiKey.create.user')} extra={t('apiKey.create.user.extra')}>
                  <Select
                    size="full"
                    searchable
                    value={selectedUserId}
                    onChange={setSelectedUserId}
                    options={subjects.map((subject) => ({
                      value: subject.userId,
                      text: `${subject.displayName || subject.username} (${subject.userId}) · ${
                        subject.teams.length
                          ? subject.teams.map((team) => team.teamName).join(', ')
                          : t('apiKey.noTeam')
                      }`,
                    }))}
                  />
                </Form.Item>
              )}
              <Form.Item label={t('apiKey.create.name')} extra={t('apiKey.create.name.extra')}>
                <Input
                  size="full"
                  value={newKeyName}
                  onChange={(value) => setNewKeyName(value.slice(0, 128))}
                  placeholder={t('apiKey.create.name.placeholder')}
                />
              </Form.Item>
              <Form.Item
                label={t('apiKey.create.expiresAt')}
                extra={t('apiKey.create.expiresAt.extra')}
              >
                <DatePicker
                  value={newExpiresAt ?? undefined}
                  onChange={(v) => setNewExpiresAt(v)}
                  disabledDate={(d) => !d.isBefore(moment().startOf('day'))}
                  placeholder={t('apiKey.create.expiresAt.placeholder')}
                />
              </Form.Item>
            </Form>
          </Modal.Body>
          <Modal.Footer>
            <Button
              type="primary"
              onClick={() => void handleCreate()}
              disabled={creating || !selectedUserId}
              loading={creating}
            >
              {t('apiKey.create.submit')}
            </Button>
            <Button onClick={() => setShowCreate(false)} disabled={creating}>
              {t('apiKey.create.cancel')}
            </Button>
          </Modal.Footer>
        </Modal>
      )}
    </div>
  );
}

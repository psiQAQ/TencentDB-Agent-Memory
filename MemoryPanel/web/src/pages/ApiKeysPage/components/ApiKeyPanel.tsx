/**
 * 当前账号的 User_Key 管理。
 *
 * system_admin 与 normal 用户在本页使用完全相同的 self-only 调用：list/create
 * 均不传 user_id。全局账号、Team 上下文和其他用户 Key 的管理统一收拢到“用户管理”。
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Moment } from 'moment';
import moment from 'moment';
import {
  Alert,
  Button,
  Card,
  Copy,
  DatePicker,
  Form,
  H3,
  Input,
  Justify,
  Modal,
  Table,
  Text,
} from 'tea-component';
import { AddIcon } from 'tea-icons-react';
import { metaInstancesApi, userKeysApi } from '@/lib/teamApi';
import { useAuthStore } from '@/stores/auth';
import { tea } from '@/lib/tea-bridge';
import { getErrorMessage } from '@/lib/error-message';
import {
  buildManagedUserKeys,
  getKeyRevokeBlockReason,
  type ApiKeySubject,
  type ManagedUserKey,
} from '../api-key-inventory';
import { buildClientAccessConfigs } from '../client-access-config';
import '../styles/api-key-panel.css';

const { autotip } = Table.addons;

function formatTime(iso?: string) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

export default function ApiKeyPanel() {
  const { t } = useTranslation();
  const { auth } = useAuthStore();
  const [keys, setKeys] = useState<ManagedUserKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [clientBaseUrl, setClientBaseUrl] = useState<string | null>(null);
  const [clientUpstreamModel, setClientUpstreamModel] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [newKeyName, setNewKeyName] = useState('');
  const [newExpiresAt, setNewExpiresAt] = useState<Moment | null>(null);
  const [creating, setCreating] = useState(false);
  const [freshKey, setFreshKey] = useState<{ keyId: string; secret: string } | null>(null);

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
        const hit = list.find((instance) => instance.instance_id === auth.instance_id);
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
      const subject: ApiKeySubject = {
        userId: auth.user_id,
        username: auth.user,
        userType: auth.user_type,
        teams: [],
      };
      const ownKeys = await userKeysApi.list();
      setKeys(buildManagedUserKeys([subject], new Map([[auth.user_id, ownKeys]])));
    } catch (err) {
      tea.notify.error(getErrorMessage(err));
      setKeys([]);
    } finally {
      setLoading(false);
    }
  }, [auth]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function handleCreate() {
    setCreating(true);
    try {
      const key = await userKeysApi.create({
        name: newKeyName.trim() || undefined,
        expires_at: newExpiresAt ? newExpiresAt.endOf('day').toISOString() : undefined,
      });
      setNewExpiresAt(null);
      setNewKeyName('');
      setShowCreate(false);
      if (key.key_value) setFreshKey({ keyId: key.key_id, secret: key.key_value });
      await refresh();
    } catch (err) {
      tea.notify.error(getErrorMessage(err));
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete(key: ManagedUserKey) {
    const blockReason = getKeyRevokeBlockReason(key, keys, {
      callerUserId: auth?.user_id,
      callerIsSystemAdmin: auth?.isAdmin === true,
    });
    if (blockReason) {
      tea.notify.warning(t(`apiKey.revoke.disabled.${blockReason}`));
      return;
    }
    const ok = await tea.confirm({
      message: t('apiKey.confirm.revoke', { name: key.key_prefix || key.key_id }),
      description: t(
        keys.length === 1 ? 'apiKey.confirm.revoke.last.desc' : 'apiKey.confirm.revoke.desc',
      ),
      okText: t('apiKey.confirm.revoke.ok'),
    });
    if (!ok) return;
    try {
      await userKeysApi.revoke(key.key_id);
      await refresh();
    } catch (err) {
      const message = getErrorMessage(err);
      tea.notify.error(
        message.includes('last_key_cannot_revoke')
          ? t('apiKey.revoke.disabled.last_active_key')
          : message,
      );
    }
  }

  const clientAccessConfigs = useMemo(() => {
    if (!clientBaseUrl || !clientUpstreamModel || !auth?.instance_id) return [];
    return buildClientAccessConfigs(clientBaseUrl, auth.instance_id, clientUpstreamModel);
  }, [auth?.instance_id, clientBaseUrl, clientUpstreamModel]);

  return (
    <div className="_memory-apikey-body">
      {freshKey && (
        <Alert type="success" onClose={() => setFreshKey(null)}>
          <div className="_memory-apikey-fresh">
            <p className="_memory-apikey-fresh-desc">
              {t('apiKey.fresh.desc', { keyId: freshKey.keyId })}
            </p>
            <div className="_memory-apikey-fresh-code-row">
              <code className="_memory-apikey-fresh-code">{freshKey.secret}</code>
              <Copy text={freshKey.secret} onCopy={() => setFreshKey(null)} />
            </div>
          </div>
        </Alert>
      )}

      <Justify
        left={
          <div>
            <H3>{t('apiKey.title')}</H3>
            <Text theme="text" parent="div" style={{ marginTop: 4 }}>
              {t('apiKey.desc')}
            </Text>
          </div>
        }
        right={
          <Button
            type="primary"
            onClick={() => {
              setShowCreate(true);
              setNewKeyName('');
              setNewExpiresAt(null);
            }}
            data-guide="create-key"
          >
            <AddIcon size={14} /> {t('apiKey.create')}
          </Button>
        }
      />

      <Card>
        <div className="_memory-apikey-table-scroll">
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
                  key.name ? (
                    <Text>{key.name}</Text>
                  ) : (
                    <Text theme="weak">{t('apiKey.noName')}</Text>
                  ),
              },
              {
                key: 'key_id',
                header: t('apiKey.table.keyId'),
                width: '23%',
                render: (key: ManagedUserKey) => (
                  <Text parent="code" copyable className="_memory-apikey-code-cell">
                    {key.key_id}
                  </Text>
                ),
              },
              {
                key: 'key_prefix',
                header: t('apiKey.table.keyPrefix'),
                width: '22%',
                render: (key: ManagedUserKey) => <code>{key.key_prefix || '—'}</code>,
              },
              {
                key: 'created_at',
                header: t('apiKey.table.createdAt'),
                width: '14%',
                render: (key: ManagedUserKey) => formatTime(key.created_at),
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
                width: '9%',
                align: 'right',
                render: (key: ManagedUserKey) => {
                  const blockReason = getKeyRevokeBlockReason(key, keys, {
                    callerUserId: auth?.user_id,
                    callerIsSystemAdmin: auth?.isAdmin === true,
                  });
                  return (
                    <span
                      title={blockReason ? t(`apiKey.revoke.disabled.${blockReason}`) : undefined}
                    >
                      <Button
                        type="text"
                        disabled={!!blockReason}
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
                    <div className="_memory-apikey-empty-title">{t('apiKey.empty.title')}</div>
                    <div className="_memory-apikey-empty-desc">{t('apiKey.empty.desc')}</div>
                  </div>
                ),
                onRetry: () => void refresh(),
              }),
            ]}
          />
        </div>
      </Card>

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
                  onChange={setNewExpiresAt}
                  disabledDate={(date) => date.isBefore(moment().startOf('day'))}
                  placeholder={t('apiKey.create.expiresAt.placeholder')}
                />
              </Form.Item>
            </Form>
          </Modal.Body>
          <Modal.Footer>
            <Button
              type="primary"
              onClick={() => void handleCreate()}
              disabled={creating}
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

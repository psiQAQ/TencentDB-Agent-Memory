/**
 * Team 成员管理。
 *
 * 全局账号创建与凭证下发只在 system_admin 的“用户管理”页面完成；这里仅由
 * 当前 Team owner/admin 按 user_id 添加已有账号，并维护 Team 角色。
 */
import { useState } from 'react';
import { Alert, Button, Copy, Form, Input, Modal, Select, Tag } from 'tea-component';
import { useTranslation } from 'react-i18next';
import { AddIcon, CloseIcon } from 'tea-icons-react';
import { isTeamAdmin, invalidateBackendCache, type Team } from '@/services';
import {
  ApiError,
  membersApi,
  usersApi,
  type OwnedResourceDependency,
  type UserDependencies,
} from '@/lib/teamApi';
import { tea } from '@/lib/tea-bridge';
import { getErrorMessage } from '@/lib/error-message';
import { canRemoveMember } from './types';

type MemberRole = 'admin' | 'member' | 'reviewer';

export function MemberSection({
  team,
  currentUser,
  onAdd,
}: {
  team: Team;
  currentUser: string;
  onAdd: () => void;
}) {
  const [removing, setRemoving] = useState<string | null>(null);
  const [updating, setUpdating] = useState<string | null>(null);
  const [blocker, setBlocker] = useState<{ userId: string; dependencies: UserDependencies } | null>(null);
  const { t } = useTranslation();
  const canManageMembers = isTeamAdmin(team, currentUser);

  async function handleRemove(userId: string) {
    let dependencies: UserDependencies;
    try {
      dependencies = await usersApi.dependenciesAll(userId, { team_id: team.team_id });
    } catch (err) {
      tea.notify.error(getErrorMessage(err));
      return;
    }
    if (dependencies.counts.agents + dependencies.counts.tasks + dependencies.counts.assets > 0) {
      setBlocker({ userId, dependencies });
      return;
    }
    const ok = await tea.confirm({
      message: t('member.remove.confirm', { userId }),
      description: t('member.remove.desc'),
      okText: t('member.remove.ok'),
    });
    if (!ok) return;
    setRemoving(userId);
    try {
      await membersApi.remove(team.team_id, userId);
      invalidateBackendCache();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && err.data) {
        try {
          setBlocker({
            userId,
            dependencies: await usersApi.dependenciesAll(userId, { team_id: team.team_id }),
          });
        } catch (refreshErr) {
          tea.notify.error(getErrorMessage(refreshErr));
        }
      } else {
        tea.notify.error(getErrorMessage(err));
      }
    } finally {
      setRemoving(null);
    }
  }

  async function handleRoleChange(userId: string, role: MemberRole) {
    setUpdating(userId);
    try {
      // team-member/add 是幂等 upsert：已有成员时更新 role。
      await membersApi.add(team.team_id, { user_id: userId, role });
      invalidateBackendCache();
    } catch (err) {
      tea.notify.error(getErrorMessage(err));
    } finally {
      setUpdating(null);
    }
  }

  return (
    <div className="_memory-panel-card">
      <div className="_memory-section-header">
        <div className="_memory-section-header-info">
          <div className="_memory-section-header-title-row">
            <div className="_memory-section-title">{t('member.title', { count: team.members.length })}</div>
            <Tag size="sm">{team.team_id}</Tag>
          </div>
          <div className="_memory-section-subtitle">{t('member.subtitle', { name: team.name })}</div>
        </div>
        {canManageMembers && (
          <Button onClick={onAdd} title={t('member.add.tooltip')} data-guide="add-member">
            <AddIcon size={14} /> {t('member.add')}
          </Button>
        )}
      </div>

      <div className="_memory-member-grid" data-guide="members-list">
        {team.members.map((member) => {
          const isOwner = team.owner_user_id === member.user_id;
          const isMe = member.user_id === currentUser;
          return (
            <MemberCard
              key={member.user_id}
              userId={member.user_id}
              username={member.username}
              role={member.role}
              isOwner={isOwner}
              isMe={isMe}
              canEditRole={canManageMembers && !isOwner && !isMe}
              canRemove={canRemoveMember(team, member.user_id, currentUser)}
              updating={updating === member.user_id}
              removing={removing === member.user_id}
              onRoleChange={(role) => void handleRoleChange(member.user_id, role)}
              onRemove={() => void handleRemove(member.user_id)}
            />
          );
        })}
      </div>

      {blocker && (
        <OwnedResourceBlockerModal
          userId={blocker.userId}
          dependencies={blocker.dependencies}
          onClose={() => setBlocker(null)}
        />
      )}
    </div>
  );
}

function OwnedResourceBlockerModal({
  userId,
  dependencies,
  onClose,
}: {
  userId: string;
  dependencies: UserDependencies;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const items = dependencies.items.filter((item) => item.resource_type !== 'team');
  return (
    <Modal visible caption={t('member.remove.blockedTitle')} size="l" onClose={onClose}>
      <Modal.Body>
        <Alert type="warning">
          {t('member.remove.blockedDesc', {
            userId,
            agents: dependencies.counts.agents,
            tasks: dependencies.counts.tasks,
            assets: dependencies.counts.assets,
          })}
        </Alert>
        <DependencyList items={items} />
      </Modal.Body>
      <Modal.Footer>
        <Button type="primary" onClick={onClose}>{t('header.profile.close')}</Button>
      </Modal.Footer>
    </Modal>
  );
}

function DependencyList({ items }: { items: OwnedResourceDependency[] }) {
  const { t } = useTranslation();
  if (items.length === 0) return null;
  return (
    <div style={{ marginTop: 12, maxHeight: 320, overflow: 'auto' }}>
      {items.map((item) => (
        <div key={`${item.resource_type}:${item.resource_id}`} style={{ padding: '8px 0', borderBottom: '1px solid var(--tea-color-border-secondary)' }}>
          <div><Tag size="sm">{item.resource_type}</Tag> <strong>{item.name || item.resource_id}</strong></div>
          <div style={{ marginTop: 4, color: 'var(--tea-color-text-secondary)' }}>
            <code>{item.resource_id}</code> · {item.status} · {t('resources.membership')}: {item.membership_status}
          </div>
        </div>
      ))}
    </div>
  );
}

function MemberCard({
  userId,
  username,
  role,
  isOwner,
  isMe,
  canEditRole,
  canRemove,
  updating,
  removing,
  onRoleChange,
  onRemove,
}: {
  userId: string;
  username?: string;
  role: MemberRole;
  isOwner: boolean;
  isMe: boolean;
  canEditRole: boolean;
  canRemove: boolean;
  updating: boolean;
  removing: boolean;
  onRoleChange: (role: MemberRole) => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const displayName = username?.trim() || userId;
  const hasUsername = !!username?.trim();

  return (
    <div className="_memory-member-card">
      <div className={`_memory-member-avatar${isOwner ? ' _memory-member-avatar--owner' : ''}`}>
        {displayName.slice(0, 2).toUpperCase()}
      </div>
      <div className="_memory-member-info">
        <div className="_memory-member-id">
          {displayName}
          {isMe && <span className="_memory-member-me-tag">{t('member.me')}</span>}
        </div>
        {hasUsername && (
          <div className="_memory-member-role" style={{ fontSize: '10px', color: 'var(--tea-color-text-tertiary)' }}>
            {userId}
          </div>
        )}
        <div className="_memory-member-role">
          {role}{isOwner ? t('member.role.creator') : ''}
        </div>
      </div>
      <div className="_memory-member-actions">
        <Select
          appearance="button"
          size="s"
          value={role}
          disabled={!canEditRole || updating}
          onChange={(value) => onRoleChange(value as MemberRole)}
          options={[
            { value: 'admin', text: 'admin' },
            { value: 'member', text: 'member' },
            { value: 'reviewer', text: 'reviewer' },
          ]}
        />
        {canRemove && (
          <button
            type="button"
            onClick={(event) => { event.stopPropagation(); onRemove(); }}
            disabled={removing}
            className="_memory-member-remove-btn"
            title={t('member.remove.tooltip')}
            aria-label={t('member.remove.tooltip')}
          >
            {removing ? '…' : <CloseIcon size={12} />}
          </button>
        )}
      </div>
    </div>
  );
}

export function AddMemberDialog({
  team,
  onClose,
  currentUser,
}: {
  team: Team;
  onClose: () => void;
  currentUser: string;
}) {
  const [userId, setUserId] = useState('');
  const [role, setRole] = useState<MemberRole>('member');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const { t } = useTranslation();

  async function submit() {
    const id = userId.trim();
    if (!id) {
      setError(t('addMember.error.emptyId'));
      return;
    }
    if (id === currentUser) {
      setError(t('addMember.error.self'));
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await membersApi.add(team.team_id, { user_id: id, role });
      invalidateBackendCache();
      onClose();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      visible
      caption={<>{t('addMember.caption', { name: team.name })}<Tag size="sm">{team.team_id}</Tag></>}
      size="m"
      onClose={onClose}
      disableEscape={submitting}
    >
      <Modal.Body>
        <Alert type="info">{t('addMember.existingOnlyHint')}</Alert>
        <Form>
          <Form.Item label={t('addMember.userId')} required>
            <div>
              <Input
                autoFocus
                size="full"
                value={userId}
                onChange={(value) => { setUserId(value); setError(null); }}
                onPressEnter={() => void submit()}
                placeholder={t('addMember.userId.placeholder')}
              />
              <div className="_memory-field-hint">{t('addMember.userId.hint')}</div>
            </div>
          </Form.Item>
          <Form.Item label={t('addMember.role')} required>
            <Select
              size="full"
              value={role}
              onChange={(value) => setRole(value as MemberRole)}
              options={[
                { value: 'admin', text: 'admin' },
                { value: 'member', text: 'member' },
                { value: 'reviewer', text: 'reviewer' },
              ]}
            />
            <div className="_memory-field-hint">{t('addMember.role.hint')}</div>
          </Form.Item>
          {error && <Form.Item><Alert type="error">{error}</Alert></Form.Item>}
        </Form>
      </Modal.Body>
      <Modal.Footer>
        <Button type="primary" onClick={() => void submit()} disabled={!userId.trim() || submitting} loading={submitting}>
          {t('addMember.existing.submit')}
        </Button>
        <Button onClick={onClose} disabled={submitting}>{t('addMember.cancel')}</Button>
      </Modal.Footer>
    </Modal>
  );
}

/** 创建用户成功后展示初始 API Key；明文仅此次响应可得。 */
export function CreatedUserKeyModal({
  info,
  onClose,
}: {
  info: { username: string; userId: string; keyValue: string };
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const { t } = useTranslation();

  return (
    <Modal visible caption={t('createdUserKey.caption')} size="m" onClose={onClose}>
      <Modal.Body>
        <Form>
          <Alert type="success">{t('createdUserKey.success', { username: info.username, userId: info.userId })}</Alert>
          <div className="space-y-4 text-[13px]">
            <Alert type="warning"><strong>{t('createdUserKey.warning')}</strong></Alert>
            <Form.Item label={t('createdUserKey.keyLabel')}>
              <div className="flex items-center gap-2">
                <code className="flex-1 rounded border bg-muted px-3 py-2 text-[12px] font-mono break-all select-all">
                  {info.keyValue}
                </code>
                <Copy text={info.keyValue}>
                  <Button onClick={() => setCopied(true)}>
                    {copied ? t('createdUserKey.copied') : t('createdUserKey.copy')}
                  </Button>
                </Copy>
              </div>
            </Form.Item>
          </div>
        </Form>
      </Modal.Body>
      <Modal.Footer>
        <Button type="primary" onClick={onClose}>{t('createdUserKey.close')}</Button>
      </Modal.Footer>
    </Modal>
  );
}

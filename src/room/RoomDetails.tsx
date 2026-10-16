import { useEffect, useRef, useState } from 'react';
import {
  Check,
  Copy,
  Crown,
  Link,
  LoaderCircle,
  Settings2,
  UserCheck,
  UserX,
  UsersRound,
} from 'lucide-react';
import type { RoomSettings } from '../../shared/room';
import type { Room, RoomSnapshot } from './room';
import { SettingsFields } from './RoomHome';
import type { T } from './room-ui';

// Join requests stay in view above the conversation, so the owner doesn't miss them.
export function JoinRequests({
  snapshot: s,
  room,
  t,
}: {
  snapshot: RoomSnapshot;
  room: () => Room | undefined;
  t: T;
}) {
  if (!s.isOwner || !s.requests.length) return null;
  return (
    <ul className="request-list" data-testid="join-requests">
      {s.requests.map((r) => (
        <li key={r.id}>
          <span>{t('{name} wants to join', { name: r.name })}</span>
          <button
            className="secondary-button"
            disabled={!r.verified}
            onClick={() => void room()?.approve(r.id)}
          >
            {r.verified ? <UserCheck size={15} /> : <LoaderCircle size={15} className="spin" />}
            {r.verified ? t('Allow') : t('Verifying…')}
          </button>
          <button className="text-button" onClick={() => room()?.deny(r.id)}>
            {t('Deny')}
          </button>
        </li>
      ))}
    </ul>
  );
}

// Code, people and (for the owner) settings, folded away once others are here.
export function RoomDetails({
  snapshot: s,
  room,
  t,
  onError,
}: {
  snapshot: RoomSnapshot;
  room: () => Room | undefined;
  t: T;
  onError: (message: string) => void;
}) {
  const alone = s.members.length <= 1;
  const [open, setOpen] = useState(alone);
  const [copied, setCopied] = useState('');
  const [confirm, setConfirm] = useState('');
  const [editing, setEditing] = useState<RoomSettings>();
  const wasAlone = useRef(alone);
  // Fold the panel away when the first person joins; open it if everyone left.
  useEffect(() => {
    if (wasAlone.current !== alone) setOpen(alone);
    wasAlone.current = alone;
  }, [alone]);
  const link = `${location.origin}/#room=${s.code}`;

  async function copy(value: string, label: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(label);
      setTimeout(() => setCopied(''), 2000);
    } catch {
      onError(t('Clipboard access was blocked. Select and copy the code manually.'));
    }
  }
  function twice(key: string, action: () => void) {
    if (confirm === key) {
      setConfirm('');
      action();
    } else {
      setConfirm(key);
      setTimeout(() => setConfirm((c) => (c === key ? '' : c)), 4000);
    }
  }
  return (
    <details
      className="room-details"
      data-testid="room-details"
      open={open}
      onToggle={(event) => setOpen((event.target as HTMLDetailsElement).open)}
    >
      <summary>
        <UsersRound size={15} />
        <span>{t('Room details')}</span>
        <span className="room-details-count">
          {t('{count}/{size} people', { count: s.members.length, size: s.settings?.size ?? 0 })}
        </span>
      </summary>
      <div className="room-details-body">
        <section className="room-invite" aria-label={t('Invite people')}>
          <div>
            <span className="small-label">{t('ROOM CODE')}</span>
            <code className="transfer-code room-code" data-testid="room-code">
              {s.code}
            </code>
          </div>
          <div className="copy-actions">
            <button className="secondary-button" onClick={() => void copy(s.code, 'code')}>
              {copied === 'code' ? <Check size={16} /> : <Copy size={16} />}
              {copied === 'code' ? t('Copied') : t('Copy code')}
            </button>
            <button className="text-button" onClick={() => void copy(link, 'link')}>
              {copied === 'link' ? <Check size={16} /> : <Link size={16} />}
              {copied === 'link' ? t('Copied') : t('Copy link')}
            </button>
          </div>
        </section>

        <section className="room-section" aria-label={t('People in this room')}>
          <h3>
            {t('People')}
            <span>
              {s.members.length}/{s.settings?.size}
            </span>
          </h3>
          <ul className="member-list" data-testid="room-members">
            {s.members.map((m) => (
              <li key={m.id} className={m.online ? '' : 'offline'} data-member={m.name}>
                <span className={`avatar ${m.online ? 'online' : ''}`} aria-hidden="true">
                  {[...m.name][0]?.toUpperCase()}
                </span>
                <span className="member-name">
                  <strong>{m.name}</strong>
                  {(m.me || m.owner) && (
                    <small>
                      {m.me && t('You')}
                      {m.me && m.owner && ' · '}
                      {m.owner && (
                        <span className="owner-badge">
                          <Crown size={11} />
                          {t('Room creator')}
                        </span>
                      )}
                    </small>
                  )}
                </span>
                <span className="visually-hidden">{m.online ? t('Online') : t('Offline')}</span>
                {s.isOwner && !m.me && (
                  <button
                    className="icon-button"
                    aria-label={t('Remove {name}', { name: m.name })}
                    onClick={() => twice(`remove:${m.id}`, () => room()?.remove(m.id))}
                  >
                    {confirm === `remove:${m.id}` ? (
                      <span className="confirm-text">{t('Remove?')}</span>
                    ) : (
                      <UserX size={16} />
                    )}
                  </button>
                )}
              </li>
            ))}
          </ul>
          {alone && (
            <p className="field-note room-note">
              {t('Share the code or link so others can join.')}
            </p>
          )}
          {s.isOwner && s.settings && (
            <details
              className="room-settings-panel"
              onToggle={(event) =>
                setEditing((event.target as HTMLDetailsElement).open ? s.settings : undefined)
              }
            >
              <summary>
                <Settings2 size={15} />
                {t('Room settings')}
              </summary>
              {editing && (
                <>
                  <SettingsFields
                    settings={editing}
                    onChange={setEditing}
                    minimumSize={s.members.length}
                    t={t}
                  />
                  {editing.join === 'auto' && (
                    <p className="field-note">
                      {t('Anyone with the code can join. Removed people could join again.')}
                    </p>
                  )}
                  <button
                    className="secondary-button"
                    onClick={() => {
                      room()?.updateSettings(editing);
                    }}
                  >
                    <Check size={15} />
                    {t('Save settings')}
                  </button>
                </>
              )}
            </details>
          )}
        </section>
      </div>
    </details>
  );
}

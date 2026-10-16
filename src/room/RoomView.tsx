import { useState } from 'react';
import { ArrowLeft, LoaderCircle, LockKeyhole, X } from 'lucide-react';
import type { Room, RoomSnapshot } from './room';
import { Composer } from './Composer';
import { ConversationView } from './ConversationView';
import { JoinRequests, RoomDetails } from './RoomDetails';
import type { T } from './room-ui';

const endings: Record<string, [string, string]> = {
  dismissed: ['Room closed', 'The room creator closed this room.'],
  removed: ['Removed from the room', 'The room creator removed you from this room.'],
  declined: ['Request declined', 'The room creator declined your request to join.'],
  full: ['Room full', 'This room is full. Ask the room creator to make room.'],
  'not-found': ['Room not found', 'No room uses this code. Check the code and try again.'],
  expired: ['Room expired', 'This room has expired. Rooms stay open for up to 24 hours.'],
  left: ['You left the room', 'You can join again with the code if the room is still open.'],
  locked: ['Open in another tab', 'This room is open in another tab. Continue there.'],
  failed: ['Could not join', 'Could not verify this room. Ask for a new code and try again.'],
  'owner-offline': ['Nobody let you in', 'The room creator didn’t respond. Try again later.'],
};

export function RoomView({
  snapshot: s,
  room,
  onClose,
  t,
}: {
  snapshot: RoomSnapshot;
  room: () => Room | undefined;
  onClose: () => void;
  t: T;
}) {
  const [error, setError] = useState('');
  const [confirm, setConfirm] = useState('');
  const [hidden, setHidden] = useState('');
  const others = s.members.filter((m) => !m.me).map((m) => m.id);
  // Names for "To" lines, including people who already left.
  const names: Record<string, string> = {};
  for (const e of s.timeline) {
    names[e.from] = e.fromName;
    for (const d of e.deliveries) names[d.id] = d.name;
  }
  for (const m of s.members) names[m.id] = m.name;
  function twice(key: string, action: () => void) {
    if (confirm === key) {
      setConfirm('');
      action();
    } else {
      setConfirm(key);
      setTimeout(() => setConfirm((c) => (c === key ? '' : c)), 4000);
    }
  }
  const conversation = (readOnly: boolean) => (
    <ConversationView
      entries={s.timeline}
      me={s.me}
      others={others}
      names={names}
      room={room}
      readOnly={readOnly}
      t={t}
      onError={setError}
    />
  );

  const status =
    s.phase === 'ended'
      ? t('Closed')
      : s.connection === 'reconnecting' && s.phase === 'in-room'
        ? t('Reconnecting…')
        : s.phase === 'in-room'
          ? t('Connected')
          : t('Waiting…');
  return (
    <>
      <div className="session-header">
        <span>
          <span className="status-dot" />
          {t('ROOM')} {s.code && <code className="room-code-inline">{s.code}</code>}
        </span>
        <span className="route-badge" data-testid="room-status">
          <span className="status-dot" />
          {status}
        </span>
      </div>
      <div className="card-body room-view">
        {s.phase === 'ended' ? (
          <>
            <div className="room-ended" data-testid="room-ended" data-reason={s.ended}>
              <div className="card-heading">
                <div>
                  <h2>{t(endings[s.ended ?? 'failed'][0])}</h2>
                  <p role="status">{t(endings[s.ended ?? 'failed'][1])}</p>
                </div>
              </div>
              <button className="primary-button" onClick={onClose}>
                <ArrowLeft size={18} />
                {t('Back')}
              </button>
            </div>
            {s.timeline.length > 0 && conversation(true)}
          </>
        ) : s.phase !== 'in-room' ? (
          <>
            <div className="card-heading">
              <div>
                <h2>{t('Joining the room')}</h2>
                <p>
                  {t('Keep this page open. You’ll join as soon as the room creator lets you in.')}
                </p>
              </div>
            </div>
            <div className="waiting-line" data-testid="room-pending">
              <LoaderCircle size={17} className="spin" />
              {s.phase === 'connecting'
                ? t('Connecting to the room…')
                : s.pending === 'owner-offline'
                  ? t('The room creator is offline. You’ll join when they’re back.')
                  : s.pending === 'approval'
                    ? t('Waiting for the room creator to let you in…')
                    : t('Checking the code with the room creator…')}
            </div>
            <div className="session-footer">
              <span>
                <LockKeyhole size={14} />
                {t('Only people with the code can ask to join')}
              </span>
              <button className="text-button cancel-button" onClick={onClose}>
                {t('Cancel')}
              </button>
            </div>
          </>
        ) : (
          <>
            <JoinRequests snapshot={s} room={room} t={t} />
            <RoomDetails snapshot={s} room={room} t={t} onError={setError} />
            {!s.history && (
              <p className="field-note room-note">
                {t('History can’t be saved in this browser window.')}
              </p>
            )}
            {conversation(false)}
            <Composer snapshot={s} room={room} t={t} onError={setError} />
            <div className="session-footer">
              <span>
                <LockKeyhole size={14} />
                {t('End-to-end encrypted between members')}
              </span>
              {s.isOwner ? (
                <button
                  className="text-button cancel-button"
                  data-testid="dismiss-room"
                  onClick={() => twice('dismiss', () => void room()?.dismiss())}
                >
                  {confirm === 'dismiss'
                    ? t('Click again to close the room for everyone')
                    : t('Close room')}
                </button>
              ) : (
                <button
                  className="text-button cancel-button"
                  onClick={() => twice('leave', () => void room()?.leave())}
                >
                  {confirm === 'leave' ? t('Click again to leave') : t('Leave room')}
                </button>
              )}
            </div>
          </>
        )}
        {(error || (s.message && s.message !== hidden)) && s.phase !== 'ended' && (
          <div className="error-banner room-banner" role="alert">
            <span>{error || t(s.message!)}</span>
            <button
              className="icon-button"
              aria-label={t('Dismiss error')}
              onClick={() => {
                setError('');
                setHidden(s.message ?? '');
              }}
            >
              <X size={16} />
            </button>
          </div>
        )}
      </div>
    </>
  );
}

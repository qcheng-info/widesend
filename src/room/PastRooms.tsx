import { useEffect, useState } from 'react';
import { ArrowLeft, History, Trash2 } from 'lucide-react';
import { formatBytes } from '../format';
import { ConversationView } from './ConversationView';
import { pastTimeline, type TimelineEntry } from './conversation';
import { keptBytes, roomEnded, type HistoryRoom, type HistoryStore } from './history';
import type { MembershipStore } from './environment';
import { clock, type T } from './room-ui';

type Past = { room: HistoryRoom; items: number; bytes: number; open: boolean };
const people = (room: HistoryRoom) =>
  Object.entries(room.names)
    .filter(([id]) => id !== room.me)
    .map(([, name]) => name);

// Rooms this device was in, newest first. A room it can still rejoin opens again;
// the others can be read or deleted.
export function PastRooms({
  history,
  memberships,
  onOpen,
  onView,
  t,
}: {
  history: HistoryStore;
  memberships: MembershipStore;
  onOpen: (locator: string) => void;
  onView: (locator: string) => void;
  t: T;
}) {
  const [rooms, setRooms] = useState<Past[]>([]);
  const [confirm, setConfirm] = useState('');
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let stale = false;
    void (async () => {
      try {
        const now = Date.now();
        const list: Past[] = [];
        for (const room of await history.rooms()) {
          const items = await history.items(room.locator);
          const member = await memberships.get(room.locator).catch(() => undefined);
          list.push({
            room,
            items: items.length,
            bytes: keptBytes(items),
            open: !roomEnded(room, now) && !!member && member.expires > now,
          });
        }
        if (!stale) setRooms(list.filter((p) => p.items > 0 || p.open));
      } catch {
        if (!stale) setRooms([]); // No history in this browser window.
      }
    })();
    return () => {
      stale = true;
    };
  }, [history, memberships, version]);
  if (!rooms.length) return null;
  async function remove(locator: string) {
    if (confirm !== locator) {
      setConfirm(locator);
      setTimeout(() => setConfirm((c) => (c === locator ? '' : c)), 4000);
      return;
    }
    setConfirm('');
    await history.deleteRoom(locator).catch(() => {});
    setVersion((v) => v + 1);
  }
  return (
    <section className="past-rooms" aria-label={t('Past rooms')} data-testid="past-rooms">
      <h3>
        <History size={15} />
        {t('Past rooms')}
      </h3>
      <ul>
        {rooms.map(({ room, items, bytes, open }) => (
          <li key={room.locator} data-testid="past-room" data-code={room.code}>
            <span className="past-room-text">
              <strong>{people(room).join(', ') || t('Only you')}</strong>
              <small>
                {[
                  clock(room.updated, document.documentElement.lang || undefined),
                  t(items === 1 ? '{count} item' : '{count} items', { count: items }),
                  bytes ? formatBytes(bytes) : '',
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </small>
            </span>
            {open ? (
              <button className="secondary-button" onClick={() => onOpen(room.locator)}>
                {t('Open')}
              </button>
            ) : (
              <>
                <button className="secondary-button" onClick={() => onView(room.locator)}>
                  {t('View')}
                </button>
                <button
                  className="text-button cancel-button"
                  onClick={() => void remove(room.locator)}
                >
                  <Trash2 size={14} />
                  {confirm === room.locator ? t('Delete?') : t('Delete')}
                </button>
              </>
            )}
          </li>
        ))}
      </ul>
      <p className="field-note">{t('Kept only on this device until you delete it.')}</p>
    </section>
  );
}

// A past room's conversation, read-only.
export function PastRoom({
  history,
  locator,
  onBack,
  t,
}: {
  history: HistoryStore;
  locator: string;
  onBack: () => void;
  t: T;
}) {
  const [past, setPast] = useState<{ room: HistoryRoom; entries: TimelineEntry[] }>();
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    let release: (() => void) | undefined,
      stale = false;
    void pastTimeline(history, locator)
      .catch(() => undefined)
      .then((found) => {
        if (stale) return found?.release();
        if (!found) return setMissing(true);
        release = found.release;
        setPast(found);
      });
    return () => {
      stale = true;
      release?.();
    };
  }, [history, locator]);
  const others = past ? Object.keys(past.room.names).filter((id) => id !== past.room.me) : [];
  return (
    <div className="card-body room-view past-room">
      <div className="card-heading">
        <div>
          <h2>{past ? people(past.room).join(', ') || t('Only you') : t('Past rooms')}</h2>
          {past && (
            <p>
              {t('Room {code}', { code: past.room.code })} ·{' '}
              {clock(past.room.joined, document.documentElement.lang || undefined)}
            </p>
          )}
        </div>
      </div>
      {missing && (
        <p className="field-note">{t('This conversation is no longer on this device.')}</p>
      )}
      {past && (
        <ConversationView
          entries={past.entries}
          me={past.room.me}
          others={others}
          names={past.room.names}
          readOnly
          t={t}
          onError={() => {}}
        />
      )}
      <button className="secondary-button past-back" onClick={onBack}>
        <ArrowLeft size={16} />
        {t('Back')}
      </button>
    </div>
  );
}

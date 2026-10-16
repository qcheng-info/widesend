import { useLayoutEffect, useRef, useState } from 'react';
import { ArrowDownToLine, Check, Copy, File as FileIcon } from 'lucide-react';
import { formatBytes } from '../format';
import type { TimelineDelivery, TimelineEntry } from './conversation';
import type { Room } from './room';
import { Progress, clock, roomError, type T } from './room-ui';

const receiving: Record<string, string> = {
  offered: 'Wants to send you files',
  accepted: 'Starting…',
  transferring: 'Receiving…',
  complete: 'Received',
  declined: 'Declined',
  failed: 'Failed',
  cancelled: 'Cancelled',
};
const moving = (s?: string) => s === 'accepted' || s === 'transferring';
const done = (s: string) => s === 'delivered' || s === 'complete';
const final = (s: string) =>
  ['delivered', 'complete', 'refused', 'failed', 'declined', 'cancelled'].includes(s);

function deliveryText(d: TimelineDelivery, t: T): string {
  switch (d.status) {
    case 'delivered':
    case 'complete':
      return t('Delivered');
    case 'sending':
    case 'offered':
      return d.online ? t('Sending…') : t('Waiting for {name}', { name: d.name });
    case 'accepted':
    case 'transferring':
      return t('Sending…');
    case 'refused':
      return t('Not allowed');
    case 'declined':
      return t('Declined');
    case 'cancelled':
      return t('Cancelled');
    default:
      return t('Not delivered');
  }
}
function summary(deliveries: TimelineDelivery[], t: T): string {
  if (deliveries.length === 1) return deliveryText(deliveries[0], t);
  const count = deliveries.filter((d) => done(d.status)).length;
  if (count === deliveries.length) return t('Delivered');
  const waiting = deliveries.find((d) => !final(d.status));
  if (!count && waiting) return deliveryText(waiting, t);
  return t('Delivered to {done} of {count}', { done: count, count: deliveries.length });
}
// "To you", "To Bob": shown only when an item didn't go to everyone.
function audience(
  e: TimelineEntry,
  me: string,
  others: string[],
  names: Record<string, string>,
  t: T,
): string | undefined {
  if (!e.to.length) return undefined;
  const name = (id: string) => names[id] || '?';
  if (e.mine) {
    if (others.every((id) => e.to.includes(id))) return undefined;
    return t('To {names}', { names: e.to.map(name).join(', ') });
  }
  const rest = others.filter((id) => id !== e.from);
  if (rest.every((id) => e.to.includes(id))) return undefined;
  const also = e.to.filter((id) => id !== me);
  return also.length ? t('To you and {names}', { names: also.map(name).join(', ') }) : t('To you');
}

function Files({ entry: e, t }: { entry: TimelineEntry; t: T }) {
  return (
    <ul className="offer-files">
      {e.files!.map((file) => {
        const kept = e.kept.find((k) => k.id === file.id);
        const image = kept?.url && file.type.startsWith('image/');
        return (
          <li key={file.id} className={image ? 'with-image' : ''}>
            {/* Shown, never opened: the type is the sender's claim, and a received
                file opened as a page would run on this site. */}
            {image && (
              <img className="kept-image" data-testid="kept-image" src={kept.url} alt={file.name} />
            )}
            <span className="file-line">
              {!image && <FileIcon size={17} className="room-file-icon" />}
              <span className="file-description">
                <strong>{file.name}</strong>
                <span>
                  {formatBytes(file.size)}
                  {kept?.missing ? ` · ${t('No longer on this device')}` : ''}
                </span>
              </span>
              {kept?.url && (
                <a
                  className="secondary-button"
                  data-testid="kept-download"
                  href={kept.url}
                  download={file.name}
                >
                  <ArrowDownToLine size={15} />
                  {t('Download')}
                </a>
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function Item({
  entry: e,
  me,
  others,
  names,
  room,
  readOnly,
  t,
  onError,
}: {
  entry: TimelineEntry;
  me: string;
  others: string[];
  names: Record<string, string>;
  room?: () => Room | undefined;
  readOnly?: boolean;
  t: T;
  onError: (message: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  const to = audience(e, me, others, names, t);
  const inc = e.incoming,
    out = e.outgoing;
  const live = !readOnly && room;
  async function copy() {
    try {
      await navigator.clipboard.writeText(e.text ?? '');
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      onError(t('Clipboard access was blocked. Select and copy the text manually.'));
    }
  }
  async function accept() {
    try {
      await room?.()?.accept(e.id);
    } catch (error) {
      onError(roomError(error, t));
    }
  }
  return (
    <article
      className={`bubble ${e.mine ? 'mine' : ''} ${e.kind}`}
      data-testid="timeline-item"
      data-kind={e.kind}
      data-mine={e.mine}
    >
      {(!e.mine || to) && (
        <div className="bubble-head">
          {!e.mine && <strong>{e.fromName}</strong>}
          {to && <span>{to}</span>}
        </div>
      )}
      {e.kind === 'text' ? (
        <p className="message-text" data-testid="message-text">
          {e.text}
        </p>
      ) : e.mine ? (
        <div className="offer-block" data-testid="outgoing-offer">
          <Files entry={e} t={t} />
          {out?.preparing !== undefined && (
            <span className="offer-message">
              {t('Checking files… {percent}%', { percent: Math.floor(out.preparing * 100) })}
            </span>
          )}
          <ul className="delivery-list">
            {e.deliveries.map((d) => {
              const r = out?.recipients.find((x) => x.id === d.id);
              return (
                <li
                  key={d.id}
                  data-testid="delivery"
                  data-status={d.status}
                  data-member={d.name}
                  data-route={r?.route ?? ''}
                >
                  <span className="delivery-name">{d.name}</span>
                  <span className="delivery-status">
                    {deliveryText(d, t)}
                    {d.status === 'transferring' && r
                      ? ` · ${r.route === 'direct' ? t('Direct') : t('Relay')}`
                      : ''}
                  </span>
                  {d.status === 'transferring' && r && (
                    <Progress
                      value={r.transferred}
                      total={e.total ?? 0}
                      label="Transfer progress"
                      t={t}
                    />
                  )}
                  {r?.message && <small>{t(r.message)}</small>}
                </li>
              );
            })}
          </ul>
          {live && out?.recipients.some((r) => !final(r.status)) && (
            <button
              className="text-button cancel-button"
              onClick={() => room?.()?.cancelOutgoing(e.id)}
            >
              {t('Cancel sending')}
            </button>
          )}
        </div>
      ) : (
        <div
          className={`offer-block ${e.status ?? ''}`}
          data-testid="incoming-offer"
          data-status={e.status}
          data-route={inc?.route ?? ''}
        >
          <Files entry={e} t={t} />
          <span className="offer-message">
            {t(receiving[e.status ?? 'failed'] ?? 'Failed')} ·{' '}
            {t(e.files!.length === 1 ? '{count} file' : '{count} files', {
              count: e.files!.length,
            })}{' '}
            · {formatBytes(e.total ?? 0)}
            {inc?.status === 'transferring' && inc.speed > 0
              ? ` · ${formatBytes(inc.speed)}/s`
              : ''}
            {inc && inc.route !== 'connecting' && moving(inc.status)
              ? ` · ${inc.route === 'direct' ? t('Direct') : t('Relay')}`
              : ''}
          </span>
          {inc?.message && <p className="offer-message">{t(inc.message)}</p>}
          {inc && moving(inc.status) && (
            <Progress value={inc.transferred} total={inc.total} label="Transfer progress" t={t} />
          )}
          {live && inc?.status === 'offered' && (
            <div className="offer-actions">
              <button className="primary-button" onClick={() => void accept()}>
                <ArrowDownToLine size={17} />
                {t('Accept')}
              </button>
              <button className="secondary-button" onClick={() => room?.()?.decline(e.id)}>
                {t('Decline')}
              </button>
            </div>
          )}
          {live && inc && moving(inc.status) && (
            <button
              className="text-button cancel-button"
              onClick={() => room?.()?.cancelIncoming(e.id)}
            >
              {t('Cancel')}
            </button>
          )}
        </div>
      )}
      <div className="bubble-meta">
        <time dateTime={new Date(e.at).toISOString()}>
          {clock(e.at, document.documentElement.lang || undefined)}
        </time>
        {e.mine && e.kind === 'text' && e.deliveries.length > 0 && (
          <span className="bubble-status">{summary(e.deliveries, t)}</span>
        )}
        {e.kind === 'text' && (
          <button
            className="icon-button bubble-copy"
            aria-label={copied ? t('Copied') : t('Copy')}
            onClick={() => void copy()}
          >
            {copied ? <Check size={14} /> : <Copy size={14} />}
          </button>
        )}
      </div>
    </article>
  );
}

// The conversation: newest at the bottom, following new items while you're there.
export function ConversationView({
  entries,
  me,
  others,
  names,
  room,
  readOnly,
  t,
  onError,
}: {
  entries: TimelineEntry[];
  me: string;
  // Everyone else in the room, to tell when an item didn't go to all of them.
  others: string[];
  names: Record<string, string>;
  room?: () => Room | undefined;
  readOnly?: boolean;
  t: T;
  onError: (message: string) => void;
}) {
  const log = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  useLayoutEffect(() => {
    if (following.current && log.current) log.current.scrollTop = log.current.scrollHeight;
  }, [entries]);
  return (
    <div
      className="timeline"
      role="log"
      aria-label={t('Conversation')}
      data-testid="timeline"
      ref={log}
      tabIndex={0}
      onScroll={(event) => {
        const el = event.currentTarget;
        following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      }}
    >
      {entries.length === 0 ? (
        <p className="timeline-empty">{t('Nothing here yet. Messages and files appear here.')}</p>
      ) : (
        entries.map((e) => (
          <Item
            key={e.id}
            entry={e}
            me={me}
            others={others}
            names={names}
            room={room}
            readOnly={readOnly}
            t={t}
            onError={onError}
          />
        ))
      )}
    </div>
  );
}

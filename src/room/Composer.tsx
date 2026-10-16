import { useLayoutEffect, useRef, useState } from 'react';
import { File as FileIcon, LoaderCircle, Paperclip, Send, X } from 'lucide-react';
import { MAX_FILES } from '../../shared/protocol';
import { MAX_MESSAGE, canSend } from '../../shared/room';
import { formatBytes } from '../format';
import type { Room, RoomSnapshot } from './room';
import { roomError, type T } from './room-ui';

// Where the next message goes: everyone allowed, or the people picked. Kept
// between sends.
type Audience = 'everyone' | string[];
const touch = () => typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
// Safari ends an input method's composition before the Enter that confirmed it,
// which then arrives with isComposing false. Other browsers flag that Enter.
const safari = typeof navigator !== 'undefined' && /Apple/.test(navigator.vendor);

export function Composer({
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
  const [text, setText] = useState('');
  const [staged, setStaged] = useState<File[]>([]);
  const [audience, setAudience] = useState<Audience>('everyone');
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  // When an input method's text was last confirmed (see onKeyDown).
  const composed = useRef(-Infinity);
  // The text box grows with its text, up to a few lines, then scrolls.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight + 2, 168)}px`;
  }, [text]);
  const others = s.members.filter((m) => !m.me);
  const allowed = others.filter(
    (m) => s.settings && s.owner && canSend(s.settings, s.owner, s.me, m.id),
  );
  if (!allowed.length)
    return others.length ? (
      <p className="field-note room-note composer-note">
        {s.settings?.send === 'to-owner'
          ? t('In this room members send only to the room creator.')
          : t('Only the room creator can send in this room.')}
      </p>
    ) : null;

  const chosen =
    audience === 'everyone'
      ? allowed.map((m) => m.id)
      : audience.filter((id) => allowed.some((m) => m.id === id));
  const length = text.length;
  const tooLong = length > MAX_MESSAGE;
  const ready = !busy && !tooLong && chosen.length > 0 && (!!text.trim() || staged.length > 0);

  function stage(list: FileList | File[] | null) {
    if (!list?.length) return;
    const next = [...staged, ...Array.from(list)];
    if (next.length > MAX_FILES) return onError(t('Choose between 1 and 100 files to send.'));
    setStaged(next);
  }
  function toggle(id: string, on: boolean) {
    const current = audience === 'everyone' ? allowed.map((m) => m.id) : audience;
    const next = on ? [...new Set([...current, id])] : current.filter((x) => x !== id);
    setAudience(allowed.every((m) => next.includes(m.id)) ? 'everyone' : next);
  }
  async function send() {
    if (!ready) return;
    setBusy(true);
    try {
      if (text.trim()) {
        await room()?.sendMessage(text, chosen);
        setText('');
      }
      if (staged.length) {
        await room()?.send(staged, chosen);
        setStaged([]);
      }
    } catch (error) {
      onError(roomError(error, t));
    } finally {
      setBusy(false);
      box.current?.focus();
    }
  }
  return (
    <div
      className={`composer ${dragging ? 'dragging' : ''}`}
      data-testid="composer"
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        stage(event.dataTransfer.files);
      }}
    >
      {allowed.length > 1 && (
        <fieldset className="recipients composer-to" data-testid="room-recipients">
          <legend>{t('To')}</legend>
          <label className="choice">
            <input
              type="checkbox"
              checked={audience === 'everyone'}
              onChange={(event) => setAudience(event.target.checked ? 'everyone' : [])}
            />
            <span>{t('Everyone')}</span>
          </label>
          {allowed.map((m) => (
            <label key={m.id} className={`choice ${m.online ? '' : 'offline'}`}>
              <input
                type="checkbox"
                checked={chosen.includes(m.id)}
                onChange={(event) => toggle(m.id, event.target.checked)}
              />
              <span>{m.name}</span>
            </label>
          ))}
        </fieldset>
      )}
      {staged.length > 0 && (
        <ul className="staged-files" aria-label={t('Files to send')}>
          {staged.map((file, i) => (
            <li key={`${file.name}-${i}`} data-testid="staged-file">
              <FileIcon size={15} className="room-file-icon" />
              <span>
                <strong>{file.name || t('Pasted file')}</strong>
                <small>{formatBytes(file.size)}</small>
              </span>
              <button
                className="icon-button"
                aria-label={t('Remove {name}', { name: file.name })}
                onClick={() => setStaged(staged.filter((_, index) => index !== i))}
              >
                <X size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="composer-row">
        <input
          ref={input}
          type="file"
          multiple
          hidden
          data-testid="room-file-input"
          onChange={(event) => {
            stage(event.target.files);
            event.target.value = '';
          }}
        />
        <button
          className="icon-button composer-attach"
          aria-label={t('Attach files')}
          onClick={() => input.current?.click()}
        >
          <Paperclip size={18} />
        </button>
        <textarea
          ref={box}
          className="composer-text"
          data-testid="composer-text"
          aria-label={t('Message')}
          placeholder={t('Write a message')}
          rows={1}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onPaste={(event) => {
            const files = Array.from(event.clipboardData?.files ?? []);
            if (!files.length) return;
            event.preventDefault();
            stage(files);
          }}
          onCompositionEnd={(event) => {
            composed.current = event.timeStamp;
          }}
          onKeyDown={(event) => {
            // Enter sends (Shift+Enter: new line). Never while an input method is
            // composing, and on touch screens Enter is a new line.
            if (
              event.key !== 'Enter' ||
              event.shiftKey ||
              event.nativeEvent.isComposing ||
              event.keyCode === 229 ||
              touch()
            )
              return;
            event.preventDefault();
            if (safari && event.timeStamp - composed.current < 100) return;
            void send();
          }}
        />
        <button
          className="primary-button composer-send"
          disabled={!ready}
          onClick={() => void send()}
        >
          {busy ? <LoaderCircle className="spin" size={17} /> : <Send size={17} />}
          {t('Send')}
        </button>
      </div>
      {length > MAX_MESSAGE - 1000 && (
        <p className={`composer-count ${tooLong ? 'over' : ''}`} aria-live="polite">
          {t('{count} of {limit} characters', {
            count: length.toLocaleString(),
            limit: MAX_MESSAGE.toLocaleString(),
          })}
        </p>
      )}
    </div>
  );
}

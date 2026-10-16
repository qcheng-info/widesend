import { useState } from 'react';
import { ArrowRight, LoaderCircle, UsersRound } from 'lucide-react';
import { CodeInput } from '../CodeInput';
import type { JoinMode, RoomSettings, SendMode } from '../../shared/room';
import { deviceName } from './browser';
import type { RoomEnvironment } from './environment';
import { PastRoom, PastRooms } from './PastRooms';

const nameKey = 'widesend-room-name';
export const SIZES = [2, 3, 4, 5, 6, 8, 10, 12, 15, 20];
function rememberedName(): string {
  try {
    return localStorage.getItem(nameKey) || deviceName();
  } catch {
    return deviceName();
  }
}
export function cleanName(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 40)
    .trim();
}
export function SettingsFields({
  settings,
  onChange,
  minimumSize = 2,
  t,
}: {
  settings: RoomSettings;
  onChange: (s: RoomSettings) => void;
  minimumSize?: number;
  t: (text: string, values?: Record<string, string | number>) => string;
}) {
  return (
    <div className="room-settings">
      <fieldset>
        <legend>{t('Who can join')}</legend>
        {(
          [
            ['auto', 'Anyone with the code'],
            ['approve', 'Only people I approve'],
          ] as [JoinMode, string][]
        ).map(([value, label]) => (
          <label key={value} className="choice">
            <input
              type="radio"
              name="room-join"
              checked={settings.join === value}
              onChange={() => onChange({ ...settings, join: value })}
            />
            <span>{t(label)}</span>
          </label>
        ))}
      </fieldset>
      <label className="field">
        <span>{t('Room size')}</span>
        <select
          value={settings.size}
          onChange={(event) => onChange({ ...settings, size: Number(event.target.value) })}
        >
          {SIZES.filter((n) => n >= minimumSize).map((n) => (
            <option key={n} value={n}>
              {t('Up to {count} people', { count: n })}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>{t('Who can send')}</span>
        <select
          value={settings.send}
          onChange={(event) => onChange({ ...settings, send: event.target.value as SendMode })}
        >
          <option value="everyone">{t('Everyone, to anyone')}</option>
          <option value="to-owner">{t('Members send only to me')}</option>
          <option value="owner">{t('Only me')}</option>
        </select>
      </label>
    </div>
  );
}

export function RoomHome({
  mode,
  initialCode,
  busy,
  environment,
  onCreate,
  onJoin,
  onOpen,
  t,
}: {
  // The home screen's Create a room and Join a room tabs.
  mode: 'create' | 'join';
  initialCode: string;
  busy: boolean;
  environment: RoomEnvironment;
  onCreate: (name: string, settings: RoomSettings) => void;
  onJoin: (code: string, name: string) => void;
  onOpen: (locator: string) => void;
  t: (text: string, values?: Record<string, string | number>) => string;
}) {
  const [name, setName] = useState(rememberedName);
  const [code, setCode] = useState(initialCode);
  const [viewing, setViewing] = useState<string>();
  // Only the creator sends until they let others.
  const [settings, setSettings] = useState<RoomSettings>({
    join: 'auto',
    size: 10,
    send: 'owner',
  });
  const cleaned = cleanName(name);
  function remember() {
    try {
      localStorage.setItem(nameKey, cleaned);
    } catch {
      /* Optional convenience. */
    }
  }
  if (viewing)
    return (
      <PastRoom
        history={environment.history}
        locator={viewing}
        onBack={() => setViewing(undefined)}
        t={t}
      />
    );
  return (
    <div className="card-body room-home">
      <div className="card-heading">
        <div>
          <h2>{mode === 'create' ? t('Share with a group') : t('Join a room')}</h2>
          <p>
            {mode === 'create'
              ? t(
                  'Create a room, invite people with a code, then talk and share files. Small files arrive on their own.',
                )
              : t('Enter the room code to talk and share files with the group.')}
          </p>
        </div>
        <span className="room-mark" aria-hidden="true">
          <UsersRound size={22} />
        </span>
      </div>
      <form
        className="room-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!cleaned) return;
          remember();
          if (mode === 'create') onCreate(cleaned, settings);
          else if (/^[A-Z0-9]{6}$/.test(code)) onJoin(code, cleaned);
        }}
      >
        <label className="field">
          <span>{t('Your name in the room')}</span>
          <input
            value={name}
            maxLength={40}
            autoComplete="nickname"
            data-testid="room-name"
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        {mode === 'create' ? (
          <SettingsFields settings={settings} onChange={setSettings} t={t} />
        ) : (
          <div className="field">
            <span id="room-code-label">{t('Room code')}</span>
            <CodeInput
              value={code}
              onChange={setCode}
              characterLabel={(index) => t('Code character {index} of 6', { index })}
              labelledBy="room-code-label"
              describedBy="room-code-hint"
              firstId="room-code-input"
            />
          </div>
        )}
        <div className="action-row">
          <span className="selection-caption" id={mode === 'join' ? 'room-code-hint' : undefined}>
            {mode === 'create'
              ? t('The room stays open for up to 24 hours.')
              : t('Ask the room creator for the code or link.')}
          </span>
          <button
            className="primary-button"
            type="submit"
            disabled={busy || !cleaned || (mode === 'join' && !/^[A-Z0-9]{6}$/.test(code))}
          >
            {busy && <LoaderCircle className="spin" size={18} />}
            {mode === 'create' ? t('Create room') : t('Join room')}
            <ArrowRight size={18} />
          </button>
        </div>
      </form>
      <PastRooms
        history={environment.history}
        memberships={environment.store}
        onOpen={onOpen}
        onView={setViewing}
        t={t}
      />
    </div>
  );
}

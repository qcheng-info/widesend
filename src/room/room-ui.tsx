import { publicError } from '../messages';

// Pieces shared by the room screens.
export type T = (text: string, values?: Record<string, string | number>) => string;

export function roomError(error: unknown, t: T): string {
  const message = error instanceof Error ? error.message : '';
  // Messages the room engine raises are already safe and translated.
  const known = [
    'Choose between 1 and 100 files to send.',
    'This room does not allow sending to the selected members.',
    'One of these files has an unsupported name or size.',
    'This room no longer allows files from this member.',
    'Join the room first.',
    'Write a message first.',
    'Messages can be up to 10,000 characters.',
  ];
  return t(known.includes(message) ? message : publicError(error));
}

export function Progress({
  value,
  total,
  label,
  t,
}: {
  value: number;
  total: number;
  label: string;
  t: T;
}) {
  const percent = total ? Math.min(100, (value / total) * 100) : 100;
  return (
    <div
      className="progress-track room-progress"
      role="progressbar"
      aria-label={t(label)}
      aria-valuenow={Math.floor(percent)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div style={{ width: `${percent}%` }} />
    </div>
  );
}

// "14:05" today, "3 Oct, 14:05" on other days, in the page's language.
export function clock(at: number, language?: string): string {
  const date = new Date(at);
  const today = new Date().toDateString() === date.toDateString();
  return date.toLocaleString(language, {
    ...(today ? {} : { day: 'numeric', month: 'short' }),
    hour: '2-digit',
    minute: '2-digit',
  });
}

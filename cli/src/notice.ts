import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { About } from '../../src/site';
import type { Screen } from './ui';

function configFolder(): string {
  if (process.env.XDG_CONFIG_HOME) return join(process.env.XDG_CONFIG_HOME, 'widesend');
  try {
    return join(homedir(), '.config', 'widesend');
  } catch {
    return '';
  }
}

/**
 * Says once per server who runs it and what it keeps. Remembered in
 * servers.json; if that can't be read or written, it is said every time.
 */
export function serverNotice(
  server: URL,
  about: About,
  screen: Screen,
  folder = configFolder(),
): void {
  const file = folder && join(folder, 'servers.json');
  let seen: string[] = [];
  try {
    const stored = JSON.parse(readFileSync(file, 'utf8')).seen;
    if (Array.isArray(stored)) seen = stored.filter((s) => typeof s === 'string');
  } catch {
    /* First run, or nothing usable remembered. */
  }
  if (seen.includes(server.origin)) return;
  const kept = about.fileNames
    ? 'IP addresses, codes, file names, sizes and fingerprints'
    : 'IP addresses, codes, sizes and fingerprints';
  // A server that doesn't say (an older one) may keep a log, so the notice says it might.
  const record =
    about.activity === false
      ? 'Its operator keeps no record of transfers.'
      : `Its operator keeps an activity log for ${about.retentionDays} days: ${kept}.`;
  screen.warn(
    `Using ${server.host}. Files are end-to-end encrypted and never stored there. ${record} To use your own server, add --server.`,
  );
  try {
    mkdirSync(folder, { recursive: true });
    writeFileSync(file, JSON.stringify({ seen: [...seen, server.origin] }));
  } catch {
    /* Shown again next time. */
  }
}

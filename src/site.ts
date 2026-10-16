import type { FileMeta } from '../shared/protocol';

// The deployment's site name, which every client puts into its key exchanges so
// that all addresses of one deployment (and the CLI through an API host) can pair.
// Learned from /api/health; without it, this page's own address, as before.
let site: string | undefined;
let fileNames = true;
let apiHost = false;
/** What the page tells visitors about this site (How it works). */
export type About = {
  // Undefined when the server doesn't say (an older server): no claim either way.
  activity?: boolean;
  fileNames: boolean;
  retentionDays: number;
  publicInstance: boolean;
  source?: string;
};
const RETENTION_DAYS = 90;
let about: About = { fileNames, retentionDays: RETENTION_DAYS, publicInstance: false };

export type Health = {
  protocol?: unknown;
  site?: unknown;
  fileNames?: unknown;
  apiHost?: unknown;
  activity?: unknown;
  retentionDays?: unknown;
  publicInstance?: unknown;
  source?: unknown;
};
export type SiteAnswer =
  | { status: 'ok'; health: Health }
  // The server has no health endpoint: an older deployment, used under its own address.
  | { status: 'missing' }
  // No answer after every attempt: the network or the server is down.
  | { status: 'unreachable' };
type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

/** Learns the site name, trying a few times; the previous name stays in use meanwhile. */
export async function loadSite(
  fetcher: Fetcher = fetch,
  base: string = location.origin,
  { timeout = 3000, attempts = 3, pause = 1000 } = {},
): Promise<SiteAnswer> {
  let answer: SiteAnswer = { status: 'unreachable' };
  for (let attempt = 0; attempt < attempts && answer.status === 'unreachable'; attempt++) {
    if (attempt) await new Promise((resolve) => setTimeout(resolve, pause * attempt));
    answer = await ask(fetcher, `${base}/api/health`, timeout);
  }
  const health = answer.status === 'ok' ? answer.health : {};
  site = typeof health.site === 'string' && isOrigin(health.site) ? health.site : undefined;
  fileNames = health.fileNames !== false;
  apiHost = health.apiHost === true;
  about = {
    activity: typeof health.activity === 'boolean' ? health.activity : undefined,
    fileNames,
    retentionDays:
      Number.isSafeInteger(health.retentionDays) && (health.retentionDays as number) > 0
        ? (health.retentionDays as number)
        : RETENTION_DAYS,
    publicInstance: health.publicInstance === true,
    source:
      typeof health.source === 'string' && isWebPage(health.source) ? health.source : undefined,
  };
  return answer;
}
export const aboutSite = (): About => about;
function isWebPage(value: string): boolean {
  try {
    return /^https?:$/.test(new URL(value).protocol);
  } catch {
    return false;
  }
}
async function ask(fetcher: Fetcher, url: string, timeout: number): Promise<SiteAnswer> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeout);
  try {
    const response = await fetcher(url, { signal: abort.signal, cache: 'no-store' });
    if (response.status === 404) return { status: 'missing' };
    if (!response.ok) return { status: 'unreachable' };
    return { status: 'ok', health: (await response.json()) as Health };
  } catch {
    return { status: 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
}
function isOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return /^https?:$/.test(url.protocol) && url.origin === value;
  } catch {
    return false;
  }
}
export const siteName = () => site ?? location.origin;
/** Whether this deployment's activity log keeps file names. */
export const recordsFileNames = () => fileNames;
/**
 * Where a page opened on an API-only host belongs: the same place on the site.
 * `hash` is the link's original #CODE, which the page removes from its address early.
 */
export function apiHostTarget(hash: string = location.hash): string | undefined {
  if (!apiHost || !site || site === location.origin) return;
  // Set the parts rather than resolving a path: "//evil.com" must stay on the site.
  const target = new URL(site);
  target.pathname = location.pathname;
  target.search = location.search;
  target.hash = hash;
  return target.href;
}
/** File details as reported to a deployment that doesn't record names. */
export const reportedFiles = <T extends Pick<FileMeta, 'id' | 'name'>>(files: T[]): T[] =>
  fileNames ? files : files.map((file) => ({ ...file, name: `file ${file.id + 1}` }));

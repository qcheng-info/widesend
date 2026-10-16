import { Writable } from 'node:stream';
import { mkdtemp, readFile, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { About } from '../../../src/site';
import { prepareServer, UPDATE } from '../../src/server';
import { serverNotice } from '../../src/notice';
import { DEFAULT_SERVER, shareLink } from '../../src/link';
import { siteName } from '../../../src/site';
import { Screen } from '../../src/ui';

class Sink extends Writable {
  text = '';
  _write(chunk: Buffer, _: string, done: () => void) {
    this.text += chunk.toString();
    done();
  }
}
const server = new URL('https://r.widesend.app');
const answer = (body: unknown, status = 200) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status }));
beforeEach(() => {
  vi.stubGlobal('location', new URL(server.origin));
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the server', () => {
  it('is r.widesend.app unless told otherwise', () => {
    expect(DEFAULT_SERVER).toBe('https://r.widesend.app');
  });
  it('names the site that keys and links use', async () => {
    const fetcher = answer({
      ok: true,
      protocol: 2,
      site: 'https://widesend.app',
      fileNames: true,
    });
    await prepareServer(server, fetcher);
    expect(fetcher).toHaveBeenCalledWith('https://r.widesend.app/api/health', expect.anything());
    expect(siteName()).toBe('https://widesend.app');
    expect(shareLink('A1B2C3')).toBe('https://widesend.app/#A1B2C3');
  });
  it('falls back to its own address when it has no site name', async () => {
    await prepareServer(server, answer({ error: 'Not found' }, 404));
    expect(shareLink('A1B2C3')).toBe('https://r.widesend.app/#A1B2C3');
  });
  it('stops with a clear message when the server can’t be reached', async () => {
    const quick = { timeout: 20, attempts: 2, pause: 1 };
    for (const fetcher of [
      vi.fn(async () => Promise.reject(new Error('ECONNREFUSED'))),
      answer({ error: 'busy' }, 503),
    ])
      await expect(prepareServer(server, fetcher, quick)).rejects.toThrow(
        'Could not reach r.widesend.app. Check the connection and try again.',
      );
  });
  it('asks for an update when the server speaks a newer protocol', async () => {
    await expect(prepareServer(server, answer({ ok: true, protocol: 3 }))).rejects.toThrow(UPDATE);
    expect(UPDATE).toContain('npm install -g widesend@latest');
  });
});

describe('the first-run notice', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'widesend-notice-'));
  });
  afterEach(async () => {
    await chmod(join(dir, 'locked'), 0o600).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  });
  // What the server says about itself in /api/health (src/site.ts aboutSite).
  const site = (about: Partial<About> = {}): About => ({
    activity: true,
    fileNames: true,
    retentionDays: 90,
    publicInstance: false,
    ...about,
  });
  const shown = (about: Partial<About> = {}, folder = dir) => {
    const err = new Sink();
    serverNotice(server, site(about), new Screen(new Sink(), err), folder);
    return err.text;
  };
  it('says what the server keeps, once per server', async () => {
    const text = shown();
    expect(text).toContain('Using r.widesend.app.');
    expect(text).toContain('end-to-end encrypted');
    expect(text).toContain('IP addresses, codes, file names, sizes and fingerprints');
    expect(text).toContain('--server');
    expect(shown()).toBe('');
    expect(JSON.parse(await readFile(join(dir, 'servers.json'), 'utf8')).seen).toEqual([
      'https://r.widesend.app',
    ]);
  });
  it('leaves file names out when the server doesn’t record them', () => {
    expect(shown({ fileNames: false })).toContain('IP addresses, codes, sizes and fingerprints');
  });
  it('says when the server keeps no activity record', () => {
    const text = shown({ activity: false });
    expect(text).toContain('Its operator keeps no record of transfers.');
    expect(text).not.toContain('IP addresses');
  });
  it('still mentions a possible record when an older server doesn’t say', () => {
    expect(shown({ activity: undefined })).toContain('activity log for 90 days');
  });
  it('still shows, and never fails, when it can’t remember', async () => {
    await writeFile(join(dir, 'servers.json'), 'not json');
    expect(shown()).toContain('Using r.widesend.app.');
    const locked = join(dir, 'locked');
    await writeFile(locked, '');
    await chmod(locked, 0o400);
    // A file where the folder should be: nothing can be written there.
    expect(shown({}, join(locked, 'widesend'))).toContain('Using r.widesend.app.');
    expect(shown({}, join(locked, 'widesend'))).toContain('Using r.widesend.app.');
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { aboutSite, apiHostTarget, loadSite, recordsFileNames, siteName } from '../../src/site';
import { ActivityReporter } from '../../src/activity';
import { Reporter } from '../../src/room/reporter';

const answer = (body: unknown) => vi.fn(async () => new Response(JSON.stringify(body)));
beforeEach(() => {
  vi.stubGlobal('location', { origin: 'https://page.example' });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the site name', () => {
  it('comes from the server, with whether file names are recorded', async () => {
    const fetcher = answer({
      ok: true,
      protocol: 2,
      site: 'https://widesend.app',
      fileNames: false,
    });
    await loadSite(fetcher);
    expect(fetcher).toHaveBeenCalledWith('https://page.example/api/health', expect.anything());
    expect(siteName()).toBe('https://widesend.app');
    expect(recordsFileNames()).toBe(false);
  });
  it('falls back to this page’s address when the server can’t say', async () => {
    await loadSite(answer({ site: 'https://widesend.app', fileNames: false }));
    await loadSite(vi.fn(async () => Promise.reject(new Error('offline'))));
    expect(siteName()).toBe('https://page.example');
    expect(recordsFileNames()).toBe(true);
    await loadSite(answer({ ok: true, protocol: 2 }));
    expect(siteName()).toBe('https://page.example');
  });
  it('ignores a site that is not just an address', async () => {
    for (const site of ['https://widesend.app/path', 'javascript:alert(1)', 42, ''])
      await loadSite(answer({ site })).then(() =>
        expect(siteName(), String(site)).toBe('https://page.example'),
      );
  });
  it('gives up after its time limit', async () => {
    const never = vi.fn(
      (_: string, init?: RequestInit) =>
        new Promise<Response>((_, reject) =>
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))),
        ),
    );
    await loadSite(never, 'https://page.example', { timeout: 20, attempts: 1 });
    expect(siteName()).toBe('https://page.example');
  });
});

describe('what the site says about itself', () => {
  it('keeps what the server reports', async () => {
    await loadSite(
      answer({
        site: 'https://widesend.app',
        fileNames: false,
        activity: true,
        retentionDays: 90,
        publicInstance: true,
        source: 'https://example.com/widesend',
      }),
    );
    expect(aboutSite()).toEqual({
      activity: true,
      fileNames: false,
      retentionDays: 90,
      publicInstance: true,
      source: 'https://example.com/widesend',
    });
  });
  it('claims nothing about records when an older server does not say', async () => {
    await loadSite(answer({ ok: true, protocol: 2 }));
    expect(aboutSite()).toEqual({
      activity: undefined,
      fileNames: true,
      retentionDays: 90,
      publicInstance: false,
      source: undefined,
    });
  });
  it('drops values of the wrong kind', async () => {
    await loadSite(
      answer({ activity: 'yes', retentionDays: -1, publicInstance: 1, source: 'javascript:x' }),
    );
    expect(aboutSite()).toMatchObject({
      activity: undefined,
      retentionDays: 90,
      publicInstance: false,
      source: undefined,
    });
  });
});

describe('learning the site name', () => {
  const quick = { timeout: 50, attempts: 3, pause: 1 };
  it('tries again before giving up on the server', async () => {
    const flaky = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(new Response('busy', { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ site: 'https://widesend.app' })));
    expect((await loadSite(flaky, 'https://page.example', quick)).status).toBe('ok');
    expect(flaky).toHaveBeenCalledTimes(3);
    expect(siteName()).toBe('https://widesend.app');
  });
  it('tells an unreachable server from one without a health endpoint', async () => {
    const down = vi.fn(async () => new Response('down', { status: 502 }));
    expect((await loadSite(down, 'https://page.example', quick)).status).toBe('unreachable');
    expect(down).toHaveBeenCalledTimes(3);
    const old = vi.fn(async () => new Response('Not found', { status: 404 }));
    expect((await loadSite(old, 'https://page.example', quick)).status).toBe('missing');
    expect(old).toHaveBeenCalledTimes(1);
  });
  it('keeps the name it has while it asks again', async () => {
    await loadSite(answer({ site: 'https://widesend.app' }));
    let reply!: (r: Response) => void;
    const pending = loadSite(() => new Promise<Response>((resolve) => (reply = resolve)));
    expect(siteName()).toBe('https://widesend.app');
    reply(new Response(JSON.stringify({ site: 'https://other.example' })));
    await pending;
    expect(siteName()).toBe('https://other.example');
  });
});

describe('a page on an API-only host', () => {
  it('goes to the same place on the site, code included', async () => {
    vi.stubGlobal('location', new URL('https://r.widesend.app/receive?x=1#A1B2C3'));
    await loadSite(answer({ site: 'https://widesend.app', apiHost: true }));
    expect(apiHostTarget()).toBe('https://widesend.app/receive?x=1#A1B2C3');
  });
  it('keeps the code even after the page has tidied its address bar', async () => {
    // The page removes #CODE from its address as soon as it starts.
    vi.stubGlobal('location', new URL('https://r.widesend.app/'));
    await loadSite(answer({ site: 'https://widesend.app', apiHost: true }));
    expect(apiHostTarget('#A1B2C3')).toBe('https://widesend.app/#A1B2C3');
  });
  it('stays on the site, whatever its path looks like', async () => {
    vi.stubGlobal('location', new URL('https://r.widesend.app//evil.com/x'));
    await loadSite(answer({ site: 'https://widesend.app', apiHost: true }));
    expect(new URL(apiHostTarget()!).host).toBe('widesend.app');
  });
  it('stays put elsewhere', async () => {
    await loadSite(answer({ site: 'https://widesend.app', apiHost: false }));
    expect(apiHostTarget()).toBeUndefined();
  });
});

describe('activity reports when file names are off', () => {
  it('replace one-to-one file names with placeholders', async () => {
    await loadSite(answer({ site: 'https://widesend.app', fileNames: false }));
    const sent: string[] = [];
    vi.stubGlobal('WebSocket', { OPEN: 1 });
    const reporter = new ActivityReporter();
    reporter.attach({
      readyState: 1,
      bufferedAmount: 0,
      send: (m: string) => sent.push(m),
    } as never);
    const file = { id: 1, name: 'secret.pdf', size: 3, type: '' };
    reporter.report('manifest', { event: 'manifest', files: [{ ...file, id: 0 }, file] });
    reporter.report('file', { event: 'file', file, md5: '1'.repeat(32), sha256: '2'.repeat(64) });
    const reports = sent.map((m) => JSON.parse(m).report);
    expect(reports[0].files.map((f: { name: string }) => f.name)).toEqual(['file 1', 'file 2']);
    expect(reports[1].file.name).toBe('file 2');
  });
  it('replace room offer file names with placeholders', async () => {
    await loadSite(answer({ fileNames: false }));
    const sent: { report: { files: { name: string }[] } }[] = [];
    const reporter = new Reporter((m) => {
      sent.push(m as (typeof sent)[number]);
      return true;
    });
    reporter.report('offer', {
      event: 'offer',
      offer: 'a'.repeat(32),
      files: [{ id: 0, name: 'holiday.jpg', size: 1, type: '' }],
      md5: ['1'.repeat(32)],
      sha256: ['2'.repeat(64)],
      recipients: [],
    });
    expect(sent[0].report.files[0].name).toBe('file 1');
  });
  it('keep real names when the server records them', async () => {
    await loadSite(answer({ fileNames: true }));
    const sent: { report: { files: { name: string }[] } }[] = [];
    new Reporter((m) => {
      sent.push(m as (typeof sent)[number]);
      return true;
    }).report('offer', {
      event: 'offer',
      offer: 'a'.repeat(32),
      files: [{ id: 0, name: 'holiday.jpg', size: 1, type: '' }],
      md5: ['1'.repeat(32)],
      sha256: ['2'.repeat(64)],
      recipients: [],
    });
    expect(sent[0].report.files[0].name).toBe('holiday.jpg');
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import type { Miniflare } from 'miniflare';
import { pairingCode, roomId, token } from '../../src/crypto';
import {
  ORIGIN,
  joinHello,
  openRoom,
  ownerSetup,
  randomId,
  shareRuntime,
} from '../fixtures/share-runtime';

// Deployment settings: the site name clients put in their keys, API-only hosts,
// and whether file names are recorded in the activity log.
const runtimes: Miniflare[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((mf) => mf.dispose()));
});
async function runtime(vars: Record<string, unknown> = {}, activity = true) {
  const result = await shareRuntime({ vars, activity });
  runtimes.push(result.mf);
  return result;
}
const health = async (mf: Miniflare, url: string) => (await mf.dispatchFetch(url)).json();

describe('site settings', () => {
  it('reports the configured site name and that file names are recorded', async () => {
    const { mf } = await runtime({ SITE: 'https://widesend.app' });
    expect(await health(mf, 'https://r.widesend.app/api/health')).toEqual({
      ok: true,
      protocol: 2,
      site: 'https://widesend.app',
      fileNames: true,
      apiHost: false,
      activity: true,
      retentionDays: 90,
      publicInstance: false,
    });
  });
  it('says when it keeps no activity record', async () => {
    const { mf } = await runtime({}, false);
    expect(await health(mf, `${ORIGIN}/api/health`)).toMatchObject({ activity: false });
  });
  it('says when it is a public instance, and where its source is', async () => {
    const { mf } = await runtime({
      PUBLIC_INSTANCE: true,
      SOURCE_URL: 'https://example.com/widesend',
    });
    expect(await health(mf, `${ORIGIN}/api/health`)).toMatchObject({
      publicInstance: true,
      source: 'https://example.com/widesend',
    });
  });
  it('drops a source address that is not a web page', async () => {
    for (const SOURCE_URL of ['javascript:alert(1)', 'not a url']) {
      const { mf } = await runtime({ SOURCE_URL });
      expect(await health(mf, `${ORIGIN}/api/health`), SOURCE_URL).not.toHaveProperty('source');
    }
  });
  it('names itself after its own address when no site is configured', async () => {
    const { mf } = await runtime({ RECORD_FILE_NAMES: false });
    expect(await health(mf, `${ORIGIN}/api/health`)).toMatchObject({
      site: ORIGIN,
      fileNames: false,
    });
  });
  it('tells a page on an API-only host that it should be on the site', async () => {
    const { mf } = await runtime({ SITE: 'https://widesend.app', API_HOSTS: ['r.widesend.app'] });
    expect(await health(mf, 'https://r.widesend.app/api/health')).toMatchObject({ apiHost: true });
    expect(await health(mf, `${ORIGIN}/api/health`)).toMatchObject({ apiHost: false });
  });
  it('never redirects off the site, and never to itself', async () => {
    const { mf } = await runtime({ SITE: 'https://widesend.app', API_HOSTS: ['r.widesend.app'] });
    for (const path of ['//evil.com/x?q=1', '/\\evil.com/x'])
      expect(
        new URL(
          (
            await mf.dispatchFetch(`https://r.widesend.app${path}`, { redirect: 'manual' })
          ).headers.get('Location')!,
        ).host,
        path,
      ).toBe('widesend.app');
    const unnamed = await runtime({ API_HOSTS: ['r.widesend.app'] });
    const page = await unnamed.mf.dispatchFetch('https://r.widesend.app/', { redirect: 'manual' });
    expect(page.status).toBe(200);
  });
  it('keeps working with a malformed site setting', async () => {
    const { mf } = await runtime({ SITE: 'not a url' });
    expect(await health(mf, `${ORIGIN}/api/health`)).toMatchObject({ ok: true, site: ORIGIN });
  });
  it('sends pages on an API-only host to the site and keeps its API', async () => {
    const { mf } = await runtime({ SITE: 'https://widesend.app', API_HOSTS: ['r.widesend.app'] });
    for (const path of ['/', '/receive?x=1'])
      expect(
        (
          await mf.dispatchFetch(`https://r.widesend.app${path}`, { redirect: 'manual' })
        ).headers.get('Location'),
      ).toBe(`https://widesend.app${path}`);
    expect((await mf.dispatchFetch('https://r.widesend.app/api/health')).status).toBe(200);
    expect((await mf.dispatchFetch('https://r.widesend.app/api/missing')).status).toBe(404);
    // Other hosts still serve the site.
    expect(await (await mf.dispatchFetch(`${ORIGIN}/`)).text()).toBe('website');
  });
});

describe('file names switched off', { timeout: 30_000 }, () => {
  it('keeps no names of one-to-one transfer files, whatever a page sends', async () => {
    const { mf, db } = await runtime({ RECORD_FILE_NAMES: false });
    const code = pairingCode();
    const hello = {
      code,
      role: 'send',
      credential: token(32),
      expires: Date.now() + 86_000_000,
      pairExpires: Date.now() + 1_000_000,
    };
    const response = await mf.dispatchFetch(`${ORIGIN}/api/rooms/${await roomId(code)}`, {
      headers: {
        Origin: ORIGIN,
        Upgrade: 'websocket',
        'Sec-WebSocket-Protocol': `widesend, ${Buffer.from(JSON.stringify(hello)).toString('base64url')}`,
        'CF-Connecting-IP': '192.0.2.1',
      },
    });
    const socket = response.webSocket!;
    const acks: string[] = [];
    socket.addEventListener('message', (event) => {
      if (typeof event.data === 'string' && JSON.parse(event.data).type === 'audit-ack')
        acks.push(JSON.parse(event.data).id);
    });
    socket.accept();
    const file = { id: 0, name: 'secret plans.pdf', size: 3, type: 'application/pdf' };
    const reports = [
      { event: 'manifest', files: [file] },
      { event: 'file', file, md5: '1'.repeat(32), sha256: '2'.repeat(64) },
    ];
    for (const report of reports)
      socket.send(JSON.stringify({ type: 'audit', id: crypto.randomUUID(), report }));
    await expect.poll(() => acks.length).toBe(2);
    expect((await db.prepare('SELECT name,size,sha256 FROM files').all()).results).toEqual([
      { name: '', size: 3, sha256: '2'.repeat(64) },
    ]);
  });
  it('keeps no names of room offer files', async () => {
    const { mf, db } = await runtime({ RECORD_FILE_NAMES: false });
    const owner = await ownerSetup();
    const ownerSocket = await openRoom(mf, owner.locator, owner.hello, '198.51.100.1');
    const hello = joinHello(owner.code, 'Alice');
    const alice = await openRoom(mf, owner.locator, hello, '198.51.100.2');
    await ownerSocket.next('join-request', (m) => m.id === hello.member);
    ownerSocket.send({
      type: 'admit',
      id: hello.member,
      key: '04' + 'ab'.repeat(64),
      cert: 'cd'.repeat(64),
    });
    await alice.next('admitted');
    const id = crypto.randomUUID();
    ownerSocket.send({
      type: 'audit',
      id,
      report: {
        event: 'offer',
        offer: randomId(),
        files: [{ id: 0, name: 'holiday.jpg', size: 2048, type: 'image/jpeg' }],
        md5: ['1'.repeat(32)],
        sha256: ['3'.repeat(64)],
        recipients: [hello.member],
      },
    });
    await ownerSocket.next('audit-ack', (m) => m.id === id);
    expect((await db.prepare('SELECT name,size FROM share_offer_files').all()).results).toEqual([
      { name: '', size: 2048 },
    ]);
  });
});

import { describe, expect, it } from 'vitest';
import { parseHello } from '../../worker/handshake';
import { token } from '../../src/crypto';
import { MAX_RECEIVERS, PAIRING_MS } from '../../shared/protocol';

const request = (hello: object) =>
  new Request(`https://widesend.test/api/rooms/${'a'.repeat(64)}`, {
    headers: {
      'Sec-WebSocket-Protocol': `widesend, ${Buffer.from(JSON.stringify(hello)).toString('base64url')}`,
    },
  });
const sender = { role: 'send', credential: token(32) };

describe('handshake', () => {
  it('keeps a code open for twenty minutes', () => {
    expect(PAIRING_MS).toBe(20 * 60 * 1000);
  });
  it('accepts a sender slot within the code’s uses', async () => {
    expect(await parseHello(request({ ...sender, uses: 3, slot: 2 }))).toMatchObject({
      uses: 3,
      slot: 2,
    });
    expect(await parseHello(request({ ...sender, uses: MAX_RECEIVERS }))).toMatchObject({
      uses: 10,
    });
  });
  it.each([
    { uses: 0 },
    { uses: 11 },
    { uses: 2.5 },
    { uses: '2' },
    { uses: 2, slot: 2 },
    { slot: 1 },
    { uses: 2, slot: -1 },
  ])('refuses a sender hello with %o', async (fields) => {
    await expect(parseHello(request({ ...sender, ...fields }))).rejects.toThrow();
  });
  it('refuses slot fields from a receiver', async () => {
    await expect(
      parseHello(request({ role: 'receive', credential: token(32), uses: 2 })),
    ).rejects.toThrow();
    await expect(
      parseHello(request({ role: 'receive', credential: token(32), slot: 0 })),
    ).rejects.toThrow();
  });
});

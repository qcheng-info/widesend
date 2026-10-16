import { expect, it } from 'vitest';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { p256 } from '@noble/curves/nist.js';
import { Spake2, passwordScalar } from '../../src/spake2';
import {
  KeySession,
  createIdentity,
  PAIRING_ERROR,
  type DeviceIdentity,
} from '../../src/key-session';
import { Cipher, decodeControl } from '../../src/crypto';
import vectors from '../fixtures/spake2-rfc9382.json';

const utf8 = new TextEncoder();
it('matches the application password profile against Python/OpenSSL scrypt', async () => {
  // Independently computed with hashlib.scrypt using the documented parameters.
  expect(await passwordScalar('AB1234')).toBe(
    0x7e28c85420eeafc4c3bd6099c266152d4444c519f71995f312f05571ba58331fn,
  );
});
for (const v of vectors)
  it(`matches RFC 9382 vector A=${v.A}, B=${v.B}`, () => {
    const a = new Spake2('send', BigInt(`0x${v.w}`), BigInt(`0x${v.x}`));
    const b = new Spake2('receive', BigInt(`0x${v.w}`), BigInt(`0x${v.y}`));
    expect(bytesToHex(a.share)).toBe(v.pA);
    expect(bytesToHex(b.share)).toBe(v.pB);
    const ak = a.finish(b.share, utf8.encode(v.A), utf8.encode(v.B));
    const bk = b.finish(a.share, utf8.encode(v.A), utf8.encode(v.B));
    expect(ak.key).toEqual(bk.key);
    expect(bytesToHex(ak.key)).toBe(v.Ke);
    expect(bytesToHex(ak.transcriptHash)).toBe(v['HASH(TT)'] ?? v['Hash(TT)']);
    expect(bytesToHex(ak.confirmation)).toBe(v['A conf']);
    expect(bytesToHex(bk.confirmation)).toBe(v['B conf']);
    expect(ak.expected).toEqual(bk.confirmation);
    expect(bk.expected).toEqual(ak.confirmation);
    expect(() => a.finish(b.share, utf8.encode(v.A), utf8.encode(v.B))).toThrow();
  });

async function pair(
  aid?: DeviceIdentity,
  bid?: DeviceIdentity,
  bcode = 'AB1234',
  borigin = 'https://widesend.test',
) {
  aid ??= await createIdentity();
  bid ??= await createIdentity();
  const round = crypto.randomUUID();
  const [a, b] = await Promise.all([
    KeySession.start('AB1234', 'send', aid, 'https://widesend.test', 'room', 123456, round),
    KeySession.start(bcode, 'receive', bid, borigin, 'room', 123456, round),
  ]);
  return { a, b, aid, bid };
}
async function finish(p: Awaited<ReturnType<typeof pair>>) {
  const [ca, cb] = await Promise.all([p.a.receiveShare(p.b.share), p.b.receiveShare(p.a.share)]);
  const [a, b] = await Promise.all([p.a.confirm(cb), p.b.confirm(ca)]);
  return { a, b, ca, cb };
}
it('mutually confirms and pins identities before exchanging encrypted data', async () => {
  const p = await pair();
  const { a, b } = await finish(p);
  expect(a.peerKey).toBe(p.bid.publicKey);
  expect(b.peerKey).toBe(p.aid.publicKey);
  expect(p.aid.privateKey.extractable).toBe(false);
  await expect(crypto.subtle.exportKey('jwk', p.aid.privateKey)).rejects.toThrow();
  const frame = await a.cipher.control({ type: 'complete' });
  expect(decodeControl(await b.cipher.open(frame))).toEqual({ type: 'complete' });
  await expect(a.cipher.open(frame)).rejects.toThrow();
});
it('rejects a wrong code and a changed origin instead of releasing a cipher', async () => {
  for (const args of [
    ['XY9876', 'https://widesend.test'],
    ['AB1234', 'https://evil.test'],
  ]) {
    const p = await pair(undefined, undefined, ...(args as [string, string]));
    const ca = await p.a.receiveShare(p.b.share),
      cb = await p.b.receiveShare(p.a.share);
    await expect(p.a.confirm(cb)).rejects.toThrow(PAIRING_ERROR);
    await expect(p.b.confirm(ca)).rejects.toThrow(PAIRING_ERROR);
  }
});
it('does not accept a confirmation before a share, twice, or with a modified proof', async () => {
  const p = await pair();
  const ca = await p.a.receiveShare(p.b.share);
  await expect(p.b.confirm(ca)).rejects.toThrow();
  await expect(p.a.receiveShare(p.b.share)).rejects.toThrow();
  const cb = await p.b.receiveShare(p.a.share);
  if (cb.step !== 'confirm') throw Error();
  await expect(p.a.confirm({ ...cb, signature: '00'.repeat(64) })).rejects.toThrow();
  await expect(p.a.confirm(cb)).rejects.toThrow();
});
it('rejects invalid points, infinity after unmasking, and reflected shares', async () => {
  const v = vectors[0];
  const w = BigInt(`0x${v.w}`);
  const invalid = [
    new Uint8Array(65),
    new Uint8Array(1),
    p256.Point.fromHex('03d8bbd6c639c62937b04d997f38c3770719c629d7014d49a24b4f98baa1292b49')
      .multiply(w)
      .toBytes(false),
  ];
  for (const point of invalid)
    expect(() =>
      new Spake2('send', w, 17n).finish(point, utf8.encode('a'), utf8.encode('b')),
    ).toThrow();
  const p = await pair();
  await expect(p.a.receiveShare(p.a.share)).rejects.toThrow();
});
it('resumes with fresh keys and rejects code-only impersonation of a pinned device', async () => {
  const p = await pair();
  const first = await finish(p);
  const oldFrame = await first.a.cipher.control({ type: 'complete' });
  const aid = structuredClone({ ...p.aid, peerKey: first.a.peerKey });
  const bid = structuredClone({ ...p.bid, peerKey: first.b.peerKey });
  const next = await pair(aid, bid),
    resumed = await finish(next);
  expect(next.a.share).not.toEqual(p.a.share);
  await expect(resumed.b.cipher.open(oldFrame)).rejects.toThrow();
  const impostor = await pair(aid); // knows the code, owns a different private key
  await expect(impostor.a.receiveShare(impostor.b.share)).rejects.toThrow(PAIRING_ERROR);
  const forged = await pair(aid, { ...(await createIdentity()), publicKey: bid.publicKey });
  await forged.a.receiveShare(forged.b.share);
  const forgedConfirmation = await forged.b.receiveShare(forged.a.share);
  await expect(forged.a.confirm(forgedConfirmation)).rejects.toThrow(PAIRING_ERROR);
});
it('recovers when only one side saved its peer pin before interruption', async () => {
  const p = await pair();
  const ca = await p.a.receiveShare(p.b.share),
    cb = await p.b.receiveShare(p.a.share);
  const a = await p.a.confirm(cb);
  // Sender saved the pin; receiver never got ca. Both already saved their own keys.
  const next = await pair({ ...p.aid, peerKey: a.peerKey }, p.bid);
  await expect(finish(next)).resolves.toBeDefined();
  await expect(next.a.confirm(ca)).rejects.toThrow();
});
it('rejects replayed traffic but permits bounded cross-transport reordering', async () => {
  const secret = hexToBytes('0123456789abcdef0123456789abcdef');
  const a = await Cipher.create(secret, 'send', utf8.encode('session'));
  const b = await Cipher.create(secret, 'receive', utf8.encode('session'));
  const first = await a.control({ type: 'complete' }),
    second = await a.control({ type: 'complete' });
  await b.open(second);
  await b.open(first);
  await expect(b.open(first)).rejects.toThrow('Replayed');
  const third = await a.control({ type: 'complete' });
  const fake = third.slice(0);
  new DataView(fake).setBigUint64(4, 2n ** 60n);
  await expect(b.open(fake)).rejects.toThrow();
  await expect(b.open(third)).resolves.toBeDefined();
  const other = await Cipher.create(secret, 'receive', utf8.encode('other session'));
  await expect(other.open(third)).rejects.toThrow();
});

it('bounds replay history and keeps file and control windows independent', async () => {
  const secret = hexToBytes('0123456789abcdef0123456789abcdef');
  const a = await Cipher.create(secret, 'send', utf8.encode('replay-window'));
  const b = await Cipher.create(secret, 'receive', utf8.encode('replay-window'));
  const frames = await Promise.all(
    Array.from({ length: 8193 }, () => a.control({ type: 'complete' })),
  );
  await b.open(frames[8192]);
  await expect(b.open(frames[0])).rejects.toThrow('Replayed');
  await expect(b.open(frames[1])).resolves.toBeDefined();
  const file = await a.chunk(0, 0, new Uint8Array([42]).buffer);
  await expect(b.open(file)).resolves.toBeDefined();
  await expect(b.open(file)).rejects.toThrow('Replayed');
});

import { describe, expect, it } from 'vitest';
import { createIdentity } from '../../src/key-session';
import {
  LinkHandshake,
  linkRole,
  signCertificate,
  signOffer,
  validateOffer,
  verifyCertificate,
  verifyOffer,
  type CertFields,
  type OfferBody,
} from '../../src/room/identity';
import { PIECE_SIZE } from '../../shared/room';

const locator = 'f'.repeat(64);
const low = '0'.repeat(31) + '1';
const high = 'e'.repeat(32);

describe('member certificates', () => {
  it('verify only with the owner key and the exact fields', async () => {
    const owner = await createIdentity();
    const member = await createIdentity();
    const fields: CertFields = {
      locator,
      member: high,
      role: 'member',
      name: 'Blue Fox',
      key: member.publicKey,
      expires: 1_900_000_000_000,
    };
    const cert = await signCertificate(owner.privateKey, fields);
    expect(cert).toMatch(/^[0-9a-f]{128}$/);
    expect(await verifyCertificate(owner.publicKey, fields, cert)).toBe(true);
    const changes: Partial<CertFields>[] = [
      { locator: 'e'.repeat(64) },
      { member: low },
      { role: 'owner' },
      { name: 'Red Fox' },
      { key: owner.publicKey },
      { expires: fields.expires + 1 },
    ];
    for (const change of changes)
      expect(await verifyCertificate(owner.publicKey, { ...fields, ...change }, cert)).toBe(false);
    expect(await verifyCertificate(member.publicKey, fields, cert)).toBe(false);
    expect(await verifyCertificate(owner.publicKey, fields, 'zz')).toBe(false);
    expect(await verifyCertificate('04' + '00'.repeat(64), fields, cert)).toBe(false);
  });
});

describe('signed offers', () => {
  const body: OfferBody = {
    id: 'c'.repeat(32),
    sender: low,
    files: [
      { id: 0, name: 'report.pdf', size: 1234, type: 'application/pdf' },
      { id: 1, name: 'empty', size: 0, type: '' },
    ],
    pieceSize: PIECE_SIZE,
    roots: ['1'.repeat(64), '2'.repeat(64)],
    sha256: ['3'.repeat(64), '4'.repeat(64)],
    md5: ['5'.repeat(32), '6'.repeat(32)],
    created: 1_800_000_000_000,
  };
  it('verifies an untouched offer and rejects any change', async () => {
    const sender = await createIdentity();
    const offer = await signOffer(sender.privateKey, locator, body);
    expect(validateOffer(JSON.parse(JSON.stringify(offer)))).toEqual(offer);
    expect(await verifyOffer(sender.publicKey, locator, offer)).toBe(true);
    expect(await verifyOffer(sender.publicKey, 'e'.repeat(64), offer)).toBe(false);
    const tampered = [
      { ...offer, roots: ['7'.repeat(64), '2'.repeat(64)] },
      { ...offer, files: [{ ...offer.files[0], name: 'other.pdf' }, offer.files[1]] },
      { ...offer, files: [{ ...offer.files[0], size: 1 }, offer.files[1]] },
      { ...offer, sender: high },
    ];
    for (const value of tampered)
      expect(await verifyOffer(sender.publicKey, locator, value)).toBe(false);
    const stranger = await createIdentity();
    expect(await verifyOffer(stranger.publicKey, locator, offer)).toBe(false);
  });
  it('rejects malformed offers', async () => {
    const sender = await createIdentity();
    const offer = await signOffer(sender.privateKey, locator, body);
    const bad = [
      { ...offer, pieceSize: 1024 },
      { ...offer, roots: ['1'.repeat(64)] },
      { ...offer, md5: ['x'.repeat(32), '6'.repeat(32)] },
      { ...offer, files: [] },
      { ...offer, files: [{ ...offer.files[0], name: 'a/b' }, offer.files[1]] },
      { ...offer, sig: 'short' },
      { ...offer, id: 'nope' },
      { ...offer, created: 1.5 },
    ];
    for (const value of bad) expect(() => validateOffer(value)).toThrow();
  });
});

describe('link handshake', () => {
  async function members() {
    const a = { id: low, identity: await createIdentity() };
    const b = { id: high, identity: await createIdentity() };
    return { a, b };
  }
  it('assigns the send role to the lower member ID', () => {
    expect(linkRole(low, high)).toBe('send');
    expect(linkRole(high, low)).toBe('receive');
  });
  it('derives working ciphers in both directions', async () => {
    const { a, b } = await members();
    const start = await LinkHandshake.start(a, { id: b.id, key: b.identity.publicKey }, locator);
    const reply = await LinkHandshake.start(
      b,
      { id: a.id, key: a.identity.publicKey },
      locator,
      start.round,
    );
    const [ab, ba] = await Promise.all([start.finish(reply.hello), reply.finish(start.hello)]);
    const message = new Uint8Array([0, 1, 2, 3]);
    expect(await ba.open(await ab.seal(message.slice()))).toEqual(message);
    expect(await ab.open(await ba.seal(message.slice()))).toEqual(message);
  });
  it('rejects hellos signed by the wrong key, from another round, or for another pair', async () => {
    const { a, b } = await members();
    const mallory = await createIdentity();
    const start = await LinkHandshake.start(a, { id: b.id, key: b.identity.publicKey }, locator);
    // Signed by an uncertified key claiming to be b.
    const forged = await LinkHandshake.start(
      { id: b.id, identity: mallory },
      { id: a.id, key: a.identity.publicKey },
      locator,
      start.round,
    );
    await expect(start.finish(forged.hello)).rejects.toThrow();

    const second = await LinkHandshake.start(a, { id: b.id, key: b.identity.publicKey }, locator);
    const otherRound = await LinkHandshake.start(
      b,
      { id: a.id, key: a.identity.publicKey },
      locator,
    );
    await expect(second.finish(otherRound.hello)).rejects.toThrow();

    // b's hello addressed to someone else can't be replayed to a.
    const third = await LinkHandshake.start(a, { id: b.id, key: b.identity.publicKey }, locator);
    const elsewhere = await LinkHandshake.start(
      b,
      { id: 'd'.repeat(32), key: a.identity.publicKey },
      locator,
      third.round,
    );
    await expect(third.finish(elsewhere.hello)).rejects.toThrow();
  });
  it('can only finish once', async () => {
    const { a, b } = await members();
    const start = await LinkHandshake.start(a, { id: b.id, key: b.identity.publicKey }, locator);
    const reply = await LinkHandshake.start(
      b,
      { id: a.id, key: a.identity.publicKey },
      locator,
      start.round,
    );
    await start.finish(reply.hello);
    await expect(start.finish(reply.hello)).rejects.toThrow();
  });
});

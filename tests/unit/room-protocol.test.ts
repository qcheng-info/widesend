import { describe, expect, it } from 'vitest';
import {
  CLOSE,
  MAX_FANOUT,
  MAX_PIECE_MESSAGE,
  MAX_UNICAST,
  PIECE_HEADER,
  ROOM_MS,
  ROOM_PROTOCOL,
  canSend,
  validMessageText,
  decodeClientFrame,
  decodeForward,
  decodeHello,
  encodeFanout,
  encodeForward,
  encodeHello,
  encodeUnicast,
  idBytes,
  idHex,
  pieceOfferId,
  readRoomLimits,
  shareLocator,
  validMemberId,
  validName,
  validateRoomAudit,
  validateSettings,
  type RoomHello,
} from '../../shared/room';

const limits = readRoomLimits({ maxMembers: 20 });
const member = 'a'.repeat(32);
const other = 'b'.repeat(32);
const credential = 'C'.repeat(43);
const key = '04' + 'ab'.repeat(64);
const cert = 'cd'.repeat(64);
const now = 1_800_000_000_000;
const settings = { join: 'auto', size: 10, send: 'everyone' } as const;
const header = (hello: unknown) => `${ROOM_PROTOCOL}, ${encodeHello(hello as RoomHello)}`;

describe('room limits and settings', () => {
  it('defaults and validates the operator member cap', () => {
    expect(readRoomLimits()).toEqual({ maxMembers: 20 });
    expect(readRoomLimits({ maxMembers: 50 })).toEqual({ maxMembers: 50 });
    for (const bad of [1, 65, 2.5, '10'])
      expect(() => readRoomLimits({ maxMembers: bad as number })).toThrow();
  });
  it('accepts every valid combination and rejects bad fields', () => {
    for (const join of ['auto', 'approve'])
      for (const send of ['everyone', 'to-owner', 'owner'])
        expect(validateSettings({ join, size: 2, send }, limits)).toEqual({ join, size: 2, send });
    const bad = [
      { ...settings, join: 'open' },
      { ...settings, send: 'all' },
      { ...settings, size: 1 },
      { ...settings, size: 21 },
      { ...settings, size: 3.5 },
      { ...settings, extra: true },
      null,
    ];
    for (const value of bad) expect(() => validateSettings(value, limits)).toThrow();
  });
  it('never allows a size below the current member count', () => {
    expect(() => validateSettings({ ...settings, size: 3 }, limits, 4)).toThrow();
    expect(validateSettings({ ...settings, size: 4 }, limits, 4).size).toBe(4);
  });
});

describe('names and identifiers', () => {
  it('accepts trimmed names up to 40 characters', () => {
    expect(validName('Blue Fox')).toBe(true);
    expect(validName('名'.repeat(40))).toBe(true);
    expect(validName('😀'.repeat(40))).toBe(true);
    for (const bad of ['', ' x', 'x ', 'a'.repeat(41), 'tab\there', 'bell\u0007', '\u007f', 7])
      expect(validName(bad)).toBe(false);
  });
  it('recognises 16-byte hex member IDs and converts them to bytes', () => {
    expect(validMemberId(member)).toBe(true);
    expect(validMemberId('A'.repeat(32))).toBe(false);
    expect(validMemberId('a'.repeat(31))).toBe(false);
    const id = '00ff' + '12'.repeat(14);
    expect(idHex(idBytes(id))).toBe(id);
    expect(() => idBytes('zz'.repeat(16))).toThrow();
  });
  it('derives the room locator separately from one-to-one rooms', async () => {
    const locator = await shareLocator('A1B2C3');
    expect(locator).toMatch(/^[0-9a-f]{64}$/);
    const { roomId } = await import('../../shared/pairing');
    expect(locator).not.toBe(await roomId('A1B2C3'));
    expect(await shareLocator('A1B2C3')).toBe(locator);
  });
});

describe('send permissions', () => {
  const owner = 'o'.padEnd(32, '0').replace('o', 'f');
  const a = '1'.repeat(32);
  const b = '2'.repeat(32);
  it('follows the three room modes', () => {
    const table: [string, string, string, boolean][] = [
      ['everyone', owner, a, true],
      ['everyone', a, b, true],
      ['everyone', a, owner, true],
      ['to-owner', owner, a, true],
      ['to-owner', a, owner, true],
      ['to-owner', a, b, false],
      ['owner', owner, a, true],
      ['owner', a, owner, false],
      ['owner', a, b, false],
    ];
    for (const [send, from, to, allowed] of table)
      expect(
        canSend({ join: 'auto', size: 5, send } as never, owner, from, to),
        `${send} ${from}→${to}`,
      ).toBe(allowed);
    expect(canSend({ join: 'auto', size: 5, send: 'everyone' }, owner, a, a)).toBe(false);
  });
});

describe('room handshake', () => {
  const create = {
    v: 1,
    role: 'create',
    code: 'A1B2C3',
    member,
    credential,
    name: 'Owner',
    key,
    cert,
    expires: now + ROOM_MS,
    settings,
  };
  const join = { v: 1, role: 'join', code: 'A1B2C3', member, credential, name: '小明' };
  const rejoin = { v: 1, role: 'rejoin', member, credential };
  it('round-trips each role, including non-ASCII names', () => {
    for (const hello of [create, join, rejoin])
      expect(decodeHello(header(hello), limits, now)).toEqual(hello);
  });
  it('rejects malformed or out-of-policy handshakes', () => {
    const bad: unknown[] = [
      { ...join, code: 'a1b2c3' },
      { ...join, code: 'ABC' },
      { ...join, credential: 'short' },
      { ...join, member: 'x'.repeat(32) },
      { ...join, name: '' },
      { ...join, role: 'owner' },
      { ...join, v: 2 },
      { ...create, key: undefined },
      { ...create, cert: 'ab' },
      { ...create, settings: { ...settings, size: 99 } },
      { ...create, expires: now + ROOM_MS + 1 },
      { ...create, expires: now },
      { ...rejoin, credential: undefined },
    ];
    for (const hello of bad) expect(() => decodeHello(header(hello), limits, now)).toThrow();
    expect(() => decodeHello(null, limits, now)).toThrow();
    expect(() => decodeHello(`widesend, ${encodeHello(join as RoomHello)}`, limits, now)).toThrow();
    expect(() => decodeHello(`${ROOM_PROTOCOL}, ${'A'.repeat(4000)}`, limits, now)).toThrow();
    expect(() => decodeHello(`${ROOM_PROTOCOL}, !!!`, limits, now)).toThrow();
  });
});

describe('binary frames', () => {
  const piece = (offer = 'c'.repeat(32), size = PIECE_HEADER + 20) => {
    const bytes = new Uint8Array(size);
    bytes[0] = 1;
    bytes.set(idBytes(offer), 1);
    return bytes;
  };
  it('round-trips unicast frames', () => {
    const payload = new Uint8Array([0x11, 1, 2, 3]);
    const frame = decodeClientFrame(encodeUnicast(other, payload).buffer as ArrayBuffer);
    expect(frame.kind).toBe(0);
    expect(frame.to).toBe(other);
    expect([...frame.payload]).toEqual([...payload]);
  });
  it('round-trips fan-out frames and removes duplicate destinations', () => {
    const body = piece();
    const frame = decodeClientFrame(
      encodeFanout([member, other, member], body).buffer as ArrayBuffer,
    );
    expect(frame.kind).toBe(1);
    expect(frame.to).toEqual([member, other]);
    expect([...frame.payload]).toEqual([...body]);
    expect(pieceOfferId(frame.payload)).toBe('c'.repeat(32));
  });
  it('rejects empty, oversized and unknown frames', () => {
    expect(() => encodeFanout([], piece())).toThrow();
    expect(() =>
      encodeFanout(
        Array.from({ length: MAX_FANOUT + 1 }, (_, i) => i.toString(16).padStart(32, '0')),
        piece(),
      ),
    ).toThrow();
    expect(() => encodeUnicast(other, new Uint8Array(MAX_UNICAST + 1))).toThrow();
    expect(() => encodeUnicast(other, new Uint8Array())).toThrow();
    expect(() => encodeFanout([other], piece(undefined, MAX_PIECE_MESSAGE + 1))).toThrow();
    const unknown = encodeUnicast(other, new Uint8Array([1]));
    unknown[0] = 7;
    expect(() => decodeClientFrame(unknown.buffer as ArrayBuffer)).toThrow();
    expect(() => decodeClientFrame(new Uint8Array([0, 1, 2]).buffer)).toThrow();
    const badPiece = piece();
    badPiece[0] = 9;
    expect(() =>
      decodeClientFrame(encodeFanout([other], piece()).buffer as ArrayBuffer),
    ).not.toThrow();
    expect(() => pieceOfferId(badPiece)).toThrow();
    expect(() => pieceOfferId(new Uint8Array(3))).toThrow();
  });
  it('prefixes forwarded frames with the sender', () => {
    const payload = new Uint8Array([9, 8, 7]);
    for (const kind of [0, 1] as const) {
      const forwarded = decodeForward(encodeForward(kind, member, payload).buffer as ArrayBuffer);
      expect(forwarded).toEqual({ kind, from: member, payload });
    }
    expect(() => decodeForward(new Uint8Array([2, ...idBytes(member), 1]).buffer)).toThrow();
  });
});

describe('room activity reports', () => {
  const files = [
    { id: 0, name: 'a.txt', size: 10, type: 'text/plain' },
    { id: 1, name: 'b.bin', size: 0, type: '' },
  ];
  const offer = {
    event: 'offer',
    offer: 'e'.repeat(32),
    files,
    md5: ['1'.repeat(32), '2'.repeat(32)],
    sha256: ['3'.repeat(64), '4'.repeat(64)],
    recipients: [member, other],
  };
  const delivery = {
    event: 'delivery',
    offer: 'e'.repeat(32),
    recipient: other,
    status: 'complete',
    route: 'relay',
  };
  const wrap = (report: unknown) => ({ type: 'audit', id: crypto.randomUUID(), report });
  it('accepts offers and deliveries', () => {
    expect(validateRoomAudit(wrap(offer)).report).toEqual(offer);
    expect(validateRoomAudit(wrap(delivery)).report).toEqual(delivery);
  });
  it('accepts message totals and rejects impossible ones', () => {
    const messages = { event: 'messages', count: 3, bytes: 42 };
    expect(validateRoomAudit(wrap(messages)).report).toEqual(messages);
    for (const bad of [
      { event: 'messages', count: 0, bytes: 0 },
      { event: 'messages', count: 2, bytes: 1 },
      { event: 'messages', count: 1, bytes: 40_001 },
      { event: 'messages', count: 1.5, bytes: 3 },
      { event: 'messages', count: 1_000_001, bytes: 2_000_000 },
      { event: 'messages', count: '3', bytes: 42 },
    ])
      expect(() => validateRoomAudit(wrap(bad))).toThrow();
  });
  it('limits message text to 10,000 characters that are not all blank', () => {
    expect(validMessageText('hi')).toBe(true);
    expect(validMessageText(' line one\nline two ')).toBe(true);
    expect(validMessageText('x'.repeat(10_000))).toBe(true);
    expect(validMessageText('x'.repeat(10_001))).toBe(false);
    expect(validMessageText('  \n ')).toBe(false);
    expect(validMessageText(42)).toBe(false);
  });
  it('rejects malformed reports', () => {
    const bad = [
      { ...offer, md5: ['1'.repeat(32)] },
      { ...offer, sha256: ['x'.repeat(64), '4'.repeat(64)] },
      { ...offer, recipients: [] },
      { ...offer, recipients: [member, member] },
      { ...offer, recipients: ['nope'] },
      { ...offer, files: Array.from({ length: 101 }, (_, id) => ({ ...files[0], id })) },
      { ...delivery, status: 'done' },
      { ...delivery, route: 'mesh' },
      { ...delivery, recipient: 'x' },
      { event: 'status' },
    ];
    for (const report of bad) expect(() => validateRoomAudit(wrap(report))).toThrow();
    expect(() => validateRoomAudit({ type: 'audit', id: 'nope', report: delivery })).toThrow();
  });
});

describe('close codes', () => {
  it('uses the documented values', () => {
    expect(CLOSE).toEqual({
      replaced: 4000,
      expired: 4001,
      invalid: 4002,
      dismissed: 4004,
      full: 4009,
      declined: 4010,
      removed: 4011,
      left: 4012,
      limited: 4013,
      notFound: 4014,
      exists: 4015,
    });
  });
});

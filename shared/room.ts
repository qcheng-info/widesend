import { validateManifest, type FileMeta } from './protocol';
import { validPairingCode } from './pairing';

// Share rooms: one Durable Object per room, many members. Used by the Worker and
// the browser, so everything here is plain data validation and byte layout.
export const ROOM_PROTOCOL = 'widesend-room';
export const ROOM_MS = 24 * 60 * 60 * 1000;
export const JOIN_WAIT_MS = 10 * 60 * 1000;
export const PIECE_SIZE = 512 * 1024;
export const MAX_PENDING = 8;
export const MAX_UNICAST = 128 * 1024;
export const MAX_TEXT = 128 * 1024;
export const MAX_FANOUT = 64;
export const MAX_PROOF = 40;
// version(1) offer(16) file(u16) piece(u32) proofCount(u8)
export const PIECE_HEADER = 24;
export const MAX_PIECE_MESSAGE = PIECE_HEADER + MAX_PROOF * 32 + PIECE_SIZE + 16;
export const CONTROL_ALLOWANCE = 16 * 1024 * 1024;
export const DESTINATION_BACKLOG = 8 * 1024 * 1024;
// Activity a single room may write to D1 over its lifetime (reports beyond this
// are acknowledged but not recorded), bounding row writes to roughly 20k.
export const ROOM_AUDIT_BUDGET = { offers: 300, files: 3000, deliveries: 5000, messages: 1000 };
// Room conversations: text messages travel inside member links.
export const MAX_MESSAGE = 10_000;
// A send (one offer) at or below this size is accepted without asking.
export const AUTO_ACCEPT_BYTES = 100 * 1024 * 1024;
export function validMessageText(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_MESSAGE && value.trim().length > 0;
}
export const CLOSE = {
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
} as const;

export type RoomLimits = { maxMembers: number };
export const DEFAULT_ROOM_LIMITS: RoomLimits = { maxMembers: 20 };
export function readRoomLimits(value?: Partial<RoomLimits>): RoomLimits {
  const limits = { ...DEFAULT_ROOM_LIMITS, ...value };
  if (
    !Number.isSafeInteger(limits.maxMembers) ||
    limits.maxMembers < 2 ||
    limits.maxMembers > MAX_FANOUT
  )
    throw new Error('Invalid room limit configuration.');
  return { maxMembers: limits.maxMembers };
}

export type JoinMode = 'auto' | 'approve';
export type SendMode = 'everyone' | 'to-owner' | 'owner';
export type RoomSettings = { join: JoinMode; size: number; send: SendMode };
export function validateSettings(value: unknown, limits: RoomLimits, minimum = 2): RoomSettings {
  const s = value as RoomSettings;
  if (
    !s ||
    typeof s !== 'object' ||
    Object.keys(s).length !== 3 ||
    !['auto', 'approve'].includes(s.join) ||
    !['everyone', 'to-owner', 'owner'].includes(s.send) ||
    !Number.isSafeInteger(s.size) ||
    s.size < Math.max(2, minimum) ||
    s.size > limits.maxMembers
  )
    throw new Error('Invalid room settings.');
  return { join: s.join, size: s.size, send: s.send };
}

export function validName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value === value.trim() &&
    [...value].length <= 40 &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}
export function validMemberId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{32}$/.test(value);
}
const credentialPattern = /^[A-Za-z0-9_-]{43}$/;
const keyPattern = /^04[0-9a-f]{128}$/;
const signaturePattern = /^[0-9a-f]{128}$/;
export const validKey = (value: unknown): value is string =>
  typeof value === 'string' && keyPattern.test(value);
export const validSignature = (value: unknown): value is string =>
  typeof value === 'string' && signaturePattern.test(value);

export type CreateHello = {
  v: 1;
  role: 'create';
  code: string;
  member: string;
  credential: string;
  name: string;
  key: string;
  cert: string;
  expires: number;
  settings: RoomSettings;
};
export type JoinHello = {
  v: 1;
  role: 'join';
  code: string;
  member: string;
  credential: string;
  name: string;
};
export type RejoinHello = { v: 1; role: 'rejoin'; member: string; credential: string };
export type RoomHello = CreateHello | JoinHello | RejoinHello;

const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromBase64url(text: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Error('Invalid handshake');
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}
export function encodeHello(hello: RoomHello): string {
  return base64url(utf8.encode(JSON.stringify(hello)));
}
export function decodeHello(
  header: string | null,
  limits: RoomLimits,
  now = Date.now(),
): RoomHello {
  const parts = header?.split(',').map((s) => s.trim());
  if (parts?.length !== 2 || parts[0] !== ROOM_PROTOCOL || parts[1].length > 2048)
    throw new Error('Invalid handshake');
  let h: Record<string, unknown>;
  try {
    h = JSON.parse(fromUtf8.decode(fromBase64url(parts[1])));
  } catch {
    throw new Error('Invalid handshake');
  }
  const common =
    h &&
    h.v === 1 &&
    validMemberId(h.member) &&
    typeof h.credential === 'string' &&
    credentialPattern.test(h.credential);
  if (common && h.role === 'rejoin' && Object.keys(h).length === 4)
    return { v: 1, role: 'rejoin', member: h.member as string, credential: h.credential as string };
  if (!common || !validPairingCode(h.code) || !validName(h.name))
    throw new Error('Invalid handshake');
  if (h.role === 'join' && Object.keys(h).length === 6)
    return {
      v: 1,
      role: 'join',
      code: h.code,
      member: h.member as string,
      credential: h.credential as string,
      name: h.name,
    };
  if (
    h.role === 'create' &&
    Object.keys(h).length === 10 &&
    validKey(h.key) &&
    validSignature(h.cert) &&
    Number.isSafeInteger(h.expires) &&
    (h.expires as number) > now &&
    (h.expires as number) <= now + ROOM_MS
  ) {
    let settings: RoomSettings;
    try {
      settings = validateSettings(h.settings, limits);
    } catch {
      throw new Error('Invalid handshake');
    }
    return {
      v: 1,
      role: 'create',
      code: h.code,
      member: h.member as string,
      credential: h.credential as string,
      name: h.name,
      key: h.key,
      cert: h.cert,
      expires: h.expires as number,
      settings,
    };
  }
  throw new Error('Invalid handshake');
}

export async function shareLocator(code: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', utf8.encode(`widesend-share-v1:${code}`));
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function canSend(settings: RoomSettings, owner: string, from: string, to: string): boolean {
  if (from === to) return false;
  if (settings.send === 'everyone') return true;
  if (settings.send === 'to-owner') return from === owner || to === owner;
  return from === owner;
}

export function idBytes(hex: string): Uint8Array {
  if (!validMemberId(hex)) throw new Error('Invalid identifier.');
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}
export function idHex(bytes: Uint8Array): string {
  if (bytes.length !== 16) throw new Error('Invalid identifier.');
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Browser → room: 0x00 ‖ to ‖ payload (unicast) or 0x01 ‖ n ‖ to×n ‖ piece (fan-out).
// Room → browser: kind ‖ from ‖ payload.
export function encodeUnicast(to: string, payload: Uint8Array): Uint8Array {
  if (!payload.length || payload.length > MAX_UNICAST) throw new Error('Invalid frame size.');
  const frame = new Uint8Array(17 + payload.length);
  frame.set(idBytes(to), 1);
  frame.set(payload, 17);
  return frame;
}
export function encodeFanout(to: string[], piece: Uint8Array): Uint8Array {
  const targets = [...new Set(to)];
  if (!targets.length || targets.length > MAX_FANOUT) throw new Error('Invalid recipients.');
  if (piece.length < PIECE_HEADER || piece.length > MAX_PIECE_MESSAGE)
    throw new Error('Invalid frame size.');
  const frame = new Uint8Array(2 + targets.length * 16 + piece.length);
  frame[0] = 1;
  frame[1] = targets.length;
  targets.forEach((id, i) => frame.set(idBytes(id), 2 + i * 16));
  frame.set(piece, 2 + targets.length * 16);
  return frame;
}
export type ClientFrame =
  { kind: 0; to: string; payload: Uint8Array } | { kind: 1; to: string[]; payload: Uint8Array };
export function decodeClientFrame(buffer: ArrayBuffer): ClientFrame {
  const bytes = new Uint8Array(buffer);
  if (bytes[0] === 0) {
    const payload = bytes.subarray(17);
    if (bytes.length < 18 || payload.length > MAX_UNICAST) throw new Error('Invalid frame.');
    return { kind: 0, to: idHex(bytes.subarray(1, 17)), payload };
  }
  if (bytes[0] === 1 && bytes.length >= 2) {
    const count = bytes[1];
    const start = 2 + count * 16;
    const payload = bytes.subarray(start);
    if (
      !count ||
      count > MAX_FANOUT ||
      payload.length < PIECE_HEADER ||
      payload.length > MAX_PIECE_MESSAGE
    )
      throw new Error('Invalid frame.');
    const to = new Set<string>();
    for (let i = 0; i < count; i++) to.add(idHex(bytes.subarray(2 + i * 16, 18 + i * 16)));
    return { kind: 1, to: [...to], payload };
  }
  throw new Error('Invalid frame.');
}
export function encodeForward(kind: 0 | 1, from: string, payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(17 + payload.length);
  frame[0] = kind;
  frame.set(idBytes(from), 1);
  frame.set(payload, 17);
  return frame;
}
export function decodeForward(buffer: ArrayBuffer): {
  kind: 0 | 1;
  from: string;
  payload: Uint8Array;
} {
  const bytes = new Uint8Array(buffer);
  if ((bytes[0] !== 0 && bytes[0] !== 1) || bytes.length < 18) throw new Error('Invalid frame.');
  return { kind: bytes[0], from: idHex(bytes.subarray(1, 17)), payload: bytes.subarray(17) };
}
export function pieceOfferId(piece: Uint8Array): string {
  if (piece.length < PIECE_HEADER || piece[0] !== 1) throw new Error('Invalid piece.');
  return idHex(piece.subarray(1, 17));
}

export type RosterMember = {
  id: string;
  name: string;
  key: string;
  cert: string;
  role: 'owner' | 'member';
  online: boolean;
};
export type Roster = {
  type: 'roster';
  owner: string;
  ownerKey: string;
  settings: RoomSettings;
  members: RosterMember[];
  expires: number;
  pending: number;
};

export type DeliveryStatus =
  'offered' | 'accepted' | 'declined' | 'transferring' | 'complete' | 'failed' | 'cancelled';
export type DeliveryRoute = 'connecting' | 'direct' | 'relay';
export type RoomReport =
  | {
      event: 'offer';
      offer: string;
      files: FileMeta[];
      md5: string[];
      sha256: string[];
      recipients: string[];
    }
  | {
      event: 'delivery';
      offer: string;
      recipient: string;
      status: DeliveryStatus;
      route: DeliveryRoute;
    }
  // Running totals of this member's text messages in the room; never contents.
  | { event: 'messages'; count: number; bytes: number };
export type RoomAudit = { type: 'audit'; id: string; report: RoomReport };
const statuses = [
  'offered',
  'accepted',
  'declined',
  'transferring',
  'complete',
  'failed',
  'cancelled',
];
/** A room report as stored when the deployment doesn't record file names. */
export function roomReportWithoutNames(report: RoomReport): RoomReport {
  return report.event === 'offer'
    ? { ...report, files: report.files.map((file) => ({ ...file, name: '' })) }
    : report;
}

export function validateRoomAudit(value: unknown): RoomAudit {
  const m = value as RoomAudit;
  if (!m || m.type !== 'audit' || typeof m.id !== 'string' || !/^[a-f0-9-]{36}$/.test(m.id))
    throw new Error('Invalid activity report');
  const r = m.report as Record<string, unknown>;
  if (r?.event === 'offer' && validMemberId(r.offer)) {
    const files = validateManifest(r.files);
    const md5 = r.md5 as string[];
    const sha256 = r.sha256 as string[];
    const recipients = r.recipients as string[];
    if (
      !Array.isArray(md5) ||
      !Array.isArray(sha256) ||
      md5.length !== files.length ||
      sha256.length !== files.length ||
      md5.some((h) => typeof h !== 'string' || !/^[a-f0-9]{32}$/.test(h)) ||
      sha256.some((h) => typeof h !== 'string' || !/^[a-f0-9]{64}$/.test(h)) ||
      !Array.isArray(recipients) ||
      !recipients.length ||
      recipients.length > MAX_FANOUT ||
      new Set(recipients).size !== recipients.length ||
      !recipients.every(validMemberId)
    )
      throw new Error('Invalid activity report');
    return {
      type: 'audit',
      id: m.id,
      report: { event: 'offer', offer: r.offer, files, md5, sha256, recipients },
    };
  }
  if (
    r?.event === 'delivery' &&
    validMemberId(r.offer) &&
    validMemberId(r.recipient) &&
    statuses.includes(r.status as string) &&
    ['connecting', 'direct', 'relay'].includes(r.route as string)
  )
    return {
      type: 'audit',
      id: m.id,
      report: {
        event: 'delivery',
        offer: r.offer,
        recipient: r.recipient,
        status: r.status as DeliveryStatus,
        route: r.route as DeliveryRoute,
      },
    };
  const count = r?.count as number,
    bytes = r?.bytes as number;
  if (
    r?.event === 'messages' &&
    Number.isSafeInteger(count) &&
    Number.isSafeInteger(bytes) &&
    count >= 1 &&
    count <= 1_000_000 &&
    bytes >= count &&
    bytes <= count * 40_000
  )
    return { type: 'audit', id: m.id, report: { event: 'messages', count, bytes } };
  throw new Error('Invalid activity report');
}

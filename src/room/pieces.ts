import { sha256 } from '@noble/hashes/sha2.js';
import { equalBytes } from '@noble/curves/utils.js';
import {
  MAX_PIECE_MESSAGE,
  MAX_PROOF,
  PIECE_HEADER,
  PIECE_SIZE,
  idBytes,
  idHex,
} from '../../shared/room';

// Files are split into fixed pieces. Each piece is encrypted once with the offer's
// content key and authenticated by a Merkle proof against the signed file root, so
// identical ciphertext can go to every recipient (relay fan-out, later peer swarm).
export function pieceCount(size: number): number {
  return Math.max(1, Math.ceil(size / PIECE_SIZE));
}
export function pieceBounds(size: number, index: number): [number, number] {
  if (!Number.isSafeInteger(index) || index < 0 || index >= pieceCount(size))
    throw new Error('Invalid piece.');
  const start = index * PIECE_SIZE;
  return [start, Math.min(size, start + PIECE_SIZE)];
}

export async function leafHash(data: Uint8Array): Promise<Uint8Array> {
  const prefixed = new Uint8Array(data.length + 1);
  prefixed.set(data, 1);
  return new Uint8Array(await crypto.subtle.digest('SHA-256', prefixed));
}
const nodeHash = (left: Uint8Array, right: Uint8Array) =>
  sha256
    .create()
    .update(new Uint8Array([1]))
    .update(left)
    .update(right)
    .digest();

// An unpaired last node is promoted unchanged. The leaf count is fixed by the file
// size, so this layout is unambiguous.
export class MerkleTree {
  private levels: Uint8Array[][];
  constructor(leaves: Uint8Array[]) {
    if (!leaves.length) throw new Error('A Merkle tree needs at least one leaf.');
    this.levels = [leaves];
    while (this.levels.at(-1)!.length > 1) {
      const level = this.levels.at(-1)!;
      const next: Uint8Array[] = [];
      for (let i = 0; i < level.length; i += 2)
        next.push(i + 1 < level.length ? nodeHash(level[i], level[i + 1]) : level[i]);
      this.levels.push(next);
    }
  }
  get root(): Uint8Array {
    return this.levels.at(-1)![0];
  }
  proof(index: number): Uint8Array[] {
    const proof: Uint8Array[] = [];
    for (const level of this.levels.slice(0, -1)) {
      const sibling = index ^ 1;
      if (sibling < level.length) proof.push(level[sibling]);
      index >>= 1;
    }
    return proof;
  }
}
export function verifyProof(
  leaf: Uint8Array,
  index: number,
  count: number,
  proof: Uint8Array[],
  root: Uint8Array,
): boolean {
  if (!Number.isSafeInteger(index) || index < 0 || index >= count) return false;
  let hash = leaf,
    used = 0;
  for (let width = count; width > 1; width = Math.ceil(width / 2), index >>= 1) {
    if ((index ^ 1) >= width) continue; // promoted
    const sibling = proof[used++];
    if (!sibling) return false;
    hash = index % 2 ? nodeHash(sibling, hash) : nodeHash(hash, sibling);
  }
  return used === proof.length && equalBytes(hash, root);
}

export async function importContentKey(raw: Uint8Array): Promise<CryptoKey> {
  if (raw.length !== 32) throw new Error('Invalid content key.');
  return crypto.subtle.importKey('raw', raw as Uint8Array<ArrayBuffer>, 'AES-GCM', false, [
    'encrypt',
    'decrypt',
  ]);
}
const label = new TextEncoder().encode('widesend-share-v1/piece');
function pieceParameters(offer: string, file: number, piece: number): AesGcmParams {
  const iv = new Uint8Array(12);
  const view = new DataView(iv.buffer);
  view.setUint32(0, file);
  view.setBigUint64(4, BigInt(piece));
  const additionalData = new Uint8Array(label.length + 16);
  additionalData.set(label);
  additionalData.set(idBytes(offer), label.length);
  return { name: 'AES-GCM', iv, additionalData };
}
// A piece's plaintext never changes, so its fixed nonce always encrypts the same
// message under this offer's key: deterministic output, no nonce reuse hazard.
export async function encryptPiece(
  key: CryptoKey,
  offer: string,
  file: number,
  piece: number,
  plain: Uint8Array,
): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.encrypt(
      pieceParameters(offer, file, piece),
      key,
      plain as Uint8Array<ArrayBuffer>,
    ),
  );
}
export async function decryptPiece(
  key: CryptoKey,
  offer: string,
  file: number,
  piece: number,
  data: Uint8Array,
): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.decrypt(
      pieceParameters(offer, file, piece),
      key,
      data as Uint8Array<ArrayBuffer>,
    ),
  );
}

export type PieceMessage = {
  offer: string;
  file: number;
  piece: number;
  proof: Uint8Array[];
  data: Uint8Array;
};
export function encodePiece(m: PieceMessage): Uint8Array {
  if (m.proof.length > MAX_PROOF || m.file > 0xffff || m.piece > 0xffffffff)
    throw new Error('Invalid piece.');
  const bytes = new Uint8Array(PIECE_HEADER + m.proof.length * 32 + m.data.length);
  const view = new DataView(bytes.buffer);
  bytes[0] = 1;
  bytes.set(idBytes(m.offer), 1);
  view.setUint16(17, m.file);
  view.setUint32(19, m.piece);
  bytes[23] = m.proof.length;
  m.proof.forEach((hash, i) => {
    if (hash.length !== 32) throw new Error('Invalid piece.');
    bytes.set(hash, PIECE_HEADER + i * 32);
  });
  bytes.set(m.data, PIECE_HEADER + m.proof.length * 32);
  return bytes;
}
export function decodePiece(bytes: Uint8Array): PieceMessage {
  if (bytes.length < PIECE_HEADER || bytes[0] !== 1) throw new Error('Invalid piece.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = bytes[23];
  const start = PIECE_HEADER + count * 32;
  if (count > MAX_PROOF || bytes.length < start + 16) throw new Error('Invalid piece.');
  return {
    offer: idHex(bytes.subarray(1, 17)),
    file: view.getUint16(17),
    piece: view.getUint32(19),
    proof: Array.from({ length: count }, (_, i) =>
      bytes.slice(PIECE_HEADER + i * 32, PIECE_HEADER + (i + 1) * 32),
    ),
    data: bytes.slice(start),
  };
}

// WebRTC data channels carry piece messages as ≤32 KiB parts on one ordered
// channel: 0x20 more parts follow, 0x21 last part.
export const FRAGMENT_MORE = 0x20;
export const FRAGMENT_LAST = 0x21;
export function fragment(message: Uint8Array, size = 32 * 1024): Uint8Array<ArrayBuffer>[] {
  const parts: Uint8Array<ArrayBuffer>[] = [];
  for (let start = 0; start < message.length || !parts.length; start += size) {
    const end = Math.min(message.length, start + size);
    const part = new Uint8Array(end - start + 1);
    part[0] = end === message.length ? FRAGMENT_LAST : FRAGMENT_MORE;
    part.set(message.subarray(start, end), 1);
    parts.push(part);
  }
  return parts;
}
export class Reassembler {
  private parts: Uint8Array[] = [];
  private length = 0;
  push(frame: Uint8Array): Uint8Array | undefined {
    if (frame[0] !== FRAGMENT_MORE && frame[0] !== FRAGMENT_LAST)
      throw new Error('Invalid fragment.');
    this.length += frame.length - 1;
    if (this.length > MAX_PIECE_MESSAGE) {
      this.reset();
      throw new Error('Invalid fragment.');
    }
    this.parts.push(frame.subarray(1));
    if (frame[0] === FRAGMENT_MORE) return undefined;
    const whole = new Uint8Array(this.length);
    let offset = 0;
    for (const part of this.parts) {
      whole.set(part, offset);
      offset += part.length;
    }
    this.reset();
    return whole;
  }
  reset(): void {
    this.parts = [];
    this.length = 0;
  }
}

// Encrypted pieces kept for fan-out and repeat requests: one bounded LRU for all
// of this page's offers, so a busy session can't pile up ciphertext in memory.
export class PieceCache {
  private entries = new Map<string, Uint8Array>();
  constructor(private capacity: number) {}
  get size(): number {
    return this.entries.size;
  }
  get(offer: string, key: string): Uint8Array | undefined {
    const id = `${offer}/${key}`;
    const value = this.entries.get(id);
    if (value) {
      this.entries.delete(id);
      this.entries.set(id, value);
    }
    return value;
  }
  set(offer: string, key: string, value: Uint8Array): void {
    const id = `${offer}/${key}`;
    this.entries.delete(id);
    this.entries.set(id, value);
    while (this.entries.size > this.capacity)
      this.entries.delete(this.entries.keys().next().value!);
  }
  drop(offer: string): void {
    for (const id of [...this.entries.keys()])
      if (id.startsWith(`${offer}/`)) this.entries.delete(id);
  }
}

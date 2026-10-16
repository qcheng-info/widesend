import { describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { PIECE_SIZE, MAX_PIECE_MESSAGE } from '../../shared/room';
import {
  MerkleTree,
  PieceCache,
  Reassembler,
  decodePiece,
  decryptPiece,
  encodePiece,
  encryptPiece,
  fragment,
  importContentKey,
  leafHash,
  pieceBounds,
  pieceCount,
  verifyProof,
} from '../../src/room/pieces';
import { PreparedCache, prepareFile } from '../../src/room/prepare';

const offer = 'ab'.repeat(16);
const sha = (...parts: Uint8Array[]) => {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(part);
  return new Uint8Array(hash.digest());
};
const leaves = (count: number) =>
  Array.from({ length: count }, (_, i) => sha(new Uint8Array([0]), new Uint8Array([i])));

describe('piece math', () => {
  it('always has at least one piece and splits exactly at the boundary', () => {
    expect(pieceCount(0)).toBe(1);
    expect(pieceCount(1)).toBe(1);
    expect(pieceCount(PIECE_SIZE - 1)).toBe(1);
    expect(pieceCount(PIECE_SIZE)).toBe(1);
    expect(pieceCount(PIECE_SIZE + 1)).toBe(2);
    expect(pieceCount(3 * PIECE_SIZE)).toBe(3);
    expect(pieceBounds(0, 0)).toEqual([0, 0]);
    expect(pieceBounds(PIECE_SIZE + 1, 1)).toEqual([PIECE_SIZE, PIECE_SIZE + 1]);
    expect(pieceBounds(3 * PIECE_SIZE, 2)).toEqual([2 * PIECE_SIZE, 3 * PIECE_SIZE]);
    expect(() => pieceBounds(10, 1)).toThrow();
    expect(() => pieceBounds(10, -1)).toThrow();
  });
  it('hashes leaves with a 0x00 domain prefix', async () => {
    const data = new Uint8Array([1, 2, 3]);
    expect(await leafHash(data)).toEqual(sha(new Uint8Array([0]), data));
    expect(await leafHash(new Uint8Array())).toEqual(sha(new Uint8Array([0])));
  });
});

describe('Merkle trees', () => {
  it('proves every leaf for uneven and power-of-two sizes', () => {
    for (const count of [1, 2, 3, 5, 16, 17]) {
      const items = leaves(count);
      const tree = new MerkleTree(items);
      for (let i = 0; i < count; i++)
        expect(verifyProof(items[i], i, count, tree.proof(i), tree.root), `${count}/${i}`).toBe(
          true,
        );
    }
  });
  it('uses the leaf itself as the root of a one-piece file', () => {
    const [leaf] = leaves(1);
    expect(new MerkleTree([leaf]).root).toEqual(leaf);
    expect(new MerkleTree([leaf]).proof(0)).toEqual([]);
  });
  it('matches a hand-built three-leaf tree with promotion', () => {
    const [a, b, c] = leaves(3);
    const ab = sha(new Uint8Array([1]), a, b);
    expect(new MerkleTree([a, b, c]).root).toEqual(sha(new Uint8Array([1]), ab, c));
  });
  it('rejects tampered proofs', () => {
    const items = leaves(5);
    const tree = new MerkleTree(items);
    const proof = tree.proof(2);
    expect(verifyProof(items[3], 2, 5, proof, tree.root)).toBe(false);
    expect(verifyProof(items[2], 3, 5, proof, tree.root)).toBe(false);
    expect(verifyProof(items[2], 2, 5, proof.slice(1), tree.root)).toBe(false);
    expect(verifyProof(items[2], 2, 5, [...proof, items[0]], tree.root)).toBe(false);
    expect(verifyProof(items[2], 2, 5, proof, items[0])).toBe(false);
    expect(verifyProof(items[2], 5, 5, proof, tree.root)).toBe(false);
    expect(verifyProof(items[4], 4, 5, tree.proof(4), tree.root)).toBe(true);
    expect(verifyProof(items[4], 4, 6, tree.proof(4), tree.root)).toBe(false);
  });
});

describe('piece encryption', () => {
  it('round-trips and binds offer, file and piece', async () => {
    const key = await importContentKey(randomBytes(32));
    const plain = new Uint8Array(randomBytes(1000));
    const sealed = await encryptPiece(key, offer, 2, 7, plain);
    expect(sealed.length).toBe(plain.length + 16);
    expect(await decryptPiece(key, offer, 2, 7, sealed)).toEqual(plain);
    // Deterministic: every recipient gets the same ciphertext for a piece.
    expect(await encryptPiece(key, offer, 2, 7, plain)).toEqual(sealed);
    await expect(decryptPiece(key, 'cd'.repeat(16), 2, 7, sealed)).rejects.toThrow();
    await expect(decryptPiece(key, offer, 3, 7, sealed)).rejects.toThrow();
    await expect(decryptPiece(key, offer, 2, 8, sealed)).rejects.toThrow();
    const flipped = sealed.slice();
    flipped[10] ^= 1;
    await expect(decryptPiece(key, offer, 2, 7, flipped)).rejects.toThrow();
    const other = await importContentKey(randomBytes(32));
    await expect(decryptPiece(other, offer, 2, 7, sealed)).rejects.toThrow();
  });
  it('encrypts an empty piece', async () => {
    const key = await importContentKey(randomBytes(32));
    const sealed = await encryptPiece(key, offer, 0, 0, new Uint8Array());
    expect(await decryptPiece(key, offer, 0, 0, sealed)).toEqual(new Uint8Array());
  });
  it('rejects short keys', async () => {
    await expect(importContentKey(randomBytes(16))).rejects.toThrow();
  });
});

describe('piece messages and fragments', () => {
  const message = {
    offer,
    file: 3,
    piece: 70_000,
    proof: leaves(3),
    data: new Uint8Array(randomBytes(100)),
  };
  it('round-trips a piece message', () => {
    const decoded = decodePiece(encodePiece(message));
    expect(decoded).toEqual(message);
  });
  it('rejects bad versions and truncated proofs', () => {
    const encoded = encodePiece(message);
    const wrong = encoded.slice();
    wrong[0] = 2;
    expect(() => decodePiece(wrong)).toThrow();
    expect(() => decodePiece(encoded.slice(0, 24 + 40))).toThrow();
    expect(() => encodePiece({ ...message, proof: leaves(41) })).toThrow();
  });
  it('fragments and reassembles messages of any size exactly', () => {
    for (const size of [24, 32 * 1024, 32 * 1024 + 1, 200_000]) {
      const whole = new Uint8Array(randomBytes(size));
      const parts = fragment(whole);
      expect(parts.every((p) => p.length <= 32 * 1024 + 1)).toBe(true);
      expect(parts.slice(0, -1).every((p) => p[0] === 0x20)).toBe(true);
      expect(parts.at(-1)![0]).toBe(0x21);
      const reassembler = new Reassembler();
      const results = parts.map((p) => reassembler.push(p));
      expect(results.slice(0, -1).every((r) => r === undefined)).toBe(true);
      expect(results.at(-1)).toEqual(whole);
    }
  });
  it('rejects unknown fragment types and runaway messages', () => {
    const reassembler = new Reassembler();
    expect(() => reassembler.push(new Uint8Array([0x30, 1]))).toThrow();
    const big = new Reassembler();
    const part = new Uint8Array(32 * 1024 + 1);
    part[0] = 0x20;
    expect(() => {
      for (let i = 0; i * 32 * 1024 <= MAX_PIECE_MESSAGE + 32 * 1024; i++) big.push(part);
    }).toThrow();
  });
});

describe('file preparation', () => {
  const named = (bytes: Uint8Array, name = 'data.bin') =>
    new File([bytes], name, { type: 'application/octet-stream' });
  it('computes SHA-256, MD5 and one leaf per piece in a single pass', async () => {
    const bytes = new Uint8Array(randomBytes(Math.floor(2.6 * PIECE_SIZE)));
    let seen = 0;
    const prepared = await prepareFile(named(bytes), (n) => (seen += n));
    expect(seen).toBe(bytes.length);
    expect(prepared.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(prepared.md5).toBe(createHash('md5').update(bytes).digest('hex'));
    expect(prepared.leaves).toHaveLength(3);
    expect(prepared.leaves[2]).toEqual(sha(new Uint8Array([0]), bytes.subarray(2 * PIECE_SIZE)));
    expect(prepared.tree.root).toEqual(new MerkleTree(prepared.leaves).root);
    expect(prepared).toMatchObject({
      name: 'data.bin',
      size: bytes.length,
      type: 'application/octet-stream',
    });
  });
  it('gives an empty file one empty leaf', async () => {
    const prepared = await prepareFile(named(new Uint8Array(), 'empty'));
    expect(prepared.leaves).toEqual([sha(new Uint8Array([0]))]);
    expect(prepared.sha256).toBe(createHash('sha256').digest('hex'));
  });
  it('stops when aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      prepareFile(named(new Uint8Array(PIECE_SIZE * 2)), undefined, controller.signal),
    ).rejects.toThrow();
  });
  it('caches preparation per file object', async () => {
    const cache = new PreparedCache();
    const file = named(new Uint8Array([1, 2, 3]));
    const first = cache.get(file);
    expect(cache.get(file)).toBe(first);
    expect(cache.get(named(new Uint8Array([1, 2, 3])))).not.toBe(first);
    await first;
  });
});

describe('encrypted piece cache', () => {
  it('holds at most its capacity across all offers, dropping the least recently used', () => {
    const cache = new PieceCache(3);
    const data = (n: number) => new Uint8Array([n]);
    cache.set('a', '0:0', data(1));
    cache.set('a', '0:1', data(2));
    cache.set('b', '0:0', data(3));
    expect(cache.get('a', '0:0')).toEqual(data(1)); // now most recent
    cache.set('b', '0:1', data(4));
    expect(cache.get('a', '0:1')).toBeUndefined(); // evicted
    expect(cache.get('a', '0:0')).toEqual(data(1));
    expect(cache.size).toBe(3);
  });
  it('forgets every piece of a finished offer', () => {
    const cache = new PieceCache(10);
    cache.set('a', '0:0', new Uint8Array([1]));
    cache.set('a', '1:0', new Uint8Array([2]));
    cache.set('b', '0:0', new Uint8Array([3]));
    cache.drop('a');
    expect(cache.size).toBe(1);
    expect(cache.get('b', '0:0')).toEqual(new Uint8Array([3]));
  });
});

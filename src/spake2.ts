// RFC 9382 sections 3–4, P256-SHA256-HKDF-HMAC suite. Curve arithmetic
// is supplied by @noble/curves; this module implements the RFC transcript.
import { p256 } from '@noble/curves/nist.js';
import { bytesToHex, hexToBytes, concatBytes } from '@noble/hashes/utils.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { scryptAsync } from '@noble/hashes/scrypt.js';
import type { Role } from '../shared/protocol';
import { PAKE_SUITE } from '../shared/key-exchange';

const utf8 = new TextEncoder();
const Point = p256.Point;
const M = Point.fromHex('02886e2f97ace46e55ba9dd7242579f2993b64e16ef3dcab95afd497333d8fa12f');
const N = Point.fromHex('03d8bbd6c639c62937b04d997f38c3770719c629d7014d49a24b4f98baa1292b49');
const order = Point.Fn.ORDER;
const integer = (bytes: Uint8Array) => BigInt(`0x${bytesToHex(bytes)}`);
const scalarBytes = (scalar: bigint) => hexToBytes(scalar.toString(16).padStart(64, '0'));

// RFC length fields are eight-byte little endian; scalars are big endian.
export function transcript(...fields: Uint8Array[]): Uint8Array<ArrayBuffer> {
  return concatBytes(
    ...fields.flatMap((field) => {
      const length = new Uint8Array(8);
      new DataView(length.buffer).setBigUint64(0, BigInt(field.length), true);
      return [length, field];
    }),
  );
}

export async function passwordScalar(code: string): Promise<bigint> {
  // The application-defined MHF: scrypt N=32768,r=8,p=1,dkLen=48.
  // 384 output bits reduce modulo bias below 2^-128. Salt is a fixed domain
  // separator, not a password verifier. Codes/room locators aren't secret
  // from the operator; see SECURITY.md for that explicit trust boundary.
  const bytes = await scryptAsync(utf8.encode(code), utf8.encode(`${PAKE_SUITE}/password`), {
    N: 32768,
    r: 8,
    p: 1,
    dkLen: 48,
    maxmem: 40 * 1024 * 1024,
    asyncTick: 8,
  });
  const w = integer(bytes) % order;
  bytes.fill(0);
  if (!w) throw new Error('Invalid SPAKE2 password scalar.');
  return w;
}

export type SpakeResult = {
  key: Uint8Array<ArrayBuffer>;
  transcriptHash: Uint8Array<ArrayBuffer>;
  confirmation: Uint8Array<ArrayBuffer>;
  expected: Uint8Array<ArrayBuffer>;
};

export class Spake2 {
  readonly share: Uint8Array<ArrayBuffer>;
  private used = false;
  // Explicit scalars make the independent RFC vectors executable. Production
  // callers always use start(), which samples a fresh uniform scalar.
  constructor(
    private role: Role,
    private w: bigint,
    private ephemeral: bigint,
  ) {
    if (w <= 0n || w >= order || ephemeral <= 0n || ephemeral >= order)
      throw new Error('Invalid SPAKE2 scalar.');
    this.share = Point.BASE.multiply(ephemeral)
      .add((role === 'send' ? M : N).multiply(w))
      .toBytes(false);
  }
  static async start(code: string, role: Role): Promise<Spake2> {
    const w = await passwordScalar(code);
    let ephemeral: bigint;
    do {
      ephemeral = integer(crypto.getRandomValues(new Uint8Array(32)));
    } while (ephemeral === 0n || ephemeral >= order);
    return new Spake2(role, w, ephemeral);
  }
  finish(
    peerShare: Uint8Array,
    sender: Uint8Array,
    receiver: Uint8Array,
    aad = new Uint8Array(),
  ): SpakeResult {
    if (this.used) throw new Error('SPAKE2 exchange already used.');
    this.used = true;
    try {
      if (peerShare.length !== 65 || peerShare[0] !== 4) throw new Error('Invalid SPAKE2 point.');
      const peer = Point.fromBytes(peerShare);
      peer.assertValidity(); // P-256 has cofactor 1; valid nonzero points are in the prime-order group.
      const unmasked = peer.subtract((this.role === 'send' ? N : M).multiply(this.w));
      unmasked.assertValidity(); // Also rejects the identity after unmasking.
      const shared = unmasked.multiply(this.ephemeral).toBytes(false);
      const [a, b] = this.role === 'send' ? [this.share, peerShare] : [peerShare, this.share];
      const tt = transcript(sender, receiver, a, b, shared, scalarBytes(this.w));
      const hash = sha256(tt);
      const keys = hkdf(
        sha256,
        hash.subarray(16),
        undefined,
        concatBytes(utf8.encode('ConfirmationKeys'), aad),
        32,
      );
      const ca = hmac(sha256, keys.subarray(0, 16), tt);
      const cb = hmac(sha256, keys.subarray(16), tt);
      const result = {
        key: hash.slice(0, 16),
        transcriptHash: hash.slice(),
        confirmation: this.role === 'send' ? ca : cb,
        expected: this.role === 'send' ? cb : ca,
      };
      tt.fill(0);
      shared.fill(0);
      keys.fill(0);
      hash.fill(0);
      return result;
    } finally {
      this.destroy();
    }
  }
  destroy(): void {
    this.used = true;
    this.w = 0n;
    this.ephemeral = 0n;
  }
}

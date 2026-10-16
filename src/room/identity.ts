import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { transcript } from '../spake2';
import { Cipher } from '../crypto';
import type { DeviceIdentity } from '../key-session';
import { validateManifest, type FileMeta, type Role } from '../../shared/protocol';
import { PIECE_SIZE, validKey, validMemberId, validSignature } from '../../shared/room';

// Room trust: the owner's device key signs each member's certificate; members sign
// offers and link hellos with their own certified device keys.
const utf8 = new TextEncoder();
const signing = { name: 'ECDSA', hash: 'SHA-256' };
const fields = (...values: (string | Uint8Array)[]) =>
  transcript(...values.map((v) => (typeof v === 'string' ? utf8.encode(v) : v)));
const verifier = (hex: string) =>
  crypto.subtle.importKey('raw', hexToBytes(hex), { name: 'ECDSA', namedCurve: 'P-256' }, false, [
    'verify',
  ]);
async function sign(privateKey: CryptoKey, data: Uint8Array<ArrayBuffer>): Promise<string> {
  return bytesToHex(new Uint8Array(await crypto.subtle.sign(signing, privateKey, data)));
}
async function verify(key: string, signature: string, data: Uint8Array<ArrayBuffer>) {
  if (!validKey(key) || !validSignature(signature)) return false;
  try {
    return await crypto.subtle.verify(signing, await verifier(key), hexToBytes(signature), data);
  } catch {
    return false;
  }
}

export type CertFields = {
  locator: string;
  member: string;
  role: 'owner' | 'member';
  name: string;
  key: string;
  expires: number;
};
const certificate = (f: CertFields) =>
  fields('widesend-share-v1/member', f.locator, f.member, f.role, f.name, f.key, String(f.expires));
export function signCertificate(privateKey: CryptoKey, f: CertFields): Promise<string> {
  return sign(privateKey, certificate(f));
}
export async function verifyCertificate(
  ownerKey: string,
  f: CertFields,
  cert: string,
): Promise<boolean> {
  return validKey(f.key) && verify(ownerKey, cert, certificate(f));
}

export type OfferBody = {
  id: string;
  sender: string;
  files: FileMeta[];
  pieceSize: number;
  roots: string[];
  sha256: string[];
  md5: string[];
  created: number;
};
export type SignedOffer = OfferBody & { sig: string };
const offerBytes = (locator: string, o: OfferBody) =>
  fields(
    'widesend-share-v1/offer',
    locator,
    JSON.stringify([
      o.id,
      o.sender,
      o.files.map((f) => [f.id, f.name, f.size, f.type]),
      o.pieceSize,
      o.roots,
      o.sha256,
      o.md5,
      o.created,
    ]),
  );
export async function signOffer(
  privateKey: CryptoKey,
  locator: string,
  body: OfferBody,
): Promise<SignedOffer> {
  return { ...body, sig: await sign(privateKey, offerBytes(locator, body)) };
}
export function verifyOffer(senderKey: string, locator: string, offer: SignedOffer) {
  return verify(senderKey, offer.sig, offerBytes(locator, offer));
}
const hex = (length: number) => (v: unknown) =>
  typeof v === 'string' && v.length === length && /^[0-9a-f]+$/.test(v);
export function validateOffer(value: unknown): SignedOffer {
  const o = value as SignedOffer;
  if (!o || typeof o !== 'object') throw new Error('Invalid offer.');
  const files = validateManifest(o.files);
  // Sanitised names must equal the signed ones; the sender normalises first.
  if (files.some((f, i) => f.name !== o.files[i].name)) throw new Error('Invalid offer.');
  const list = (v: unknown, check: (x: unknown) => boolean) =>
    Array.isArray(v) && v.length === files.length && v.every(check);
  if (
    !validMemberId(o.id) ||
    !validMemberId(o.sender) ||
    o.pieceSize !== PIECE_SIZE ||
    !list(o.roots, hex(64)) ||
    !list(o.sha256, hex(64)) ||
    !list(o.md5, hex(32)) ||
    !Number.isSafeInteger(o.created) ||
    !validSignature(o.sig)
  )
    throw new Error('Invalid offer.');
  return {
    id: o.id,
    sender: o.sender,
    files,
    pieceSize: o.pieceSize,
    roots: [...o.roots],
    sha256: [...o.sha256],
    md5: [...o.md5],
    created: o.created,
    sig: o.sig,
  };
}

export type LinkHello = { v: 1; round: string; eph: string; sig: string };
export function validLinkHello(value: unknown): value is LinkHello {
  const h = value as LinkHello;
  return (
    !!h &&
    h.v === 1 &&
    typeof h.round === 'string' &&
    /^[0-9a-f-]{36}$/.test(h.round) &&
    validKey(h.eph) &&
    validSignature(h.sig)
  );
}
export function linkRole(me: string, peer: string): Role {
  return me < peer ? 'send' : 'receive';
}
const helloBytes = (locator: string, from: string, to: string, round: string, eph: string) =>
  fields('widesend-share-v1/link', locator, from, to, round, eph);

// Signed ephemeral ECDH between two certified members. Every round yields fresh
// traffic keys for the existing Cipher (counters, replay windows).
export class LinkHandshake {
  private used = false;
  private constructor(
    private me: { id: string },
    private peer: { id: string; key: string },
    private locator: string,
    readonly round: string,
    private ecdh: CryptoKeyPair,
    readonly hello: LinkHello,
  ) {}
  static async start(
    me: { id: string; identity: DeviceIdentity },
    peer: { id: string; key: string },
    locator: string,
    round: string = crypto.randomUUID(),
  ): Promise<LinkHandshake> {
    const ecdh = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, [
      'deriveBits',
    ])) as CryptoKeyPair;
    const eph = bytesToHex(new Uint8Array(await crypto.subtle.exportKey('raw', ecdh.publicKey)));
    const sig = await sign(me.identity.privateKey, helloBytes(locator, me.id, peer.id, round, eph));
    return new LinkHandshake(me, peer, locator, round, ecdh, { v: 1, round, eph, sig });
  }
  async finish(peerHello: LinkHello): Promise<Cipher> {
    if (this.used) throw new Error('Link handshake already used.');
    this.used = true;
    if (
      !validLinkHello(peerHello) ||
      peerHello.round !== this.round ||
      peerHello.eph === this.hello.eph ||
      !(await verify(
        this.peer.key,
        peerHello.sig,
        helloBytes(this.locator, this.peer.id, this.me.id, this.round, peerHello.eph),
      ))
    )
      throw new Error('Could not verify the other member.');
    const peerPublic = await crypto.subtle.importKey(
      'raw',
      hexToBytes(peerHello.eph),
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      [],
    );
    const shared = new Uint8Array(
      await crypto.subtle.deriveBits(
        { name: 'ECDH', public: peerPublic },
        this.ecdh.privateKey,
        256,
      ),
    );
    const mine = this.me.id < this.peer.id;
    const [low, high] = mine ? [this.me.id, this.peer.id] : [this.peer.id, this.me.id];
    const [ephLow, ephHigh] = mine
      ? [this.hello.eph, peerHello.eph]
      : [peerHello.eph, this.hello.eph];
    const context = fields(
      'widesend-share-v1/link',
      this.locator,
      low,
      high,
      this.round,
      hexToBytes(ephLow),
      hexToBytes(ephHigh),
    );
    const material = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveBits']);
    shared.fill(0);
    const secret = new Uint8Array(
      await crypto.subtle.deriveBits(
        {
          name: 'HKDF',
          hash: 'SHA-256',
          salt: sha256(context),
          info: utf8.encode('widesend-share-v1/link-key'),
        },
        material,
        128,
      ),
    );
    try {
      return await Cipher.create(secret, linkRole(this.me.id, this.peer.id), context);
    } finally {
      secret.fill(0);
    }
  }
}

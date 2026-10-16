import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { equalBytes } from '@noble/curves/utils.js';
import { KEY_EXCHANGE, PAKE_SUITE, validKeyMessage, type KeyMessage } from '../shared/key-exchange';
import type { Role } from '../shared/protocol';
import { Spake2, transcript, type SpakeResult } from './spake2';
import { Cipher } from './crypto';

export type DeviceIdentity = {
  privateKey: CryptoKey;
  publicKey: string;
  peerKey?: string;
};
const utf8 = new TextEncoder();
const algorithm = { name: 'ECDSA', namedCurve: 'P-256' };
const signing = { name: 'ECDSA', hash: 'SHA-256' };
export const PAIRING_ERROR = 'Could not verify the other device. Start again with a new code.';
export const UPDATE_REQUIRED = 'Refresh WideSend on both devices to continue.';

export async function createIdentity(): Promise<DeviceIdentity> {
  // Private keys are non-exportable, structured-cloned into IndexedDB before
  // pairing. They authenticate resume, never derive file encryption keys.
  const keys = await crypto.subtle.generateKey(algorithm, false, ['sign', 'verify']);
  return {
    privateKey: keys.privateKey,
    publicKey: bytesToHex(new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey))),
  };
}

export class KeySession {
  readonly share: KeyMessage;
  private result?: SpakeResult;
  private peerKey?: string;
  private peerPublic?: CryptoKey;
  private finished = false;
  private constructor(
    private role: Role,
    private identity: DeviceIdentity,
    private spake: Spake2,
    private context: Uint8Array<ArrayBuffer>,
    readonly round: string,
  ) {
    this.share = {
      type: 'key-exchange',
      step: 'share',
      round,
      suite: PAKE_SUITE,
      point: bytesToHex(spake.share),
      identity: identity.publicKey,
    };
  }
  static async start(
    code: string,
    role: Role,
    identity: DeviceIdentity,
    origin: string,
    room: string,
    expires: number,
    round: string,
  ): Promise<KeySession> {
    const context = transcript(
      ...[PAKE_SUITE, String(KEY_EXCHANGE), origin, room, String(expires), round].map((s) =>
        utf8.encode(s),
      ),
    );
    return new KeySession(role, identity, await Spake2.start(code, role), context, round);
  }
  private proof(role: Role, mac: Uint8Array): Uint8Array<ArrayBuffer> {
    return transcript(
      utf8.encode(`${PAKE_SUITE}/device-proof/${role}`),
      this.context,
      this.result!.transcriptHash,
      mac,
    );
  }
  async receiveShare(message: KeyMessage): Promise<KeyMessage> {
    if (
      !validKeyMessage(message) ||
      message.step !== 'share' ||
      message.round !== this.round ||
      this.result ||
      this.finished ||
      (this.identity.peerKey && this.identity.peerKey !== message.identity) ||
      message.identity === this.identity.publicKey
    )
      throw new Error(PAIRING_ERROR);
    this.peerKey = message.identity;
    this.peerPublic = await crypto.subtle.importKey(
      'raw',
      hexToBytes(message.identity),
      algorithm,
      false,
      ['verify'],
    );
    const local = transcript(utf8.encode(this.role), hexToBytes(this.identity.publicKey));
    const remote = transcript(
      utf8.encode(this.role === 'send' ? 'receive' : 'send'),
      hexToBytes(message.identity),
    );
    const [sender, receiver] = this.role === 'send' ? [local, remote] : [remote, local];
    this.result = this.spake.finish(hexToBytes(message.point), sender, receiver, this.context);
    const signature = await crypto.subtle.sign(
      signing,
      this.identity.privateKey,
      this.proof(this.role, this.result.confirmation),
    );
    return {
      type: 'key-exchange',
      step: 'confirm',
      round: this.round,
      mac: bytesToHex(this.result.confirmation),
      signature: bytesToHex(new Uint8Array(signature)),
    };
  }
  async confirm(message: KeyMessage): Promise<{ cipher: Cipher; peerKey: string }> {
    if (
      !validKeyMessage(message) ||
      message.step !== 'confirm' ||
      message.round !== this.round ||
      !this.result ||
      !this.peerPublic ||
      !this.peerKey ||
      this.finished
    )
      throw new Error(PAIRING_ERROR);
    this.finished = true;
    try {
      const mac = hexToBytes(message.mac);
      if (
        !equalBytes(mac, this.result.expected) ||
        !(await crypto.subtle.verify(
          signing,
          this.peerPublic,
          hexToBytes(message.signature),
          this.proof(this.role === 'send' ? 'receive' : 'send', mac),
        ))
      )
        throw new Error(PAIRING_ERROR);
      return {
        cipher: await Cipher.create(this.result.key, this.role, this.context),
        peerKey: this.peerKey,
      };
    } finally {
      this.destroy();
    }
  }
  destroy(): void {
    this.finished = true;
    this.spake.destroy();
    this.result?.key.fill(0);
    this.result?.transcriptHash.fill(0);
    this.result?.confirmation.fill(0);
    this.result?.expected.fill(0);
    this.result = undefined;
  }
}

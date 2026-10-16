import type { Control, Role } from '../shared/protocol';
import { roomId, validPairingCode } from '../shared/pairing';
export { roomId } from '../shared/pairing';
const encoder = new TextEncoder();
const decoder = new TextDecoder();
export function token(bytes = 16): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(bytes))))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}
const CODE_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
export function pairingCode(): string {
  // Reject out-of-range bytes to avoid modulo bias. Require both letters and digits.
  for (;;) {
    let code = '';
    while (code.length < 6) {
      const bytes = crypto.getRandomValues(new Uint8Array(12));
      for (const byte of bytes) {
        if (byte < 252) code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
        if (code.length === 6) break;
      }
    }
    if (/[A-Z]/.test(code) && /[0-9]/.test(code)) return code;
  }
}
export function normalizeCodeInput(input: string): string {
  const fragment = input.includes('#') ? input.slice(input.indexOf('#') + 1) : input;
  return fragment
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 6);
}
export function parseCode(input: string): string {
  let code = input.trim();
  if (code.includes('#')) code = code.slice(code.indexOf('#') + 1);
  code = code.toUpperCase();
  if (!validPairingCode(code))
    throw new Error('Enter the complete 6-character code (A–Z and 0–9).');
  return code;
}
export class Cipher {
  private counters = [0n, 0n];
  private replay = [
    { high: -1n, bits: 0n },
    { high: -1n, bits: 0n },
  ];
  private constructor(
    private outgoing: CryptoKey,
    private incoming: CryptoKey,
    private aad: Uint8Array<ArrayBuffer>,
  ) {}
  static async create(
    secret: Uint8Array<ArrayBuffer>,
    role: Role,
    context: Uint8Array<ArrayBuffer>,
  ): Promise<Cipher> {
    // Only a mutually confirmed SPAKE2 session supplies this 128-bit Ke.
    if (secret.byteLength !== 16 || context.byteLength === 0)
      throw new Error('Invalid session key.');
    const aad = new Uint8Array(await crypto.subtle.digest('SHA-256', context));
    const material = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey']);
    const derive = (direction: Role) =>
      crypto.subtle.deriveKey(
        {
          name: 'HKDF',
          hash: 'SHA-256',
          salt: aad,
          info: encoder.encode(`widesend-v2/traffic/${direction}`),
        },
        material,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt'],
      );
    const [send, receive] = await Promise.all([derive('send'), derive('receive')]);
    return new Cipher(role === 'send' ? send : receive, role === 'send' ? receive : send, aad);
  }
  async seal(plaintext: Uint8Array<ArrayBuffer>): Promise<ArrayBuffer> {
    // Independent bounded replay windows for control and file traffic allow
    // reordered WebSocket/WebRTC delivery. Retransmission gets a new nonce.
    const lane = plaintext[0] === 0 ? 0 : 1;
    const counter = this.counters[lane]++;
    if (counter >= 2n ** 64n) throw new Error('Session key exhausted.');
    const iv = new Uint8Array(12);
    const view = new DataView(iv.buffer);
    view.setUint32(0, lane);
    view.setBigUint64(4, counter);
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: this.aad },
      this.outgoing,
      plaintext,
    );
    const frame = new Uint8Array(12 + ciphertext.byteLength);
    frame.set(iv);
    frame.set(new Uint8Array(ciphertext), 12);
    return frame.buffer;
  }
  async open(frame: ArrayBuffer): Promise<Uint8Array<ArrayBuffer>> {
    if (frame.byteLength < 29) throw new Error('Invalid encrypted frame.');
    const view = new DataView(frame);
    const lane = view.getUint32(0),
      counter = view.getBigUint64(4);
    if (lane > 1) throw new Error('Invalid encrypted frame.');
    const replay = this.replay[lane];
    const seen = () =>
      counter <= replay.high &&
      (replay.high - counter >= 8192n || (replay.bits & (1n << (replay.high - counter))) !== 0n);
    if (seen()) throw new Error('Replayed encrypted frame.');
    const plain = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: frame.slice(0, 12), additionalData: this.aad },
        this.incoming,
        frame.slice(12),
      ),
    );
    // Authentication must succeed before a packet can advance the window.
    // Check again in case another open() completed while decrypt awaited.
    if (seen()) throw new Error('Replayed encrypted frame.');
    if ((plain[0] === 0 ? 0 : 1) !== lane) throw new Error('Invalid encrypted frame.');
    if (counter > replay.high) {
      const shift = counter - replay.high;
      replay.bits = shift >= 8192n ? 1n : ((replay.bits << shift) | 1n) & ((1n << 8192n) - 1n);
      replay.high = counter;
    } else replay.bits |= 1n << (replay.high - counter);
    return plain;
  }
  async control(control: Control): Promise<ArrayBuffer> {
    const json = encoder.encode(JSON.stringify(control));
    const bytes = new Uint8Array(json.length + 1);
    bytes.set(json, 1);
    return this.seal(bytes);
  }
  async chunk(
    file: number,
    offset: number,
    data: ArrayBuffer,
    batch = false,
  ): Promise<ArrayBuffer> {
    const plain = new Uint8Array(data.byteLength + 13);
    const view = new DataView(plain.buffer);
    view.setUint8(0, batch ? 2 : 1);
    view.setUint32(1, file);
    view.setFloat64(5, offset);
    plain.set(new Uint8Array(data), 13);
    return this.seal(plain);
  }
}
export function decodeControl(plain: Uint8Array): Control {
  if (plain[0] !== 0 || plain.length > 256 * 1024) throw new Error('Invalid control frame.');
  const value = JSON.parse(decoder.decode(plain.subarray(1)));
  if (!value || typeof value.type !== 'string') throw new Error('Invalid control message.');
  return value as Control;
}

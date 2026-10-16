const context = new TextEncoder().encode('unit-test-session');
import { describe, expect, it } from 'vitest';
import {
  Cipher,
  decodeControl,
  parseCode,
  pairingCode,
  normalizeCodeInput,
  roomId,
  token,
} from '../../src/crypto';
import { CHUNK_SIZE, MAX_FRAME, validOffset, validateManifest } from '../../shared/protocol';

describe('encrypted transfer protocol', () => {
  it('encrypts metadata so only the invited receiver can read it', async () => {
    const secret = crypto.getRandomValues(new Uint8Array(16));
    const sender = await Cipher.create(secret, 'send', context);
    const receiver = await Cipher.create(secret, 'receive', context);
    const frame = await sender.control({
      type: 'manifest',
      files: [{ id: 0, name: 'private.txt', size: 4, type: 'text/plain' }],
    });
    expect(new TextDecoder().decode(frame)).not.toContain('private.txt');
    expect(decodeControl(await receiver.open(frame)).type).toBe('manifest');
    await expect(
      (await Cipher.create(crypto.getRandomValues(new Uint8Array(16)), 'receive', context)).open(
        frame,
      ),
    ).rejects.toThrow();
    await expect(sender.open(frame)).rejects.toThrow();
  });
  it('rejects modified data and authenticates file offsets above 4 GiB', async () => {
    const secret = crypto.getRandomValues(new Uint8Array(16));
    const sender = await Cipher.create(secret, 'send', context);
    const receiver = await Cipher.create(secret, 'receive', context);
    const data = crypto.getRandomValues(new Uint8Array(CHUNK_SIZE));
    const offset = 5 * 1024 ** 3;
    const frame = await sender.chunk(2, offset, data.buffer);
    expect(frame.byteLength).toBeLessThan(MAX_FRAME);
    const plain = await receiver.open(frame);
    expect(new DataView(plain.buffer).getFloat64(5)).toBe(offset);
    expect(plain.slice(13)).toEqual(data);
    const modified = new Uint8Array(frame.slice(0));
    modified[modified.length - 1] ^= 1;
    await expect(receiver.open(modified.buffer)).rejects.toThrow();
  });
  it('uses fresh nonces on retransmission and distinct directional keys', async () => {
    const secret = crypto.getRandomValues(new Uint8Array(16));
    const sender = await Cipher.create(secret, 'send', context);
    const receiver = await Cipher.create(secret, 'receive', context);
    const ack = { type: 'ack' as const, file: 0, offset: CHUNK_SIZE };
    const a = await receiver.control(ack),
      b = await receiver.control(ack);
    expect(new Uint8Array(a)).not.toEqual(new Uint8Array(b));
    expect(decodeControl(await sender.open(a))).toEqual(ack);
  });
  it('generates six-character codes containing uppercase letters and digits', () => {
    for (let i = 0; i < 100; i++) {
      const code = pairingCode();
      expect(code).toMatch(/^[A-Z0-9]{6}$/);
      expect(code).toMatch(/[A-Z]/);
      expect(code).toMatch(/[0-9]/);
    }
    // Connection credentials keep their independent 256-bit format.
    expect(token(32)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
  it('normalizes typing and pasted links to uppercase codes only', () => {
    expect(normalizeCodeInput('ab12cd')).toBe('AB12CD');
    expect(normalizeCodeInput('ab-12 cd!')).toBe('AB12CD');
    expect(normalizeCodeInput('ab12cd999')).toBe('AB12CD');
    expect(normalizeCodeInput('https://widesend.example/#ab12cd')).toBe('AB12CD');
  });
  it('accepts invitation links without passing the secret into the room URL', async () => {
    const secret = pairingCode();
    expect(secret).toMatch(/^[A-Z0-9]{6}$/);
    expect(parseCode(`https://widesend.example/#${secret}`)).toBe(secret);
    expect(await roomId(secret)).toMatch(/^[a-f0-9]{64}$/);
    expect(await roomId(secret)).not.toContain(secret);
    expect(() => parseCode('AB123')).toThrow();
    expect(() => parseCode('AB12345')).toThrow();
    expect(() => parseCode('AB!123')).toThrow();
    expect(parseCode('ab12cd')).toBe('AB12CD');
  });
});
describe('file validation', () => {
  it('sanitizes paths and validates large integer sizes', () => {
    expect(
      validateManifest([{ id: 0, name: '../file.txt', size: 12 * 1024 ** 3, type: '' }])[0].name,
    ).toBe('.._file.txt');
    expect(validOffset(5 * 1024 ** 3, 12 * 1024 ** 3)).toBe(true);
    expect(validOffset(1, 100)).toBe(false);
    expect(validOffset(100, 100)).toBe(true);
    expect(validOffset(-1, 100)).toBe(false);
    expect(validOffset(Number.MAX_SAFE_INTEGER + 1, Infinity)).toBe(false);
  });
  it('rejects malicious or inconsistent manifests', () => {
    for (const bad of [
      [],
      [{ id: 1, name: 'a', size: 1, type: '' }],
      [{ id: 0, name: 'a', size: -1, type: '' }],
      [{ id: 0, name: 'a', size: Number.MAX_SAFE_INTEGER + 1, type: '' }],
    ])
      expect(() => validateManifest(bad)).toThrow();
  });
});

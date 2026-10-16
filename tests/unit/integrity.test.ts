import { describe, expect, it } from 'vitest';
import { newFileHash, finishHash, verifySavedFile, fingerprintFile } from '../../src/integrity';
import { createHash } from 'node:crypto';

describe('saved-file integrity', () => {
  it('fingerprints original files across read boundaries before they can be resumed', async () => {
    const bytes = Buffer.alloc(2 * 1024 * 1024 + 13, 0x6a);
    bytes[1024 * 1024] = 0x2b;
    await expect(fingerprintFile(new Blob([bytes]))).resolves.toEqual({
      sha256: createHash('sha256').update(bytes).digest('hex'),
      md5: createHash('md5').update(bytes).digest('hex'),
    });
  });
  it('cancels checking originals without returning a partial fingerprint', async () => {
    const controller = new AbortController();
    const result = fingerprintFile(new Blob([new Uint8Array(3 * 1024 * 1024)]), controller.signal);
    setTimeout(() => controller.abort(), 0);
    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('verifies a streamed file against a known SHA-256 digest', async () => {
    await expect(
      verifySavedFile(
        new Blob(['abc']),
        3,
        'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      ),
    ).resolves.toEqual({
      md5: '900150983cd24fb0d6963f7d28e17f72',
      sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    });
  });
  it('rejects truncation and changed bytes even when the file length is correct', async () => {
    const hash = newFileHash();
    hash.update(new TextEncoder().encode('abc'));
    const digest = finishHash(hash);
    await expect(verifySavedFile(new Blob(['ab']), 3, digest)).rejects.toThrow('incomplete');
    await expect(verifySavedFile(new Blob(['abd']), 3, digest)).rejects.toThrow('integrity');
  });
  it('verifies empty files', async () => {
    await expect(
      verifySavedFile(new Blob([]), 0, finishHash(newFileHash())),
    ).resolves.toMatchObject({ md5: 'd41d8cd98f00b204e9800998ecf8427e' });
  });
});

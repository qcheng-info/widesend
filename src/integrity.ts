import { md5 } from '@noble/hashes/legacy.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

export const newMd5 = () => md5.create();
export const finishMd5 = (hash: ReturnType<typeof newMd5>) => bytesToHex(hash.digest());

export function newFileHash() {
  return sha256.create();
}
export function finishHash(hash: ReturnType<typeof newFileHash>): string {
  return bytesToHex(hash.digest());
}

export async function fingerprintFile(
  file: Blob,
  signal?: AbortSignal,
): Promise<{ md5: string; sha256: string }> {
  const hash = newFileHash(),
    md5 = newMd5();
  for (let offset = 0; offset < file.size; offset += 1024 * 1024) {
    signal?.throwIfAborted();
    const bytes = new Uint8Array(await file.slice(offset, offset + 1024 * 1024).arrayBuffer());
    hash.update(bytes);
    md5.update(bytes);
    // Let cancellation, networking, and the UI run during multi-gigabyte reads.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  signal?.throwIfAborted();
  return { sha256: finishHash(hash), md5: finishMd5(md5) };
}

// Read the saved data back before declaring success. Blob.stream() bounds memory
// and catches truncated browser exports as well as incorrect destination writes.
export async function verifySavedFile(
  file: Blob,
  size: number,
  expectedHash: string,
  signal?: AbortSignal,
): Promise<{ md5: string; sha256: string }> {
  if (file.size !== size)
    throw new Error(
      'The browser saved an incomplete file. Use a regular window with enough free storage, or choose a desktop destination.',
    );
  if (!/^[a-f0-9]{64}$/.test(expectedHash)) throw new Error('Invalid file checksum.');
  const hash = newFileHash();
  const md5Hash = newMd5();
  const reader = file.stream().getReader();
  let bytes = 0;
  try {
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      hash.update(value);
      md5Hash.update(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const sha256 = finishHash(hash);
  if (bytes !== size || sha256 !== expectedHash)
    throw new Error(
      'The saved file did not pass its integrity check. Retry using a regular browser window or a different destination.',
    );
  return { md5: finishMd5(md5Hash), sha256 };
}

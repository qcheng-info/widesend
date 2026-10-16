export const CHUNK_SIZE = 32 * 1024;
export const WINDOW_SIZE = 1024 * 1024;
export const MAX_FRAME = 256 * 1024;
// Relay batches share one authenticated frame; disk writes and resume offsets
// retain the same 32 KiB granularity as direct transfers.
export const RELAY_BATCH_SIZE = 16 * CHUNK_SIZE;
export const MAX_RELAY_FRAME = RELAY_BATCH_SIZE + 13 + 12 + 16;
export const MAX_FILES = 100;
export const PAIRING_MS = 20 * 60 * 1000;
// How many people one Send-files code can admit; each gets its own transfer.
export const MAX_RECEIVERS = 10;
export const SESSION_MS = 24 * 60 * 60 * 1000;
export type Role = 'send' | 'receive';
export type FileMeta = { id: number; name: string; size: number; type: string };
export type Fingerprint = { sha256: string; md5: string };
export function validateFingerprints(value: unknown, count: number): Fingerprint[] {
  if (
    !Array.isArray(value) ||
    value.length !== count ||
    value.some((v) => !v || !/^[a-f0-9]{64}$/.test(v.sha256) || !/^[a-f0-9]{32}$/.test(v.md5))
  )
    throw new Error('Invalid file fingerprints.');
  return value.map(({ sha256, md5 }) => ({ sha256, md5 }));
}
export type Control =
  | { type: 'manifest'; files: FileMeta[]; fingerprints?: Fingerprint[] }
  | { type: 'ready'; file: number; offset: number; relayBatch?: 1 }
  | { type: 'ack'; file: number; offset: number }
  | { type: 'file-end'; file: number; hash: string }
  | { type: 'complete' }
  | { type: 'complete-ack' }
  | { type: 'cancel'; reason: string }
  | { type: 'signal'; description?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit }
  | { type: 'probe'; id: number; reply: boolean }
  | { type: 'relay' };

// Used in both the browser and Worker; RTC types are supplied by a Worker-only shim.
export function validOffset(offset: number, size: number): boolean {
  return (
    Number.isSafeInteger(offset) &&
    offset >= 0 &&
    offset <= size &&
    (offset === size || offset % CHUNK_SIZE === 0)
  );
}
export function validateManifest(value: unknown): FileMeta[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_FILES)
    throw new Error('Invalid file list.');
  let total = 0;
  const result = value.map((v, id) => {
    if (
      !v ||
      v.id !== id ||
      typeof v.name !== 'string' ||
      !v.name ||
      v.name.length > 255 ||
      !Number.isSafeInteger(v.size) ||
      v.size < 0 ||
      typeof v.type !== 'string' ||
      v.type.length > 255
    )
      throw new Error('Invalid file details.');
    total += v.size;
    return {
      id,
      name: v.name.replace(/[\\/\u0000-\u001f]/g, '_').replace(/^\.+$/, '_'),
      size: v.size,
      type: v.type,
    };
  });
  if (!Number.isSafeInteger(total)) throw new Error('Transfer is too large.');
  return result;
}

import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FileMeta } from '../../../shared/protocol';
import {
  Destination,
  configureStorage,
  numbered,
  safeName,
  settleStorage,
  storageFailure,
} from '../../src/node-storage';

let folder: string;
beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), 'widesend-storage-'));
  configureStorage({ directory: folder });
});
afterEach(async () => {
  await settleStorage();
  await chmod(folder, 0o755).catch(() => {});
  await rm(folder, { recursive: true, force: true });
});
const hex = (data: Buffer, algorithm = 'sha256') =>
  createHash(algorithm).update(data).digest('hex');
const meta = (name: string, size: number, id = 0): FileMeta => ({ id, name, size, type: '' });
async function receive(destination: Destination, file: FileMeta, data: Buffer, hash = hex(data)) {
  await destination.open(file);
  // Out of order, as relay batches and replays may arrive.
  const half = Math.floor(data.length / 2);
  await destination.write(half, new Uint8Array(data.subarray(half)).buffer);
  await destination.write(0, new Uint8Array(data.subarray(0, half)).buffer);
  return destination.finish(hash);
}

describe('Destination', () => {
  it('writes, verifies and publishes under the original name', async () => {
    const data = Buffer.from('hello, widesend');
    const destination = new Destination();
    await destination.prepare([meta('hello.txt', data.length)]);
    const saved = await receive(destination, meta('hello.txt', data.length), data);
    expect(saved).toMatchObject({ name: 'hello.txt', sha256: hex(data), md5: hex(data, 'md5') });
    expect(fileURLToPath(saved.url)).toBe(join(folder, 'hello.txt'));
    expect(await readFile(join(folder, 'hello.txt'))).toEqual(data);
    expect(await readdir(folder)).toEqual(['hello.txt']);
    expect([saved.file.name, saved.file.size]).toEqual(['hello.txt', data.length]);
    expect(Buffer.from(await saved.file.arrayBuffer())).toEqual(data);
  });
  it('never overwrites: clashes get a number before the extension', async () => {
    await writeFile(join(folder, 'report.pdf'), 'mine');
    await writeFile(join(folder, 'report (1).pdf'), 'mine too');
    const data = Buffer.from('theirs');
    const destination = new Destination();
    const saved = await receive(destination, meta('report.pdf', data.length), data);
    expect(fileURLToPath(saved.url)).toBe(join(folder, 'report (2).pdf'));
    expect(await readFile(join(folder, 'report.pdf'), 'utf8')).toBe('mine');
  });
  it('saves empty files', async () => {
    const destination = new Destination();
    await destination.open(meta('empty.txt', 0));
    const saved = await destination.finish(hex(Buffer.alloc(0)));
    expect(await readFile(fileURLToPath(saved.url))).toHaveLength(0);
  });
  it('refuses a mismatched file and removes it on dispose', async () => {
    const data = Buffer.from('tampered');
    const destination = new Destination();
    await expect(
      receive(destination, meta('x.bin', data.length), data, hex(Buffer.from('other'))),
    ).rejects.toThrow(/did not match/);
    expect(storageFailure()?.message).toMatch(/x\.bin did not match/);
    await destination.dispose();
    expect(await readdir(folder)).toEqual([]);
  });
  it('dispose removes the unfinished part but keeps verified files', async () => {
    const destination = new Destination();
    const data = Buffer.from('done');
    await receive(destination, meta('a.txt', data.length), data);
    await destination.open(meta('b.txt', 10, 1));
    await destination.write(0, new Uint8Array([1, 2, 3]).buffer);
    expect((await readdir(folder)).sort()).toEqual(['a.txt', 'b.txt.part']);
    await destination.dispose();
    expect(await readdir(folder)).toEqual(['a.txt']);
  });
  it('refuses before receiving when space or the folder is missing', async () => {
    await expect(new Destination().prepare([meta('huge.bin', 2 ** 52)])).rejects.toThrow(
      /Not enough free space/,
    );
    configureStorage({ directory: join(folder, 'missing') });
    await expect(new Destination().prepare([meta('a', 1)])).rejects.toThrow(/does not exist/);
  });
  it.skipIf(process.getuid?.() === 0)('refuses a read-only folder', async () => {
    await chmod(folder, 0o555);
    await expect(new Destination().prepare([meta('a', 1)])).rejects.toThrow(/can't write/);
  });
  it('cannot resume partial files yet', async () => {
    await expect(new Destination().open(meta('a', 10), 5, true)).rejects.toThrow(/missing/);
  });
});

describe('file names', () => {
  it('keeps names inside the folder', () => {
    expect(safeName('../../etc/passwd')).toBe('.._.._etc_passwd');
    expect(safeName('..')).toBe('_');
    expect(safeName('a\u0000b')).toBe('a_b');
  });
  it('makes Windows names valid', () => {
    expect(safeName('con.txt', 'win32')).toBe('_con.txt');
    expect(safeName('a:b?.txt', 'win32')).toBe('a_b_.txt');
    expect(safeName('trailing. ', 'win32')).toBe('trailing');
    expect(safeName('con.txt', 'darwin')).toBe('con.txt');
  });
  it('fits long names in 240 bytes and keeps the extension', () => {
    const name = `${'文'.repeat(255)}.pdf`;
    const safe = safeName(name);
    expect(Buffer.byteLength(safe)).toBeLessThanOrEqual(240);
    expect(safe.endsWith('.pdf')).toBe(true);
  });
  it('numbers before the extension', () => {
    expect(numbered('a.tar.gz', 2)).toBe('a.tar (2).gz');
    expect(numbered('.bashrc', 1)).toBe('.bashrc (1)');
    expect(numbered('README', 0)).toBe('README');
  });
});

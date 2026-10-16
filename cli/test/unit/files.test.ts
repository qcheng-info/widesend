import { mkdir, mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { UsageError } from '../../src/errors';
import { openFiles } from '../../src/files';

let folder: string;
beforeAll(async () => {
  folder = await mkdtemp(join(tmpdir(), 'widesend-files-'));
  await writeFile(join(folder, 'photo.JPG'), Buffer.alloc(1000, 7));
  await writeFile(join(folder, 'empty'), '');
  await mkdir(join(folder, 'album'));
});
afterAll(() => rm(folder, { recursive: true, force: true }));

it('opens files lazily with names, sizes and types', async () => {
  const [photo, empty] = await openFiles([join(folder, 'photo.JPG'), join(folder, 'empty')]);
  expect([photo.name, photo.size, photo.type]).toEqual(['photo.JPG', 1000, 'image/jpeg']);
  expect([empty.name, empty.size, empty.type]).toEqual(['empty', 0, '']);
  expect(new Uint8Array(await photo.slice(10, 12).arrayBuffer())).toEqual(new Uint8Array([7, 7]));
});
it('opens files above 4 GiB at their full size', async () => {
  const path = join(folder, 'huge.bin');
  const size = 5 * 1024 ** 3 + 123;
  const handle = await open(path, 'w');
  await handle.truncate(size); // Sparse, so it takes no disk space.
  await handle.write(Buffer.from('edge'), 0, 4, 2 ** 32 - 2);
  await handle.write(Buffer.from('end'), 0, 3, size - 3);
  await handle.close();
  const [huge] = await openFiles([path]);
  expect(huge.size).toBe(size);
  const text = async (blob: Blob) => Buffer.from(await blob.arrayBuffer()).toString();
  expect(await text(huge.slice(2 ** 32 - 2, 2 ** 32 + 2))).toBe('edge');
  expect(await text(huge.slice(-3))).toBe('end');
});
it('refuses to read a file that changed after it was opened', async () => {
  const path = join(folder, 'draft.txt');
  await writeFile(path, 'first');
  const [draft] = await openFiles([path]);
  await writeFile(path, 'second version');
  await expect(draft.slice(0, 2).arrayBuffer()).rejects.toMatchObject({
    name: 'NotReadableError',
  });
});
it('refuses folders, missing files and more than 100 files', async () => {
  await expect(openFiles([join(folder, 'album')])).rejects.toThrow(/is a folder.*tar -czf/s);
  await expect(openFiles([join(folder, 'nope')])).rejects.toThrow(/no such file/);
  await expect(openFiles(Array(101).fill(join(folder, 'empty')))).rejects.toThrow(/up to 100/);
  await expect(openFiles([])).rejects.toThrow(UsageError);
});

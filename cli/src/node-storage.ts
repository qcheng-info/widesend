import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  access,
  constants,
  link,
  open,
  rename,
  stat,
  statfs,
  unlink,
  type FileHandle,
} from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { FileMeta } from '../../shared/protocol';
import { formatBytes } from '../../src/format';
import { diskFile } from './files';

/** Replaces src/storage.ts in the CLI bundle. `url` is the saved file's file: URL. */
export type SavedFile = {
  id: number;
  name: string;
  size: number;
  url: string;
  file: File;
  md5: string;
  sha256: string;
  keepAvailable: () => void;
};

let directory = process.cwd();
let platform: NodeJS.Platform = process.platform;
let lastFailure: Error | undefined;
const active = new Set<Destination>();

export function configureStorage(options: { directory: string; platform?: NodeJS.Platform }) {
  directory = resolve(options.directory);
  platform = options.platform ?? process.platform;
  lastFailure = undefined;
}
/** The engine replaces unknown error text with a generic message; the CLI shows this instead. */
export function storageFailure(): Error | undefined {
  return lastFailure;
}
/** Waits until unfinished files of a cancelled or failed transfer are removed. */
export async function settleStorage(): Promise<void> {
  await Promise.all([...active].map((destination) => destination.dispose()));
}
function failure(message: string): Error {
  lastFailure = new Error(message);
  return lastFailure;
}

export async function checkFolder(path: string): Promise<void> {
  let info;
  try {
    info = await stat(path);
  } catch {
    throw failure(`The folder ${path} does not exist.`);
  }
  if (!info.isDirectory()) throw failure(`${path} is not a folder.`);
  try {
    await access(path, constants.W_OK);
  } catch {
    throw failure(`You can't write to ${path}.`);
  }
}

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
// Leaves room for " (99)" and ".part" within the usual 255-byte name limit.
const MAX_NAME_BYTES = 240;
/** A file name valid on this platform that cannot leave the folder. */
export function safeName(name: string, os: NodeJS.Platform = platform): string {
  let result = name.replace(/[\\/\u0000-\u001f]/g, '_');
  if (os === 'win32') {
    result = result.replace(/[<>:"|?*]/g, '_').replace(/[. ]+$/, '');
    if (RESERVED.test(result)) result = `_${result}`;
  }
  if (!result || /^\.+$/.test(result)) result = '_';
  if (Buffer.byteLength(result) <= MAX_NAME_BYTES) return result;
  const ext = extname(result);
  const keep = Buffer.byteLength(ext) <= 32 ? ext : '';
  const stem = [...result.slice(0, result.length - keep.length)];
  while (Buffer.byteLength(stem.join('') + keep) > MAX_NAME_BYTES) stem.pop();
  return stem.join('') + keep;
}
/** `report.pdf`, `report (1).pdf`, …, as browsers name duplicate downloads. */
export function numbered(name: string, n: number): string {
  if (!n) return name;
  const ext = extname(name);
  return `${name.slice(0, name.length - ext.length)} (${n})${ext}`;
}

export function downloadFile(_file: SavedFile): void {
  // Verified files are already in their folder; the summary lists them.
}

async function fingerprint(path: string) {
  const sha256 = createHash('sha256');
  const md5 = createHash('md5');
  let size = 0;
  for await (const chunk of createReadStream(path)) {
    size += chunk.length;
    sha256.update(chunk);
    md5.update(chunk);
  }
  return { size, sha256: sha256.digest('hex'), md5: md5.digest('hex') };
}
// Filesystems without hard links (FAT, exFAT, some network shares) report these.
const NO_LINKS = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV', 'EMLINK']);

export class Destination {
  folder = directory;
  private handle?: FileHandle;
  private current?: { meta: FileMeta; part: string };
  private unfinished = new Set<string>();
  private disposing?: Promise<void>;
  constructor() {
    active.add(this);
  }
  async prepare(files: FileMeta[]): Promise<void> {
    this.folder = directory;
    await checkFolder(this.folder);
    const needed = files.reduce((sum, file) => sum + file.size, 0);
    const space = await statfs(this.folder, { bigint: true });
    const free = Number(space.bavail * space.bsize);
    if (needed + 16 * 1024 * 1024 > free)
      throw failure(
        `Not enough free space in ${this.folder}: the files need ${formatBytes(needed)} and ${formatBytes(free)} is free.`,
      );
  }
  async open(file: FileMeta, offset = 0, resume = false): Promise<void> {
    // Partial files do not outlive the process yet (see `widesend resume`).
    if (offset || resume) throw failure('Saved transfer data is missing.');
    await this.closeFile();
    const name = safeName(file.name);
    for (let n = 0; ; n++) {
      const part = join(this.folder, `${numbered(name, n)}.part`);
      try {
        this.handle = await open(part, 'wx');
        this.current = { meta: file, part };
        this.unfinished.add(part);
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || n >= 9999)
          throw failure(`Cannot create a file in ${this.folder}: ${(error as Error).message}`);
      }
    }
  }
  async flush(): Promise<void> {
    // Writes are awaited, and progress does not outlive the process yet. Resume
    // will need datasync() here before a checkpoint is saved.
  }
  async write(offset: number, data: ArrayBuffer): Promise<void> {
    const bytes = new Uint8Array(data);
    try {
      for (let done = 0; done < bytes.length;) {
        const { bytesWritten } = await this.handle!.write(
          bytes,
          done,
          bytes.length - done,
          offset + done,
        );
        done += bytesWritten;
      }
    } catch (error) {
      throw failure(`Could not write ${this.current?.meta.name}: ${(error as Error).message}`);
    }
  }
  async finish(expectedHash: string): Promise<SavedFile> {
    const { meta, part } = this.current!;
    await this.closeFile();
    const { size, sha256, md5 } = await fingerprint(part);
    if (size !== meta.size || sha256 !== expectedHash)
      throw failure(`${meta.name} did not match the sender's checksum, so it was not saved.`);
    const path = await this.publish(part, safeName(meta.name));
    this.unfinished.delete(part);
    this.current = undefined;
    return {
      ...meta,
      md5,
      sha256,
      url: pathToFileURL(path).href,
      file: await diskFile(path, basename(path), meta.type),
      keepAvailable: () => {},
    };
  }
  async restoreFile(): Promise<SavedFile> {
    throw failure('Saved transfer data is missing.');
  }
  dispose(): Promise<void> {
    return (this.disposing ??= this.cleanup());
  }
  async suspend(): Promise<void> {
    // Nothing can continue a CLI transfer after it stops, so unfinished files go.
    await this.dispose();
  }
  private async cleanup(): Promise<void> {
    await this.closeFile().catch(() => {});
    await Promise.all([...this.unfinished].map((part) => unlink(part).catch(() => {})));
    this.unfinished.clear();
    active.delete(this);
  }
  private async closeFile(): Promise<void> {
    const handle = this.handle;
    this.handle = undefined;
    await handle?.close();
  }
  // Takes the first free name. A hard link fails if the name exists, so a file
  // created meanwhile by someone else is never replaced.
  private async publish(part: string, name: string): Promise<string> {
    for (let n = 0; n < 10_000; n++) {
      const target = join(this.folder, numbered(name, n));
      if (dirname(target) !== this.folder) break;
      try {
        await link(part, target);
        await unlink(part);
        return target;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code ?? '';
        if (code === 'EEXIST') continue;
        if (!NO_LINKS.has(code))
          throw failure(`Could not save ${name}: ${(error as Error).message}`);
      }
      try {
        await (await open(target, 'wx')).close();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
        throw failure(`Could not save ${name}: ${(error as Error).message}`);
      }
      await rename(part, target);
      return target;
    }
    throw failure(`Could not find a free name for ${name} in ${this.folder}.`);
  }
}

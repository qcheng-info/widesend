import { fstat, open, read } from 'node:fs';
import { access, constants, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { promisify } from 'node:util';
import { MAX_FILES } from '../../shared/protocol';
import { UsageError } from './errors';
import { mimeType } from './mime';

const openFd = promisify(open);
const fstatFd = promisify(fstat);
const readFd = promisify(read);
type Source = { path: string; size: number; mtimeMs: number; fd?: Promise<number> };

/**
 * A file on disk as a File that is read only when sliced pieces are read. Node's
 * openAsBlob gives files above 4 GiB their size modulo 4 GiB (Node 24), so this
 * reads through a descriptor instead, kept open until the process ends. Like
 * openAsBlob, it refuses to read a file that changed after it was opened.
 */
class DiskFile extends File {
  constructor(
    private readonly source: Source,
    private readonly start: number,
    end: number,
    name: string,
    type: string,
  ) {
    super([], name, { type, lastModified: Math.round(source.mtimeMs) });
    Object.defineProperty(this, 'size', { value: end - start });
  }
  slice(start = 0, end = this.size, type = ''): Blob {
    const clamp = (n: number) => Math.min(this.size, Math.max(0, n < 0 ? this.size + n : n));
    const from = clamp(start);
    const to = Math.max(from, clamp(end));
    return new DiskFile(this.source, this.start + from, this.start + to, this.name, type);
  }
  async bytes(): Promise<Uint8Array<ArrayBuffer>> {
    const bytes = new Uint8Array(this.size);
    if (!bytes.length) return bytes;
    const { source } = this;
    const fd = await (source.fd ??= openFd(source.path, 'r'));
    const now = await fstatFd(fd);
    const changed = () =>
      new DOMException(
        `${basename(source.path)} changed after WideSend opened it. Send it again.`,
        'NotReadableError',
      );
    if (now.size !== source.size || now.mtimeMs !== source.mtimeMs) throw changed();
    for (let done = 0; done < bytes.length;) {
      const { bytesRead } = await readFd(fd, bytes, done, bytes.length - done, this.start + done);
      if (!bytesRead) throw changed();
      done += bytesRead;
    }
    return bytes;
  }
  async arrayBuffer(): Promise<ArrayBuffer> {
    return (await this.bytes()).buffer;
  }
  async text(): Promise<string> {
    return new TextDecoder().decode(await this.bytes());
  }
  stream(): ReadableStream<Uint8Array<ArrayBuffer>> {
    let at = 0;
    return new ReadableStream({
      pull: async (controller) => {
        if (at >= this.size) return controller.close();
        const piece = await (this.slice(at, at + 1024 * 1024) as DiskFile).bytes();
        at += piece.length;
        controller.enqueue(piece);
      },
    });
  }
}
export async function diskFile(path: string, name: string, type: string): Promise<File> {
  const { size, mtimeMs } = await stat(path);
  return new DiskFile({ path, size, mtimeMs }, 0, size, name, type);
}

/** Opens the files to send without reading them. Each is read as it is sent. */
export async function openFiles(paths: string[]): Promise<File[]> {
  if (!paths.length) throw new UsageError('Name at least one file to send.');
  if (paths.length > MAX_FILES)
    throw new UsageError(
      `WideSend sends up to ${MAX_FILES} files at once, and you named ${paths.length}. Put them in a .zip or .tar first.`,
    );
  const files: File[] = [];
  for (const path of paths) {
    let info;
    try {
      info = await stat(path);
    } catch {
      throw new UsageError(`${path}: no such file.`);
    }
    if (info.isDirectory())
      throw new UsageError(
        `${path} is a folder. Put it in an archive first, for example:\n  tar -czf ${basename(path)}.tar.gz ${path}`,
      );
    if (!info.isFile()) throw new UsageError(`${path} is not a regular file.`);
    if (basename(path).length > 255)
      throw new UsageError(`${path}: file names can be at most 255 characters.`);
    try {
      await access(path, constants.R_OK);
      files.push(await diskFile(path, basename(path), mimeType(path)));
    } catch (error) {
      throw new UsageError(`Cannot read ${path}: ${(error as Error).message}`);
    }
  }
  return files;
}

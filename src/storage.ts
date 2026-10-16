import type { FileMeta } from '../shared/protocol';
import { token } from './crypto';
import { verifySavedFile } from './integrity';

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
const managedPrefix = 'widesend-download-';
const marker = '.last-used';
const retention = 24 * 60 * 60 * 1000;

// A page cannot observe completion of an ordinary browser download. Keep its
// backing data for the page lifetime, then allow cleanup on a later visit.
export async function cleanupOldDownloads(): Promise<void> {
  if (!navigator.storage?.getDirectory || !navigator.locks) return;
  const root = await navigator.storage.getDirectory();
  for await (const name of (
    root as FileSystemDirectoryHandle & { keys(): AsyncIterableIterator<string> }
  ).keys()) {
    if (!name.startsWith(managedPrefix)) continue;
    await navigator.locks.request(name, { ifAvailable: true }, async (lock) => {
      if (!lock) return;
      try {
        const folder = await root.getDirectoryHandle(name);
        const timestamp = await (await folder.getFileHandle(marker)).getFile();
        if (timestamp.size > 32) return;
        const lastUsed = Number(await timestamp.text());
        if (Number.isFinite(lastUsed) && lastUsed > 0 && lastUsed < Date.now() - retention)
          await root.removeEntry(name, { recursive: true });
      } catch {
        /* Missing markers, active handles, or denied access: leave the folder alone. */
      }
    });
  }
}

export function downloadFile(file: SavedFile): void {
  file.keepAvailable();
  const link = document.createElement('a');
  link.href = file.url;
  link.download = file.name;
  link.hidden = true;
  document.body.append(link);
  try {
    link.click();
  } finally {
    link.remove();
  }
}

export class Destination {
  private worker?: Worker;
  private pending = new Map<number, { resolve: () => void; reject: (error: Error) => void }>();
  private sequence = 0;
  folder = `widesend-unmanaged-${token()}`;
  private directory?: FileSystemDirectoryHandle;
  private published = new Set<string>();
  private current?: FileMeta;
  private workerFailure?: Error;
  private abortController = new AbortController();
  private releaseLock?: () => void;
  private touching = Promise.resolve();
  private disposing?: Promise<void>;

  private touch(): Promise<void> {
    this.touching = this.touching
      .catch(() => {})
      .then(async () => {
        if (!this.directory) return;
        const handle = await this.directory.getFileHandle(marker, { create: true });
        const writable = await handle.createWritable();
        await writable.write(String(Date.now()));
        await writable.close();
      });
    return this.touching;
  }
  // `keep` names a folder outside the 24-hour download cleanup (room history).
  async prepare(files: FileMeta[], resumeFolder?: string, keep?: string): Promise<void> {
    if (!navigator.storage?.getDirectory)
      throw new Error(
        'This browser cannot stream large files to disk. Update your browser or use Chrome, Safari, or Firefox.',
      );
    let root: FileSystemDirectoryHandle;
    try {
      root = await navigator.storage.getDirectory();
    } catch {
      throw new Error(
        'This browser is blocking local disk storage. Use a regular (non-private) window and allow site storage.',
      );
    }
    await cleanupOldDownloads().catch(() => {});
    const estimate = await navigator.storage.estimate();
    const needed = files.reduce((sum, file) => sum + file.size, 0);
    if (
      !resumeFolder &&
      estimate.quota &&
      needed + 16 * 1024 * 1024 > estimate.quota - (estimate.usage || 0)
    )
      throw new Error(
        'There isn’t enough space for these files. Free up space or choose another device.',
      );
    if (keep) this.folder = keep;
    if (navigator.locks) {
      const name = resumeFolder ?? keep ?? `${managedPrefix}${token()}`;
      await new Promise<void>((resolve, reject) => {
        void navigator.locks
          .request(name, { ifAvailable: true }, (lock) => {
            if (!lock) {
              reject(new Error('This transfer is open in another tab.'));
              return;
            }
            this.folder = name;
            return new Promise<void>((release) => {
              this.releaseLock = release;
              resolve();
            });
          })
          .catch(reject);
      });
    }
    this.directory = await root.getDirectoryHandle(this.folder, { create: !resumeFolder });
    await this.touch();
    this.worker = new Worker(new URL('./disk-worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = ({ data }) => {
      const request = this.pending.get(data.id);
      this.pending.delete(data.id);
      if (data.error) request?.reject(new Error(data.error));
      else request?.resolve();
    };
    this.worker.onerror = () => {
      this.workerFailure = new Error(
        'Browser disk storage failed. Try an updated browser in a regular window.',
      );
      for (const request of this.pending.values()) request.reject(this.workerFailure);
      this.pending.clear();
    };
  }
  private rpc(
    command: string,
    args: Record<string, unknown> = {},
    transfer: Transferable[] = [],
  ): Promise<void> {
    if (this.workerFailure) return Promise.reject(this.workerFailure);
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      this.pending.set(id, { resolve, reject });
      this.worker!.postMessage({ id, command, ...args }, transfer);
    });
  }
  async open(file: FileMeta, offset = 0, resume = false): Promise<void> {
    this.current = file;
    await this.rpc('open', { folder: this.folder, name: String(file.id), offset, resume });
  }
  async flush(): Promise<void> {
    await this.rpc('flush');
  }
  async write(offset: number, data: ArrayBuffer): Promise<void> {
    await this.rpc('write', { offset, data }, [data]);
  }
  async finish(expectedHash: string): Promise<SavedFile> {
    const metadata = this.current!;
    await this.rpc('close');
    return this.restoreFile(metadata, expectedHash);
  }
  async restoreFile(metadata: FileMeta, expectedHash: string): Promise<SavedFile> {
    const raw = await (await this.directory!.getFileHandle(String(metadata.id))).getFile();
    // This references disk-backed data; never load the entire file into RAM.
    const file = new File([raw], metadata.name, {
      type: metadata.type || 'application/octet-stream',
    });
    const fingerprints = await verifySavedFile(
      file,
      metadata.size,
      expectedHash,
      this.abortController.signal,
    );
    const url = URL.createObjectURL(file);
    this.published.add(String(metadata.id));
    await this.touch().catch(() => {});
    return {
      ...metadata,
      ...fingerprints,
      file,
      url,
      keepAvailable: () => {
        void this.touch().catch(() => {});
      },
    };
  }
  dispose(): Promise<void> {
    return (this.disposing ??= this.cleanup());
  }
  async suspend(): Promise<void> {
    this.abortController.abort();
    if (this.worker) {
      await this.rpc('close').catch(() => {});
      this.worker.terminate();
      this.worker = undefined;
    }
    await this.touching.catch(() => {});
    this.releaseLock?.();
    this.releaseLock = undefined;
  }
  private async cleanup(): Promise<void> {
    this.abortController.abort();
    if (this.worker) {
      await this.rpc('close').catch(() => {});
      this.worker.terminate();
      this.worker = undefined;
    }
    if (this.published.size) {
      // Reset/cancel must not revoke URLs or delete files handed to the browser.
      await this.touch().catch(() => {});
      if (this.directory) {
        for await (const name of (
          this.directory as FileSystemDirectoryHandle & { keys(): AsyncIterableIterator<string> }
        ).keys()) {
          if (name !== marker && !this.published.has(name))
            await this.directory.removeEntry(name).catch(() => {});
        }
      }
      return; // Lock and object URLs live until this page is destroyed.
    }
    try {
      if (this.directory) {
        await this.touching.catch(() => {});
        const root = await navigator.storage.getDirectory();
        await root.removeEntry(this.folder, { recursive: true });
      }
    } catch {
      /* A later visit can clean abandoned data. */
    } finally {
      this.releaseLock?.();
      this.releaseLock = undefined;
    }
  }
}

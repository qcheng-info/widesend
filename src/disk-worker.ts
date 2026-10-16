/// <reference lib="webworker" />
export {};
// OPFS sync handles are available in dedicated workers on modern Safari, Firefox,
// and Chromium. Each RPC is acknowledged only after the bytes have been written.
type SyncHandle = {
  write(data: Uint8Array, options: { at: number }): number;
  flush(): void;
  close(): void;
  truncate(size: number): void;
  getSize(): number;
};
let handle: SyncHandle | undefined;
let sinceFlush = 0;
self.onmessage = async (event: MessageEvent) => {
  const { id, command, folder, name, data, offset } = event.data;
  try {
    if (command === 'open') {
      const root = await navigator.storage.getDirectory();
      const directory = await root.getDirectoryHandle(folder, { create: !event.data.resume });
      const file = await directory.getFileHandle(name, { create: !event.data.resume });
      handle = await (
        file as FileSystemFileHandle & { createSyncAccessHandle(): Promise<SyncHandle> }
      ).createSyncAccessHandle();
      if (event.data.resume && handle.getSize() < offset)
        throw new Error('Saved transfer data is missing.');
      handle.truncate(offset ?? 0);
      sinceFlush = 0;
    } else if (command === 'write') {
      if (!handle) throw new Error('The destination file is not open.');
      const bytes = new Uint8Array(data);
      let written = 0;
      while (written < bytes.length) {
        const count = handle.write(bytes.subarray(written), { at: offset + written });
        if (!count) throw new Error('No disk space available.');
        written += count;
      }
      sinceFlush += written;
      if (sinceFlush >= 4 * 1024 * 1024) {
        handle.flush();
        sinceFlush = 0;
      }
    } else if (command === 'flush') {
      handle?.flush();
      sinceFlush = 0;
    } else if (command === 'close') {
      handle?.flush();
      handle?.close();
      handle = undefined;
    }
    self.postMessage({ id, ok: true });
  } catch (error) {
    self.postMessage({ id, error: error instanceof Error ? error.message : 'Disk write failed.' });
  }
};

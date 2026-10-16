import { finishHash, finishMd5, newFileHash, newMd5 } from '../integrity';
import { MerkleTree, leafHash, pieceBounds, pieceCount } from './pieces';

export type Prepared = {
  name: string;
  size: number;
  type: string;
  leaves: Uint8Array[];
  tree: MerkleTree;
  sha256: string;
  md5: string;
};

// One bounded read pass: piece leaves for the Merkle tree plus the full-file
// fingerprints used for final verification and the activity log.
export async function prepareFile(
  file: Blob & { name: string },
  onBytes?: (bytes: number) => void,
  signal?: AbortSignal,
): Promise<Prepared> {
  const hash = newFileHash(),
    md5 = newMd5(),
    leaves: Uint8Array[] = [];
  for (let index = 0; index < pieceCount(file.size); index++) {
    signal?.throwIfAborted();
    const [start, end] = pieceBounds(file.size, index);
    const bytes = new Uint8Array(await file.slice(start, end).arrayBuffer());
    hash.update(bytes);
    md5.update(bytes);
    leaves.push(await leafHash(bytes));
    onBytes?.(bytes.length);
    // Let networking and the interface run during multi-gigabyte reads.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  signal?.throwIfAborted();
  return {
    name: file.name,
    size: file.size,
    type: file.type,
    leaves,
    tree: new MerkleTree(leaves),
    sha256: finishHash(hash),
    md5: finishMd5(md5),
  };
}

// Sending the same File objects to more people reuses the first pass.
export class PreparedCache {
  private cache = new WeakMap<Blob, Promise<Prepared>>();
  get(file: File, onBytes?: (bytes: number) => void, signal?: AbortSignal): Promise<Prepared> {
    let prepared = this.cache.get(file);
    if (!prepared) {
      prepared = prepareFile(file, onBytes, signal);
      this.cache.set(file, prepared);
      prepared.catch(() => this.cache.delete(file));
    }
    return prepared;
  }
}

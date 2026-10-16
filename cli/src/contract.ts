// The CLI bundle swaps these Node modules into src/transfer.ts. If the web modules
// change what transfer.ts relies on, these lines stop compiling before the CLI breaks.
import type * as WebRecovery from '../../src/recovery';
import type * as WebStorage from '../../src/storage';
import type * as NodeRecovery from './node-recovery';
import type * as NodeStorage from './node-storage';

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type DestinationUse =
  | 'folder'
  | 'prepare'
  | 'open'
  | 'flush'
  | 'write'
  | 'finish'
  | 'restoreFile'
  | 'dispose'
  | 'suspend';
type RecoveryUse = 'record' | 'save' | 'remove' | 'unlock';

export const contract: [
  Same<WebStorage.SavedFile, NodeStorage.SavedFile>,
  Same<Parameters<typeof WebStorage.downloadFile>, Parameters<typeof NodeStorage.downloadFile>>,
  Same<
    Parameters<typeof WebRecovery.RecoverySession.create>,
    Parameters<typeof NodeRecovery.RecoverySession.create>
  >,
] = [true, true, true];
export const destination = (
  d: NodeStorage.Destination,
): Pick<WebStorage.Destination, DestinationUse> => d;
export const recovery = (
  r: NodeRecovery.RecoverySession,
): Pick<WebRecovery.RecoverySession, RecoveryUse> => r;

import type { RecoveryRecord } from '../../src/recovery';

let discard: () => void = () => {};
/** Resolves when the engine drops its record: after the final acknowledgement, a cancel or a failure. */
export const progressDiscarded = new Promise<void>((resolve) => (discard = resolve));

/**
 * Replaces src/recovery.ts in the CLI bundle. Progress lives only as long as the
 * process; `widesend resume` will keep this record in a file instead.
 */
export class RecoverySession {
  private constructor(public record: RecoveryRecord) {}
  static async create(record: RecoveryRecord): Promise<RecoverySession> {
    return new RecoverySession({ ...record });
  }
  static async restore(): Promise<RecoverySession | undefined> {
    return undefined;
  }
  static async group(): Promise<RecoverySession[]> {
    return [];
  }
  async save(patch: Partial<RecoveryRecord>): Promise<void> {
    this.record = { ...this.record, ...patch, updated: Date.now() };
  }
  async remove(): Promise<void> {
    discard();
  }
  async unlock(): Promise<void> {}
}

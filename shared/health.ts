import type { RelayHealth } from './relay';
export const DAY = 86_400_000;
export const HOUR = 3_600_000;
export type BlockKind = 'burst' | 'codes' | 'transfers';
export type BlockCounts = Record<BlockKind, number>;
export type BlockBucket = BlockCounts & { hour: number };
export type ProtectionHealth = {
  observedAt: number;
  recordingSince: number;
  reservedTransfers: number;
  reservedConnections: number;
  transferLimit: number;
  networkLimit: number;
  blocks: BlockBucket[];
  relay?: RelayHealth;
};
export const emptyBlocks = (): BlockCounts => ({ burst: 0, codes: 0, transfers: 0 });

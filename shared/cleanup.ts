export type CleanupHealth = {
  observedAt: number;
  lastStartedAt: number | null;
  lastFinishedAt: number | null;
  lastSuccessAt: number | null;
  lastErrorAt: number | null;
  running: boolean;
  deletedTransfers: number;
  deletedRows: number;
  rowsWritten: number;
  overdueTransfers: number;
  oldestExpiredAt: number | null;
};

import { DAY, HOUR } from '../../shared/health';
export function healthFixture(now = Date.now()) {
  const today = Math.floor(now / DAY) * DAY;
  return {
    generatedAt: now,
    cleanup: {
      observedAt: now,
      lastStartedAt: now - 60000,
      lastFinishedAt: now - 59000,
      lastSuccessAt: now - 59000,
      lastErrorAt: null,
      running: false,
      deletedTransfers: 30,
      deletedRows: 150,
      rowsWritten: 540,
      overdueTransfers: 0,
      oldestExpiredAt: null,
    },
    activity: {
      today: {
        from: today,
        to: now,
        total: 12,
        outcomes: {
          complete: 8,
          transferring: 2,
          waiting: 1,
          error: 1,
          cancelled: 0,
          interrupted: 0,
          expired: 0,
        },
        routes: { direct: 6, relay: 4, unknown: 2 },
        reconnections: 3,
      },
      last7Days: {
        from: today - 6 * DAY,
        to: now,
        total: 40,
        outcomes: {
          complete: 25,
          transferring: 3,
          waiting: 2,
          error: 4,
          cancelled: 1,
          interrupted: 3,
          expired: 2,
        },
        routes: { direct: 20, relay: 12, unknown: 8 },
        reconnections: 14,
      },
      daily: [],
    },
    protection: {
      observedAt: now,
      recordingSince: today - 2 * DAY,
      reservedTransfers: 3,
      reservedConnections: 5,
      transferLimit: 25,
      networkLimit: 5,
      relay: {
        observedAt: now,
        recordingSince: today - 2 * DAY,
        budget: { dailyRequestUnits: 50000, stopNewAtPercent: 80 },
        acceptingNew: true,
        resetAt: today + DAY,
        daily: [
          {
            day: today - DAY,
            messages: 400000,
            bytes: 50 * 1024 ** 3,
            admitted: 4,
            denied: 1,
            updatedAt: today - 1,
          },
          {
            day: today,
            messages: 200000,
            bytes: 25 * 1024 ** 3,
            admitted: 2,
            denied: 0,
            updatedAt: now,
          },
        ],
      },
      blocks: [
        { hour: today - HOUR, burst: 7, codes: 2, transfers: 1 },
        { hour: today, burst: 2, codes: 3, transfers: 1 },
      ],
    },
  };
}

import { DAY } from './health';

export type RelayBudget = { dailyRequestUnits: number; stopNewAtPercent: number };
export const DEFAULT_RELAY_BUDGET: RelayBudget = {
  dailyRequestUnits: 50_000,
  stopNewAtPercent: 80,
};
export function readRelayBudget(value?: Partial<RelayBudget>): RelayBudget {
  const result = { ...DEFAULT_RELAY_BUDGET };
  for (const key of Object.keys(result) as (keyof RelayBudget)[]) {
    const n = value?.[key];
    if (n === undefined) continue;
    if (!Number.isSafeInteger(n) || n <= 0 || n > (key === 'stopNewAtPercent' ? 100 : 100_000))
      throw new Error(`Invalid relay budget: ${key}`);
    result[key] = n;
  }
  return result;
}
export const utcDay = (now: number) => Math.floor(now / DAY) * DAY;
export type UsageSnapshot = { day: number; messages: number; bytes: number };
export type RelayDay = UsageSnapshot & { admitted: number; denied: number; updatedAt: number };
export type RelayHealth = {
  observedAt: number;
  recordingSince: number;
  budget: RelayBudget;
  acceptingNew: boolean;
  resetAt: number;
  daily: RelayDay[];
};

// Only the browser-to-Worker hop has this envelope. The Worker strips it before
// forwarding, so old receivers still get the same authenticated ciphertext.
export function relayFrame(frame: ArrayBuffer, file: boolean): ArrayBuffer {
  const wrapped = new Uint8Array(frame.byteLength + 1);
  wrapped[0] = file ? 1 : 0;
  wrapped.set(new Uint8Array(frame), 1);
  return wrapped.buffer;
}

import type { Role } from '../shared/protocol';

// Each use of a Send-files code is a slot: a whole one-to-one session with its
// own receiver, key round, relay approval and activity record.
export type State = {
  owner: string;
  uses: number;
  receivers: (string | null)[];
  ended: number[];
  relayAdmitted: number[];
  expires: number;
  pairExpires: number;
};
type Legacy = {
  owner: string;
  receiver?: string;
  expires: number;
  pairExpires: number;
  ended?: boolean;
  relayAdmitted?: boolean;
};

/** Sessions stored before slots existed are one-receiver sessions. */
export function readState(value: unknown): State | undefined {
  if (!value) return;
  const stored = value as State & Legacy;
  if (Array.isArray(stored.receivers)) return stored;
  return {
    owner: stored.owner,
    uses: 1,
    receivers: [stored.receiver ?? null],
    ended: stored.ended ? [0] : [],
    relayAdmitted: stored.relayAdmitted ? [0] : [],
    expires: stored.expires,
    pairExpires: stored.pairExpires,
  };
}
export const claimed = (state: State) => state.receivers.some(Boolean);
export const unclaimedSlots = (state: State) =>
  state.receivers.flatMap((receiver, slot) =>
    !receiver && !state.ended.includes(slot) ? [slot] : [],
  );
export const freeSlot = (state: State) => unclaimedSlots(state)[0] ?? -1;
// Slot 0 keeps the identifiers one-receiver transfers have always used.
export const slotRole = (role: Role, slot: number) => (slot ? `${role}:${slot}` : role);
export const slotActivity = (owner: string, slot: number) => (slot ? `${owner}:${slot}` : owner);

import { describe, expect, it } from 'vitest';
import {
  claimed,
  freeSlot,
  readState,
  slotActivity,
  slotRole,
  unclaimedSlots,
} from '../../worker/slots';

const base = { owner: 'o', expires: 2, pairExpires: 1 };
describe('slot state', () => {
  it('reads a session stored before slots as slot 0 of 1', () => {
    expect(readState({ ...base, receiver: 'r', ended: true, relayAdmitted: true })).toEqual({
      ...base,
      uses: 1,
      receivers: ['r'],
      ended: [0],
      relayAdmitted: [0],
    });
    expect(readState({ ...base })).toEqual({
      ...base,
      uses: 1,
      receivers: [null],
      ended: [],
      relayAdmitted: [],
    });
    expect(readState(undefined)).toBeUndefined();
  });
  it('finds the lowest free slot and every unclaimed one', () => {
    const state = readState({
      ...base,
      uses: 4,
      receivers: ['a', null, null, null],
      ended: [1],
      relayAdmitted: [],
    })!;
    expect(claimed(state)).toBe(true);
    expect(freeSlot(state)).toBe(2);
    expect(unclaimedSlots(state)).toEqual([2, 3]);
    expect(freeSlot({ ...state, ended: [1, 2, 3] })).toBe(-1);
    expect(claimed({ ...state, receivers: [null, null, null, null] })).toBe(false);
  });
  it('keeps the identifiers of slot 0 unchanged', () => {
    expect(slotRole('send', 0)).toBe('send');
    expect(slotRole('receive', 3)).toBe('receive:3');
    expect(slotActivity('o', 0)).toBe('o');
    expect(slotActivity('o', 2)).toBe('o:2');
  });
});

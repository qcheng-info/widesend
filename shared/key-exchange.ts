// An explicit version, never negotiated down to password-derived encryption.
export const KEY_EXCHANGE = 2;
export const PAKE_SUITE = 'widesend-v2-SPAKE2-P256-SHA256';
export type KeyMessage =
  | {
      type: 'key-exchange';
      round: string;
      step: 'share';
      suite: typeof PAKE_SUITE;
      point: string;
      identity: string;
    }
  | { type: 'key-exchange'; round: string; step: 'confirm'; mac: string; signature: string };

export function validKeyMessage(value: unknown): value is KeyMessage {
  if (!value || typeof value !== 'object') return false;
  const m = value as Record<string, unknown>;
  const hex = (v: unknown, length: number) =>
    typeof v === 'string' && v.length === length && /^[0-9a-f]+$/.test(v);
  if (m.type !== 'key-exchange' || typeof m.round !== 'string' || !/^[0-9a-f-]{36}$/.test(m.round))
    return false;
  if (m.step === 'share')
    return m.suite === PAKE_SUITE && hex(m.point, 130) && hex(m.identity, 130);
  return m.step === 'confirm' && hex(m.mac, 64) && hex(m.signature, 128);
}

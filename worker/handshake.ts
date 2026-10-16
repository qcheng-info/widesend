import { roomId, validPairingCode } from '../shared/pairing';
import { MAX_RECEIVERS, type Role } from '../shared/protocol';
export type Hello = {
  role: Role;
  code?: string;
  credential: string;
  receiver?: string;
  expires?: number;
  pairExpires?: number;
  relayBatch?: 1;
  relayPolicy?: 1;
  keyExchange?: 2;
  // A sender's code may admit several receivers; each is a slot of the session.
  uses?: number;
  slot?: number;
};
const credentialPattern = /^[A-Za-z0-9_-]{43}$/;
const count = (value: unknown, min: number, max: number) =>
  value === undefined ||
  (Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max);
export async function parseHello(request: Request): Promise<Hello> {
  const protocols = request.headers
    .get('Sec-WebSocket-Protocol')
    ?.split(',')
    .map((s) => s.trim());
  if (protocols?.length !== 2 || protocols[0] !== 'widesend' || protocols[1].length > 1500)
    throw new Error('Invalid handshake');
  const hello: Hello = JSON.parse(atob(protocols[1].replace(/-/g, '+').replace(/_/g, '/')));
  if (
    !hello ||
    !['send', 'receive'].includes(hello.role) ||
    typeof hello.credential !== 'string' ||
    !credentialPattern.test(hello.credential) ||
    (hello.relayBatch !== undefined && hello.relayBatch !== 1) ||
    (hello.relayPolicy !== undefined && hello.relayPolicy !== 1) ||
    (hello.keyExchange !== undefined && hello.keyExchange !== 2) ||
    (hello.receiver !== undefined &&
      (typeof hello.receiver !== 'string' || !credentialPattern.test(hello.receiver))) ||
    !count(hello.uses, 1, MAX_RECEIVERS) ||
    !count(hello.slot, 0, (hello.uses ?? 1) - 1) ||
    (hello.role === 'receive' && (hello.uses !== undefined || hello.slot !== undefined))
  )
    throw new Error('Invalid handshake');
  if (
    hello.code !== undefined &&
    (!validPairingCode(hello.code) ||
      new URL(request.url).pathname !== `/api/rooms/${await roomId(hello.code)}`)
  )
    throw new Error('Invalid code');
  return hello;
}

import { describe, expect, it } from 'vitest';
import { createIdentity } from '../../src/key-session';
import { Link, type LinkHost, type LinkMessage } from '../../src/room/link';

const locator = 'ab'.repeat(32);
// Two members' links joined by a relay that delays each frame by up to `delay` ms
// but, like the room's WebSocket relay, keeps each direction in order.
async function pair(delay: () => number, onDeliver?: (to: number) => void) {
  const ids = ['1'.repeat(32), 'f'.repeat(32)]; // the lower member ID first
  const identities = await Promise.all([createIdentity(), createIdentity()]);
  const links: Link[] = [];
  const got: LinkMessage[][] = [[], []];
  const lanes = [Promise.resolve(), Promise.resolve()];
  const host = (i: number): LinkHost => ({
    me: ids[i],
    locator,
    identity: identities[i],
    peerKey: () => identities[1 - i].publicKey,
    relay: (_peer, payload) => {
      const frame = payload.slice();
      lanes[i] = lanes[i]
        .then(() => new Promise((resolve) => setTimeout(resolve, delay())))
        .then(() => {
          onDeliver?.(1 - i);
          links[1 - i].receive(frame, 'relay');
        });
      return true;
    },
    message: (_peer, message) => got[i].push(message),
    piece: () => {},
    ready: () => {},
    routeChanged: () => {},
  });
  links.push(new Link(host(0), ids[1]), new Link(host(1), ids[0]));
  return { links, got };
}

// Once both sides are done handshaking, a new message each way must get through.
// (A message sent while a handshake settles can be lost; the layers above resend.)
async function settledAndTalking(links: Link[], got: LinkMessage[][]) {
  await expect
    .poll(() => links.every((l) => l.state === 'ready'), { timeout: 3000, interval: 10 })
    .toBe(true);
  await new Promise((resolve) => setTimeout(resolve, 200));
  const before = got.map((g) => g.length);
  links[0].send({ t: 'ack', id: 'from-lower' });
  links[1].send({ t: 'ack', id: 'from-higher' });
  await expect
    .poll(() => got.every((g, i) => g.length > before[i]), { timeout: 3000, interval: 10 })
    .toBe(true);
}

describe('member links', () => {
  it(
    'agree on one key when both members start at the same moment',
    { timeout: 120_000 },
    async () => {
      for (let trial = 0; trial < 40; trial++) {
        const { links, got } = await pair(() => Math.random() * 3);
        const [first, second] = trial % 2 ? [links[0], links[1]] : [links[1], links[0]];
        void first.start();
        void second.start();
        await settledAndTalking(links, got);
        for (const link of links) link.close();
      }
    },
  );

  it('agree on one key when a member starts just as the other’s handshake arrives', async () => {
    // The member coming back starts greeting at the very moment the other member's
    // handshake (started for a waiting message) reaches it.
    let starting = true;
    const { links, got } = await pair(
      () => 1,
      (to) => {
        if (to === 0 && starting) {
          starting = false;
          void links[0].start();
        }
      },
    );
    void links[1].start();
    await settledAndTalking(links, got);
    for (const link of links) link.close();
  });
});

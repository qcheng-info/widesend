import { test, expect } from '@playwright/test';
import { token, roomId, pairingCode } from '../../src/crypto';
import { MAX_RELAY_FRAME, PAIRING_MS, SESSION_MS } from '../../shared/protocol';

test('room endpoints require a same-origin WebSocket upgrade', async ({ request }) => {
  const room = await roomId(token());
  expect(
    (
      await request.get(`/api/rooms/${room}`, { headers: { Origin: 'https://elsewhere.example' } })
    ).status(),
  ).toBe(403);
  expect(
    (
      await request.get(`/api/rooms/${room}`, { headers: { Origin: 'http://localhost:8788' } })
    ).status(),
  ).toBe(426);
  expect((await request.get('/api/missing')).status()).toBe(404);
});

test('pages are sent with the security headers, and browsers are told to stay on HTTPS', async ({
  request,
}) => {
  const headers = (await request.get('/')).headers();
  expect(headers['strict-transport-security']).toBe('max-age=31536000');
  expect(headers['content-security-policy']).toContain("frame-ancestors 'none'");
  expect(headers['x-content-type-options']).toBe('nosniff');
  expect(headers['referrer-policy']).toBe('no-referrer');
});

test('a room pins one receiver, tells a third client the code is used, and survives replacing a socket', async ({
  page,
}) => {
  await page.goto('/');
  const room = await roomId(token());
  const owner = token(32),
    receiver = token(32),
    third = token(32);
  const result = await page.evaluate(
    async ({ room, owner, receiver, third, pairing, session }) => {
      const connect = (role: string, credential: string): Promise<WebSocket> =>
        new Promise((resolve, reject) => {
          const hello = {
            role,
            credential,
            expires: Date.now() + session - 1000,
            pairExpires: Date.now() + pairing - 1000,
          };
          const encoded = btoa(JSON.stringify(hello))
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=+$/, '');
          const ws = new WebSocket(`ws://${location.host}/api/rooms/${room}`, [
            'widesend',
            encoded,
          ]);
          ws.onopen = () => resolve(ws);
          ws.onerror = () => reject(new Error('Rejected'));
        });
      // A used code is accepted and closed at once, so the page learns why.
      const closedWith = (ws: WebSocket) =>
        new Promise<number>((resolve) => {
          ws.onclose = (event) => resolve(event.code);
          setTimeout(() => resolve(0), 3000);
        });
      const host = await connect('send', owner);
      const peer = await connect('receive', receiver);
      const rejected = await connect('receive', third).then(closedWith, () => -1);
      const replacement = await connect('send', owner);
      const received = new Promise<number>((resolve) => {
        peer.onmessage = (event) => {
          if (typeof event.data !== 'string') resolve(event.data.size);
        };
      });
      replacement.send(new Uint8Array(32));
      const length = await received;
      host.close();
      const close = (ws: WebSocket) =>
        new Promise<void>((resolve) => {
          ws.onclose = () => resolve();
          ws.close();
        });
      await Promise.all([close(peer), close(replacement)]);
      const rejectedAfterClose = await connect('receive', third).then(closedWith, () => -1);
      const ownerRejected = await connect('send', third).then(
        (ws) => {
          ws.close();
          return false;
        },
        () => true,
      );
      const restoredReceiver = await connect('receive', receiver);
      const restoredSender = await connect('send', owner);
      const ended = new Promise<number>((resolve) => {
        restoredReceiver.onclose = (event) => resolve(event.code);
      });
      restoredSender.send(JSON.stringify({ type: 'end' }));
      const endCode = await ended;
      const cancelled = await connect('receive', receiver);
      const cancelledCode = await new Promise<number>((resolve) => {
        cancelled.onclose = (event) => resolve(event.code);
      });
      return { rejected, length, rejectedAfterClose, ownerRejected, endCode, cancelledCode };
    },
    { room, owner, receiver, third, pairing: PAIRING_MS, session: SESSION_MS },
  );
  expect(result).toEqual({
    rejected: 4005,
    length: 32,
    rejectedAfterClose: 4005,
    ownerRejected: true,
    endCode: 4004,
    cancelledCode: 4004,
  });
});

test('relay enforces a bounded frame size', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(
    async ({ room, credential, pairing, session }) => {
      const hello = {
        role: 'send',
        credential,
        expires: Date.now() + session - 1000,
        pairExpires: Date.now() + pairing - 1000,
      };
      const auth = btoa(JSON.stringify(hello))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
      const ws = new WebSocket(`ws://${location.host}/api/rooms/${room}`, ['widesend', auth]);
      await new Promise<void>((resolve) => {
        ws.onopen = () => resolve();
      });
      const closed = new Promise<number>((resolve) => {
        ws.onclose = (event) => resolve(event.code);
      });
      ws.send(new Uint8Array(300_000));
      return closed;
    },
    {
      room: await roomId(token()),
      credential: token(32),
      pairing: PAIRING_MS,
      session: SESSION_MS,
    },
  );
  expect(result).toBe(4002);
});

for (const receiverBatch of [true, false]) {
  test(`relay requires both sockets to support larger frames (receiver batching: ${receiverBatch})`, async ({
    page,
  }) => {
    await page.goto('/');
    const result = await page.evaluate(
      async ({ room, owner, receiver, receiverBatch, max, pairing, session }) => {
        const connect = async (role: string, credential: string, relayBatch: boolean) => {
          const encoded = btoa(
            JSON.stringify({
              role,
              credential,
              relayBatch: relayBatch ? 1 : undefined,
              expires: Date.now() + session - 1000,
              pairExpires: Date.now() + pairing - 1000,
            }),
          )
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=+$/, '');
          const ws = new WebSocket(`ws://${location.host}/api/rooms/${room}`, [
            'widesend',
            encoded,
          ]);
          ws.binaryType = 'arraybuffer';
          await new Promise<void>((resolve, reject) => {
            ws.onopen = () => resolve();
            ws.onerror = () => reject(new Error('Rejected'));
          });
          return ws;
        };
        const host = await connect('send', owner, true);
        const peer = await connect('receive', receiver, receiverBatch);
        const closed = new Promise<number>((resolve) => {
          host.onclose = (event) => resolve(event.code);
        });
        let delivered = 0;
        if (receiverBatch) {
          for (let i = 0; i < 12; i++) {
            const received = new Promise<number>((resolve) => {
              peer.onmessage = (event) => {
                if (event.data instanceof ArrayBuffer) resolve(event.data.byteLength);
              };
            });
            host.send(new Uint8Array(max));
            const bytes = await received;
            delivered += bytes;
            // Credits larger than the old frame limit must be accepted; without
            // them, the 4 MiB outstanding guard rejects this stream partway.
            peer.send(JSON.stringify({ type: 'drain', bytes }));
            // Cross-direction ordering: wait for a relayed reply after the credit.
            const reply = new Promise<void>((resolve) => {
              host.onmessage = (event) => {
                if (event.data instanceof ArrayBuffer) resolve();
              };
            });
            peer.send(new Uint8Array(32));
            await reply;
            host.send(JSON.stringify({ type: 'drain', bytes: 32 }));
          }
        }
        host.send(new Uint8Array(receiverBatch ? max + 1 : max));
        const code = await closed;
        peer.close();
        return { code, delivered };
      },
      {
        room: await roomId(token()),
        owner: token(32),
        receiver: token(32),
        receiverBatch,
        max: MAX_RELAY_FRAME,
        pairing: PAIRING_MS,
        session: SESSION_MS,
      },
    );
    expect(result).toEqual({ code: 4002, delivered: receiverBatch ? 12 * MAX_RELAY_FRAME : 0 });
  });
}

test('replacing a peer resets outstanding relay credits for the surviving socket', async ({
  page,
}) => {
  await page.goto('/');
  const delivered = await page.evaluate(
    async ({ room, owner, receiver, max, pairing, session }) => {
      const connect = async (role: string, credential: string) => {
        const auth = btoa(
          JSON.stringify({
            role,
            credential,
            relayBatch: 1,
            expires: Date.now() + session - 1000,
            pairExpires: Date.now() + pairing - 1000,
          }),
        )
          .replace(/\+/g, '-')
          .replace(/\//g, '_')
          .replace(/=+$/, '');
        const ws = new WebSocket(`ws://${location.host}/api/rooms/${room}`, ['widesend', auth]);
        ws.binaryType = 'arraybuffer';
        await new Promise<void>((resolve, reject) => {
          ws.onopen = () => resolve();
          ws.onerror = () => reject(new Error('Rejected'));
        });
        return ws;
      };
      const host = await connect('send', owner);
      let peer = await connect('receive', receiver);
      const closed = new Promise<number>((resolve) => {
        host.onclose = (event) => resolve(-event.code);
      });
      let bytes = 0;
      for (let round = 0; round < 2; round++) {
        if (round) peer = await connect('receive', receiver);
        // Each round fits under 4 MiB, but both together exceed it. The new
        // receiver cannot credit the previous receiver's undrained messages.
        for (let i = 0; i < 6; i++) {
          const incoming = new Promise<number>((resolve) => {
            peer.onmessage = (event) => {
              if (event.data instanceof ArrayBuffer) resolve(event.data.byteLength);
            };
          });
          host.send(new Uint8Array(max));
          const size = await Promise.race([incoming, closed]);
          if (size !== max) throw new Error(`Relay closed during replacement: ${size}`);
          bytes += size;
        }
      }
      peer.close();
      host.close();
      return bytes;
    },
    {
      room: await roomId(token()),
      owner: token(32),
      receiver: token(32),
      max: MAX_RELAY_FRAME,
      pairing: PAIRING_MS,
      session: SESSION_MS,
    },
  );
  expect(delivered).toBe(12 * MAX_RELAY_FRAME);
});

test('reported pairing codes must match the room and cannot replace an existing session', async ({
  page,
}) => {
  await page.goto('/');
  const code = pairingCode();
  const result = await page.evaluate(
    async ({ code, room, owner, receiver, stranger, pairing, session }) => {
      const connect = (role: string, credential: string, code: unknown): Promise<WebSocket> =>
        new Promise((resolve, reject) => {
          const auth = btoa(
            JSON.stringify({
              role,
              credential,
              code,
              expires: Date.now() + session - 1000,
              pairExpires: Date.now() + pairing - 1000,
            }),
          )
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=+$/, '');
          const ws = new WebSocket(`ws://${location.host}/api/rooms/${room}`, ['widesend', auth]);
          ws.onopen = () => resolve(ws);
          ws.onerror = () => reject(new Error('Rejected'));
        });
      const host = await connect('send', owner, code);
      const rejected: boolean[] = [];
      for (const invalid of [
        code.toLowerCase(),
        code.slice(1),
        code + 'X',
        code === 'ABC123' ? 'XYZ987' : 'ABC123',
        123456,
      ]) {
        rejected.push(
          await connect('send', owner, invalid).then(
            (ws) => {
              ws.close();
              return false;
            },
            () => true,
          ),
        );
      }
      rejected.push(
        await connect('send', stranger, code).then(
          (ws) => {
            ws.close();
            return false;
          },
          () => true,
        ),
      );
      const peer = await connect('receive', receiver, code);
      const hostSurvived = host.readyState === WebSocket.OPEN;
      host.close();
      peer.close();
      return { rejected, hostSurvived };
    },
    {
      code,
      room: await roomId(code),
      owner: token(32),
      receiver: token(32),
      stranger: token(32),
      pairing: PAIRING_MS,
      session: SESSION_MS,
    },
  );
  expect(result).toEqual({ rejected: Array(6).fill(true), hostSurvived: true });
});

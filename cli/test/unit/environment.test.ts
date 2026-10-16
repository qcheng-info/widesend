import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, it } from 'vitest';
import { installEnvironment } from '../../src/environment';

it('sends Origin, stands in for page globals, and can turn direct connections off', async () => {
  const server = createServer();
  const upgrade = new Promise<Record<string, string | string[] | undefined>>((resolve) =>
    server.on('upgrade', (request, socket) => {
      resolve(request.headers);
      socket.destroy();
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  expect(await installEnvironment(new URL(origin), true)).toEqual({
    available: false,
    reason: 'turned off with --relay',
  });
  expect(location.origin).toBe(origin);
  expect(document.visibilityState).toBe('visible');
  expect(() => new RTCPeerConnection()).toThrow(/unavailable/);
  const socket = new WebSocket(`${origin.replace('http', 'ws')}/api/rooms/x`, ['widesend', 'abc']);
  socket.onerror = () => {};
  const headers = await upgrade;
  expect(headers.origin).toBe(origin);
  expect(headers['sec-websocket-protocol']).toBe('widesend, abc');
  server.close();
});

it('gives browsers candidates without the SDP a= prefix', async () => {
  expect(await installEnvironment(new URL('https://widesend.example'), false)).toEqual({
    available: true,
  });
  const { RTCIceCandidate } = await import('node-datachannel/polyfill');
  const line = 'candidate:1 1 UDP 2116026367 192.168.1.2 52584 typ host';
  const candidate = new RTCIceCandidate({ candidate: `a=${line}`, sdpMid: '0' });
  expect(candidate.candidate).toBe(line);
  expect(candidate.toJSON().candidate).toBe(line);
});

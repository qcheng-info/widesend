// Node 22's WebSocket fires `error` but never `close` when a connection attempt fails:
// nothing listening, an unknown host, or an HTTP answer instead of an upgrade. Browsers
// and Node 24 fire `close` (1006) after the error, and the transfer and room code retry
// from `close`, so on Node 22 they would wait forever.
const STAND_IN_DELAY = 100;
type StandIn = Event & { standIn?: true };

/** Makes a failed connection end with one `close` event. Call before adding listeners. */
export function closeAfterFailedConnection(socket: WebSocket): void {
  let closed = false;
  socket.addEventListener('close', (event) => {
    // The stand-in already went out; a late real one would be a second close.
    if (closed && !(event as StandIn).standIn) event.stopImmediatePropagation();
    closed = true;
  });
  socket.addEventListener('error', () => {
    setTimeout(() => {
      if (closed) return;
      socket.dispatchEvent(
        Object.assign(new Event('close'), {
          code: 1006,
          reason: '',
          wasClean: false,
          standIn: true,
        }),
      );
    }, STAND_IN_DELAY);
  });
}

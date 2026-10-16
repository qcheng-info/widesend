// Why connections end, for the private activity log. Browsers close their own
// connections with these codes (the server's are 4000–4015) and a short reason.
export const CLIENT_CLOSE = {
  done: 4100, // this page is finished with the room or transfer
  reconnect: 4101, // replacing a connection that seems broken
} as const;

export type ClosedBy = 'server' | 'browser' | 'lost';
export type CloseRecord = { by: ClosedBy; code: number; reason: string };

/**
 * Close reasons are chosen by browsers: keep them short and printable. WebSocket
 * close reasons may not exceed 123 bytes, so this also stays under 120.
 */
export function closeReason(text: string): string {
  const encoder = new TextEncoder();
  let out = '';
  for (const char of [...text.replace(/[\u0000-\u001f\u007f]+/g, ' ')].slice(0, 100)) {
    if (encoder.encode(out + char).length > 120) break;
    out += char;
  }
  return out.trim();
}

/** How a close the server did not start is recorded. */
export function browserClose(code: number, reason: string): CloseRecord {
  const text = closeReason(reason);
  // 1006: no close frame arrived. 1011: the runtime reported a socket error.
  if (code === 1006 || code === 1011)
    return { by: 'lost', code, reason: text || 'Connection lost' };
  // 1005: a close frame without a code, e.g. `WebSocket.close()` with no arguments.
  if (code === 1005) return { by: 'browser', code, reason: text || 'Closed without a code' };
  if (code === 1001)
    return { by: 'browser', code, reason: text || 'Page closed or went to the background' };
  return { by: 'browser', code, reason: text || 'Closed' };
}

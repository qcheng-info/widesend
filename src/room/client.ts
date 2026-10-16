import { RelayDrain } from '../relay-drain';
import {
  CLOSE,
  MAX_PIECE_MESSAGE,
  ROOM_PROTOCOL,
  decodeForward,
  encodeHello,
  type RoomHello,
} from '../../shared/room';
import type { RoomEnvironment, SocketLike } from './environment';
import { CLIENT_CLOSE, closeReason } from '../../shared/diagnostics';

export type Forwarded = { kind: 0 | 1; from: string; payload: Uint8Array };
export type ClientHandlers = {
  text(message: Record<string, unknown>): Promise<void> | void;
  binary(frame: Forwarded): Promise<void> | void;
  // Returns whether the client should reconnect after this close code.
  closed(code: number): boolean;
  connection(online: boolean): void;
};

// One room WebSocket with bounded reconnects. Messages are handled strictly in
// arrival order; relayed frames are drained only after they were processed.
export class RoomClient {
  private ws?: SocketLike;
  private drain?: RelayDrain;
  private queue: Promise<void> = Promise.resolve();
  private retry = 0;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private lastPong = 0;
  private limitedUntil = 0;
  private stopped = false;
  constructor(
    private env: RoomEnvironment,
    private locator: string,
    private hello: RoomHello,
    private handlers: ClientHandlers,
  ) {}
  setHello(hello: RoomHello): void {
    this.hello = hello;
  }
  connected(): void {
    this.retry = 0;
  }
  get bufferedAmount(): number {
    return this.ws?.bufferedAmount ?? 0;
  }
  get open(): boolean {
    return this.ws?.readyState === 1;
  }
  cooldown(seconds: number): void {
    this.limitedUntil = Date.now() + Math.max(1, seconds) * 1000;
  }
  connect(): void {
    if (this.stopped) return;
    const ws = this.env.connect(this.env.socketUrl(this.locator), [
      ROOM_PROTOCOL,
      encodeHello(this.hello),
    ]);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    this.drain?.dispose();
    // Credit is returned every 2 MiB or 250 ms: each drain is a billed message,
    // and the room tolerates 8 MiB of undrained data per member.
    const drain = new RelayDrain(
      (bytes) => {
        if (this.ws === ws && ws.readyState === 1)
          ws.send(JSON.stringify({ type: 'drain', bytes }));
      },
      { threshold: 2 * 1024 * 1024, delay: 250 },
    );
    drain.setLimit(MAX_PIECE_MESSAGE + 17);
    this.drain = drain;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.lastPong = Date.now();
      this.handlers.connection(true);
      clearInterval(this.heartbeat);
      this.heartbeat = setInterval(() => {
        if (this.ws !== ws || ws.readyState !== 1) return;
        if (Date.now() - this.lastPong > 45_000)
          this.detach(ws, 4999, 'No reply from the server for 45 s');
        else ws.send('ping');
      }, 15_000);
    };
    ws.onmessage = (event) => {
      if (this.ws !== ws) return;
      const data = event.data;
      if (typeof data === 'string') {
        if (data === 'pong') {
          this.lastPong = Date.now();
          return;
        }
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(data);
        } catch {
          return;
        }
        // The room announces every close it initiates (see ShareRoom.terminate).
        if (message.type === 'closing' && typeof message.code === 'number') {
          this.detach(ws, message.code);
          return;
        }
        this.queue = this.queue
          .then(() => (this.ws === ws ? this.handlers.text(message) : undefined))
          .catch(() => {});
        return;
      }
      const buffer = data as ArrayBuffer;
      let frame: Forwarded;
      try {
        frame = decodeForward(buffer);
      } catch {
        return;
      }
      this.queue = this.queue
        .then(() => (this.ws === ws ? this.handlers.binary(frame) : undefined))
        .catch(() => {})
        .finally(() => {
          if (this.ws === ws) drain.consumed(buffer.byteLength);
        });
    };
    ws.onerror = () => {
      /* onclose follows. */
    };
    ws.onclose = (event) => this.detach(ws, event.code);
  }
  // Workerd may not finish a closing handshake promptly, so once this client knows
  // a connection is over it acts at once and ignores the socket's late close event.
  // `reason` is set when this side ends the connection; the room records it.
  private detach(ws: SocketLike, code: number, reason?: string): void {
    if (this.ws !== ws) return;
    this.ws = undefined;
    clearInterval(this.heartbeat);
    this.drain?.dispose();
    this.handlers.connection(false);
    try {
      if (reason) ws.close(CLIENT_CLOSE.reconnect, closeReason(reason));
      else ws.close(1000);
    } catch {
      /* Already closed. */
    }
    this.queue = this.queue.then(() => {
      if (this.stopped) return;
      if (code === CLOSE.limited && this.limitedUntil <= Date.now()) this.cooldown(60);
      if (this.handlers.closed(code)) this.schedule();
    });
  }
  private schedule(): void {
    if (this.stopped) return;
    clearTimeout(this.reconnectTimer);
    const cooldown = Math.max(0, this.limitedUntil - Date.now());
    this.reconnectTimer = setTimeout(
      () => this.connect(),
      Math.max(cooldown, Math.min(5000, 300 * 2 ** this.retry++)) + Math.random() * 200,
    );
  }
  send(value: unknown): boolean {
    if (this.ws?.readyState !== 1) return false;
    this.ws.send(JSON.stringify(value));
    return true;
  }
  sendBinary(bytes: Uint8Array): boolean {
    if (this.ws?.readyState !== 1) return false;
    this.ws.send(bytes);
    return true;
  }
  // Closes the current socket; the close handler decides whether to reconnect.
  reconnect(reason = 'Reconnecting'): void {
    if (this.ws) this.detach(this.ws, 4999, reason);
  }
  stop(reason = 'Closed'): void {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    clearInterval(this.heartbeat);
    this.drain?.dispose();
    const ws = this.ws;
    this.ws = undefined;
    ws?.close(CLIENT_CLOSE.done, closeReason(reason));
  }
}

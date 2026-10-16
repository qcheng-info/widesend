const context = new TextEncoder().encode('unit-test-session');
import { afterEach, expect, it, vi } from 'vitest';
import { CHUNK_SIZE, MAX_FRAME, MAX_RELAY_FRAME, RELAY_BATCH_SIZE } from '../../shared/protocol';
import { Cipher } from '../../src/crypto';
import { RelayDrain } from '../../src/relay-drain';
import { Transfer } from '../../src/transfer';

afterEach(() => vi.useRealTimers());

it('authenticates a full relay batch, its offset above 4 GiB, and its final byte', async () => {
  const secret = crypto.getRandomValues(new Uint8Array(16));
  const sender = await Cipher.create(secret, 'send', context);
  const receiver = await Cipher.create(secret, 'receive', context);
  const data = new Uint8Array(RELAY_BATCH_SIZE).fill(71);
  const offset = 5 * 1024 ** 3;
  const encrypted = await sender.chunk(3, offset, data.buffer, true);
  expect(encrypted.byteLength).toBe(MAX_RELAY_FRAME);
  const plain = await receiver.open(encrypted);
  expect(plain[0]).toBe(2);
  expect(new DataView(plain.buffer).getUint32(1)).toBe(3);
  expect(new DataView(plain.buffer).getFloat64(5)).toBe(offset);
  expect(plain.slice(13)).toEqual(data);
  new Uint8Array(encrypted)[encrypted.byteLength - 1] ^= 1;
  await expect(receiver.open(encrypted)).rejects.toThrow();
});

it('coalesces credits without exceeding legacy limits and flushes a quiet tail', () => {
  vi.useFakeTimers();
  const send = vi.fn();
  const drain = new RelayDrain(send);
  for (let i = 0; i < 17; i++) drain.consumed(CHUNK_SIZE + 41);
  expect(send).toHaveBeenCalledTimes(2);
  expect(send.mock.calls.every(([bytes]) => bytes <= MAX_FRAME)).toBe(true);
  vi.advanceTimersByTime(50);
  expect(send.mock.calls.flat().reduce((a, b) => a + b, 0)).toBe(17 * (CHUNK_SIZE + 41));
  expect(vi.getTimerCount()).toBe(0);
});

it('returns full batch credit promptly but combines small replies', () => {
  vi.useFakeTimers();
  const send = vi.fn();
  const drain = new RelayDrain(send);
  drain.setLimit(MAX_RELAY_FRAME);
  drain.consumed(MAX_RELAY_FRAME);
  expect(send).toHaveBeenLastCalledWith(MAX_RELAY_FRAME);
  for (let i = 0; i < 10; i++) drain.consumed(80);
  expect(send).toHaveBeenCalledOnce();
  vi.advanceTimersByTime(50);
  expect(send).toHaveBeenLastCalledWith(800);
});

it('never returns old socket credits after reconnect or cancellation', () => {
  vi.useFakeTimers();
  const send = vi.fn();
  const drain = new RelayDrain(send);
  drain.consumed(100);
  drain.dispose();
  drain.consumed(200);
  vi.runAllTimers();
  expect(send).not.toHaveBeenCalled();
});

it('discards buffered credits when the other peer is replaced on the same socket', () => {
  vi.useFakeTimers();
  const send = vi.fn();
  const drain = new RelayDrain(send);
  drain.consumed(100);
  drain.reset();
  drain.consumed(200);
  vi.advanceTimersByTime(50);
  expect(send).toHaveBeenCalledExactlyOnceWith(200);
});

function receiving(size = 2 * RELAY_BATCH_SIZE) {
  const transfer = new Transfer('receive', 'AB1234', () => {}) as any;
  transfer.snapshot.files = [{ id: 0, name: 'batch.bin', size, type: '' }];
  transfer.snapshot.total = size;
  transfer.snapshot.phase = 'transferring';
  transfer.snapshot.route = 'relay';
  transfer.accepted = true;
  transfer.relayBatchAvailable = true;
  transfer.destination = { write: vi.fn(async () => {}), flush: vi.fn(async () => {}) };
  transfer.recovery = { save: vi.fn(async () => {}) };
  transfer.audit = { report: vi.fn() };
  transfer.control = vi.fn(async () => {});
  // No actual socket is opened by these disk/offset tests.
  return { transfer, socket: Object.create(WebSocket.prototype) as WebSocket };
}
function batch(offset = 0, length = RELAY_BATCH_SIZE) {
  const plain = new Uint8Array(13 + length);
  plain[0] = 2;
  new DataView(plain.buffer).setFloat64(5, offset);
  return plain;
}

it('resumes inside a replayed batch without rewriting saved bytes and acknowledges once', async () => {
  const { transfer, socket } = receiving();
  transfer.receiverOffset = 3 * CHUNK_SIZE;
  await transfer.handleChunk(batch(), socket);
  expect(transfer.destination.write).toHaveBeenCalledTimes(13);
  expect(transfer.destination.write.mock.calls[0][0]).toBe(3 * CHUNK_SIZE);
  expect(
    transfer.destination.write.mock.calls.every(
      ([, data]: [number, ArrayBuffer]) => data.byteLength === CHUNK_SIZE,
    ),
  ).toBe(true);
  expect(transfer.receiverOffset).toBe(RELAY_BATCH_SIZE);
  expect(transfer.control).toHaveBeenCalledExactlyOnceWith(
    { type: 'ack', file: 0, offset: RELAY_BATCH_SIZE },
    socket,
  );
});

it('counts bytes after the disk worker takes ownership of each write buffer', async () => {
  const { transfer, socket } = receiving();
  transfer.destination.write.mockImplementation(async (_offset: number, bytes: ArrayBuffer) => {
    structuredClone(bytes, { transfer: [bytes] });
  });
  await transfer.handleChunk(batch(), socket);
  expect(transfer.receiverOffset).toBe(RELAY_BATCH_SIZE);
  expect(transfer.control).toHaveBeenCalledExactlyOnceWith(
    { type: 'ack', file: 0, offset: RELAY_BATCH_SIZE },
    socket,
  );
});

it('stops a batch at a reconnect while preserving the completed disk checkpoint', async () => {
  const { transfer, socket } = receiving(4 * RELAY_BATCH_SIZE);
  const offset = 2 * RELAY_BATCH_SIZE - CHUNK_SIZE;
  transfer.receiverOffset = offset;
  let finish!: () => void;
  transfer.destination.write.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const work = transfer.handleChunk(batch(offset), socket);
  transfer.resetDirect();
  finish();
  await work;
  expect(transfer.destination.write).toHaveBeenCalledOnce();
  expect(transfer.recovery.save).toHaveBeenCalledWith({
    fileIndex: 0,
    offset: 2 * RELAY_BATCH_SIZE,
  });
  expect(transfer.control).not.toHaveBeenCalled();
});

it('writes an unaligned final tail and rejects malformed batches before any write', async () => {
  const tail = CHUNK_SIZE + 17;
  const { transfer, socket } = receiving(tail);
  await transfer.handleChunk(batch(0, tail), socket);
  expect(
    transfer.destination.write.mock.calls.map(
      ([, bytes]: [number, ArrayBuffer]) => bytes.byteLength,
    ),
  ).toEqual([CHUNK_SIZE, 17]);
  expect(transfer.control).toHaveBeenCalledExactlyOnceWith(
    { type: 'ack', file: 0, offset: tail },
    socket,
  );
  for (const [offset, size] of [
    [1, CHUNK_SIZE],
    [0, RELAY_BATCH_SIZE + CHUNK_SIZE],
    [0, CHUNK_SIZE + 1],
    [0, 0],
  ]) {
    const receiver = receiving();
    await expect(
      receiver.transfer.handleChunk(batch(offset, size), receiver.socket),
    ).rejects.toThrow('Invalid file chunk');
    expect(receiver.transfer.destination.write).not.toHaveBeenCalled();
  }
  const receiver = receiving();
  await expect(receiver.transfer.handleChunk(batch(), {})).rejects.toThrow('Invalid file chunk');
  receiver.transfer.relayBatchAvailable = false;
  await expect(receiver.transfer.handleChunk(batch(), receiver.socket)).rejects.toThrow(
    'Invalid file chunk',
  );
});

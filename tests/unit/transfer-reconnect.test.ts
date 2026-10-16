import { expect, it, vi } from 'vitest';
import { Transfer } from '../../src/transfer';
import { CHUNK_SIZE } from '../../shared/protocol';
import { CLIENT_CLOSE } from '../../shared/diagnostics';

it('keeps a pending disk write across reconnect without acknowledging it on the replacement connection', async () => {
  // The sender may restart while the receiver is still waiting for a disk write.
  // Its new connection must learn the offset from ready, before receiving ACKs.
  const transfer = new Transfer('receive', 'A1B2C3', () => {}) as any;
  const offset = 1024 * 1024 - CHUNK_SIZE;
  transfer.snapshot.files = [{ id: 0, name: 'pending.bin', size: 2 * 1024 * 1024, type: '' }];
  transfer.snapshot.total = 2 * 1024 * 1024;
  transfer.snapshot.phase = 'transferring';
  transfer.snapshot.route = 'direct';
  transfer.accepted = true;
  transfer.receiverOffset = offset;
  let finishWrite!: () => void;
  transfer.destination = {
    write: vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishWrite = resolve;
        }),
    ),
    flush: vi.fn(async () => {}),
  };
  transfer.recovery = { save: vi.fn(async () => {}) };
  transfer.audit = { report: vi.fn() };
  transfer.control = vi.fn(async () => {});
  const plain = new Uint8Array(CHUNK_SIZE + 13);
  plain[0] = 1;
  new DataView(plain.buffer).setFloat64(5, offset);
  const processing = transfer.handleChunk(plain, {});
  expect(transfer.destination.write).toHaveBeenCalledOnce();
  transfer.resetDirect();
  finishWrite();
  await processing;
  expect(transfer.receiverOffset).toBe(1024 * 1024);
  expect(transfer.destination.flush).toHaveBeenCalledOnce();
  expect(transfer.recovery.save).toHaveBeenCalledWith({ fileIndex: 0, offset: 1024 * 1024 });
  expect(transfer.control).not.toHaveBeenCalled();
});

it('tells the server why it replaces or closes a connection', () => {
  vi.stubGlobal('document', { removeEventListener: vi.fn() });
  vi.stubGlobal('window', { removeEventListener: vi.fn() });
  try {
    const transfer = new Transfer('send', 'A1B2C3', () => {}) as any;
    transfer.scheduleReconnect = vi.fn();
    const first = { close: vi.fn(), readyState: 1 };
    transfer.ws = first;
    transfer.replaceConnection('Network changed');
    expect(first.close).toHaveBeenCalledWith(CLIENT_CLOSE.reconnect, 'Network changed');
    const second = { close: vi.fn(), readyState: 1 };
    transfer.ws = second;
    transfer.stop('Transfer cancelled.');
    expect(second.close).toHaveBeenCalledWith(CLIENT_CLOSE.done, 'Transfer cancelled.');
  } finally {
    vi.unstubAllGlobals();
  }
});

import { expect, it } from 'vitest';
import { closeAfterFailedConnection } from '../../shared/socket-close';

// A socket stand-in: the helper only needs events.
function socket() {
  const target = new EventTarget() as unknown as WebSocket;
  closeAfterFailedConnection(target);
  const closes: number[] = [];
  target.addEventListener('close', (event) => closes.push((event as CloseEvent).code));
  return { target, closes };
}
const close = (code: number) => Object.assign(new Event('close'), { code, wasClean: false });
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

it('closes a socket whose connection attempt failed without a close event (Node 22)', async () => {
  const { target, closes } = socket();
  target.dispatchEvent(new Event('error'));
  await wait(300);
  expect(closes).toEqual([1006]);
});

it('adds nothing when the close event follows the error, as in browsers', async () => {
  const { target, closes } = socket();
  target.dispatchEvent(new Event('error'));
  target.dispatchEvent(close(1006));
  await wait(300);
  expect(closes).toEqual([1006]);
});

it('lets only one close through when the real one comes after the stand-in', async () => {
  const { target, closes } = socket();
  target.dispatchEvent(new Event('error'));
  await wait(300);
  target.dispatchEvent(close(1006));
  expect(closes).toEqual([1006]);
});

it('leaves an open socket alone', async () => {
  const { target, closes } = socket();
  target.dispatchEvent(close(1000));
  target.dispatchEvent(new Event('error'));
  await wait(300);
  expect(closes).toEqual([1000]);
});

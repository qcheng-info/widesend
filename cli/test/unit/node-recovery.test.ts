import { expect, it } from 'vitest';
import { RecoverySession, progressDiscarded } from '../../src/node-recovery';

it('keeps the record in memory and announces when it is discarded', async () => {
  expect(await RecoverySession.restore()).toBeUndefined();
  const session = await RecoverySession.create({
    version: 2,
    id: 'x',
    role: 'send',
    code: 'A1B2C3',
    expires: 1,
    pairExpires: 1,
    updated: 0,
    files: [],
    accepted: false,
    fileIndex: 0,
    offset: 0,
    completed: [],
  });
  await session.save({ accepted: true, offset: 32768 });
  expect(session.record).toMatchObject({ accepted: true, offset: 32768, code: 'A1B2C3' });
  let discarded = false;
  void progressDiscarded.then(() => (discarded = true));
  await session.remove();
  await session.unlock();
  await Promise.resolve();
  expect(discarded).toBe(true);
});

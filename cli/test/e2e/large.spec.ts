import { expect, test } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { CLI, RESULTS, cli, codeOf, folder, randomFile, sha256File } from './fixtures';

// Opt-in: WIDESEND_LARGE=1. 512 MiB + 123 bytes each way, with peak memory checked.
test.beforeEach(({ browserName }) => {
  test.skip(browserName !== 'chromium', 'CLI only');
  test.skip(!process.env.WIDESEND_LARGE, 'Set WIDESEND_LARGE=1 to run');
});
test.beforeAll(() => mkdir(RESULTS, { recursive: true }));
const time = process.platform === 'darwin' ? ['/usr/bin/time', '-l'] : ['/usr/bin/time', '-v'];
const peakMiB = (output: string) => {
  const mac = /(\d+)\s+maximum resident set size/.exec(output);
  const linux = /Maximum resident set size \(kbytes\): (\d+)/.exec(output);
  return mac ? Number(mac[1]) / 2 ** 20 : Number(linux![1]) / 1024;
};

for (const relay of [false, true])
  test(`512 MiB over ${relay ? 'the relay' : 'a direct connection'} with bounded memory`, async () => {
    test.setTimeout(900_000);
    const from = await folder('large-send');
    const to = await folder('large-receive');
    const path = await randomFile(from, 'large.bin', 512 * 1024 * 1024 + 123);
    const flags = relay ? ['--relay'] : [];
    const command = [...time, process.execPath, CLI];
    const started = Date.now();
    const sender = cli(['send', path, ...flags], { command });
    const receiver = cli(['receive', await codeOf(sender), '-y', '-o', to, ...flags], { command });
    expect(await receiver.exited, receiver.output()).toBe(0);
    expect(await sender.exited, sender.output()).toBe(0);
    const seconds = (Date.now() - started) / 1000;
    expect(await sha256File(join(to, 'large.bin'))).toBe(await sha256File(path));
    for (const run of [sender, receiver]) expect(peakMiB(run.output())).toBeLessThan(400);
    const description = `${relay ? 'relay' : 'direct'}: ${seconds.toFixed(1)} s, peak MiB sender ${peakMiB(sender.output()).toFixed(0)}, receiver ${peakMiB(receiver.output()).toFixed(0)}`;
    test.info().annotations.push({ type: 'large', description });
    console.log(`  ↳ ${description}`);
  });

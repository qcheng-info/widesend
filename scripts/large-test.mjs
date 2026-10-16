import { run, local } from './run.mjs';
process.env.WIDESEND_LARGE_TEST = '1';
try {
  await run('npm', ['run', 'build']);
  // Relay frames are encrypted and incompressible. Recording them adds many GiB
  // of test artifacts and can exhaust the disk independently of the transfer.
  await run(local('playwright'), [
    'test',
    '--trace',
    'off',
    '-g',
    'large-file transfer resumes',
    ...process.argv.slice(2),
  ]);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

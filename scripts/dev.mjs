import { run, local } from './run.mjs';
try {
  await run('npm', ['run', 'build']);
  console.log(
    '\nWideSend will be available at http://localhost:8787. Restart after frontend edits.\n',
  );
  await run(local('wrangler'), ['dev', '--port', '8787', ...process.argv.slice(2)]);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

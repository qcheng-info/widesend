import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
export const root = fileURLToPath(new URL('../', import.meta.url));
export function run(command, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    const stop = () => child.kill('SIGTERM');
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    child.once('error', reject);
    child.once('exit', (code) => {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with code ${code ?? 'signal'}`));
    });
  });
}
export function local(name) {
  return fileURLToPath(
    new URL(
      `../node_modules/.bin/${name}${process.platform === 'win32' ? '.cmd' : ''}`,
      import.meta.url,
    ),
  );
}
/**
 * Runs a command, showing its output as it comes (unless quiet), and returns what it
 * printed to standard output; warnings on standard error never mix into results such as
 * JSON. A failure carries both streams in `output`.
 */
export function capture(command, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      // Quiet commands never read the terminal, so they can't take a person's keystrokes.
      stdio: [
        options.input !== undefined ? 'pipe' : options.quiet ? 'ignore' : 'inherit',
        'pipe',
        'pipe',
      ],
      env: { ...process.env, ...options.env },
      shell: process.platform === 'win32',
    });
    let stdout = '';
    let both = '';
    const quiet = options.quiet === true;
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      both += chunk;
      if (!quiet) process.stdout.write(chunk);
    });
    child.stderr.on('data', (chunk) => {
      both += chunk;
      if (!quiet) process.stderr.write(chunk);
    });
    if (options.input !== undefined) child.stdin.end(options.input);
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve(stdout);
      else
        reject(
          Object.assign(new Error(`${command} exited with code ${code ?? 'signal'}`), {
            output: both,
          }),
        );
    });
  });
}

/** Reads a .env file in `dir` (Cloudflare settings), keeping values already set. */
export function loadEnvironment(dir = root) {
  try {
    process.loadEnvFile(join(dir, '.env'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

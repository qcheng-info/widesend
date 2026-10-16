import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, open, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BASE = 'http://localhost:8788';
export const CLI = fileURLToPath(new URL('../../dist/widesend.mjs', import.meta.url));
export const RESULTS = fileURLToPath(new URL('../../../test-results/cli', import.meta.url));

export type Cli = {
  process: ChildProcess;
  output: () => string;
  waitFor: (pattern: RegExp, timeout?: number) => Promise<RegExpMatchArray>;
  exited: Promise<number>;
};
/** Collects a CLI process's output so tests can wait for lines and its exit code. */
export function watch(child: ChildProcess, defaultTimeout = 60_000): Cli {
  let text = '';
  const waiters = new Set<() => void>();
  for (const stream of [child.stdout!, child.stderr!])
    stream.on('data', (chunk) => {
      text += chunk;
      for (const check of waiters) check();
    });
  const exited = new Promise<number>((resolve) =>
    child.on('exit', (code, signal) => resolve(code ?? (signal ? 128 : 1))),
  );
  return {
    process: child,
    output: () => text,
    exited,
    waitFor: (pattern, timeout = defaultTimeout) =>
      new Promise((resolve, reject) => {
        const check = () => {
          const match = pattern.exec(text);
          if (!match) return;
          waiters.delete(check);
          clearTimeout(timer);
          resolve(match);
        };
        const timer = setTimeout(() => {
          waiters.delete(check);
          reject(new Error(`Timed out waiting for ${pattern}. Output:\n${text}`));
        }, timeout);
        waiters.add(check);
        check();
      }),
  };
}
/** Runs the built CLI without a terminal, like a script or `nohup` would. */
export function cli(
  args: string[],
  options: { cwd?: string; server?: string; command?: string[] } = {},
): Cli {
  const command = options.command ?? [process.execPath, CLI];
  const child = spawn(
    command[0],
    [...command.slice(1), ...args, '--server', options.server ?? BASE],
    {
      cwd: options.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      // The first-run notice remembers servers here, not in this machine's ~/.config.
      env: { ...process.env, XDG_CONFIG_HOME: join(RESULTS, 'config') },
    },
  );
  return watch(child);
}
export const codeOf = async (run: Cli) => (await run.waitFor(/Code\s+([A-Z0-9]{6})/))[1];
export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
export const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');
/** Writes `bytes` of random data in 1 MiB pieces and returns its path. */
export async function randomFile(dir: string, name: string, bytes: number): Promise<string> {
  const path = join(dir, name);
  const handle = await open(path, 'w');
  for (let done = 0; done < bytes; done += 1024 * 1024)
    await handle.write(randomBytes(Math.min(1024 * 1024, bytes - done)));
  await handle.close();
  return path;
}
export const folder = (prefix: string) => mkdtemp(join(RESULTS, `${prefix}-`));
/** Bytes in the unfinished `.part` file a CLI receiver is writing in `dir`, or 0. */
export async function partSize(dir: string): Promise<number> {
  const part = (await readdir(dir)).find((name) => name.endsWith('.part'));
  return part ? (await stat(join(dir, part)).catch(() => ({ size: 0 }))).size : 0;
}

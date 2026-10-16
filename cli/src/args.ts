import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { UsageError } from './errors';
import { DEFAULT_SERVER, parseTarget, serverOrigin } from './link';
import { MAX_RECEIVERS } from '../../shared/protocol';

export type Command =
  | { kind: 'help'; requested: boolean }
  | { kind: 'version' }
  | { kind: 'send'; paths: string[]; server: URL; relay: boolean; uses: number }
  | { kind: 'receive'; code: string; server: URL; relay: boolean; output: string; yes: boolean };

export const HELP = `WideSend sends files with a six-character code.

Usage:
  widesend send <file>... [options]
  widesend receive <code|link> [options]

Options:
  -o, --output <folder>  Where received files go (default: the current folder)
  -y, --yes              Receive without asking first
  -n, --uses <n>         How many times the code can be used (1 to ${MAX_RECEIVERS}, default 1)
      --relay            Skip the direct connection and use the encrypted relay
      --server <url>     WideSend server (default: ${DEFAULT_SERVER}, or $WIDESEND_SERVER)
  -h, --help             Show this help
  -v, --version          Show the version

The other person can receive in a browser at the printed link, or with
  widesend receive <code>`;

export function parseCommand(
  argv: string[],
  env: Record<string, string | undefined>,
  cwd: string,
): Command {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        output: { type: 'string', short: 'o' },
        yes: { type: 'boolean', short: 'y' },
        relay: { type: 'boolean' },
        uses: { type: 'string', short: 'n' },
        server: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
    });
  } catch (error) {
    const option = /'(-[^' ]+)/.exec((error as Error).message)?.[1];
    throw new UsageError(
      (error as { code?: string }).code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION' && option
        ? `Unknown option ${option}.`
        : (error as Error).message,
    );
  }
  const { values, positionals } = parsed;
  if (values.version) return { kind: 'version' };
  const [command, ...rest] = positionals;
  if (values.help || !command) return { kind: 'help', requested: !!values.help };
  const server = serverOrigin(values.server ?? env.WIDESEND_SERVER ?? DEFAULT_SERVER);
  const relay = !!values.relay;
  if (command === 'send') {
    if (values.output !== undefined || values.yes)
      throw new UsageError('-o and -y are options of widesend receive.');
    if (!rest.length) throw new UsageError('Name at least one file to send.');
    const uses = values.uses === undefined ? 1 : Number(values.uses);
    if (
      !/^\d+$/.test(values.uses ?? '1') ||
      !Number.isSafeInteger(uses) ||
      uses < 1 ||
      uses > MAX_RECEIVERS
    )
      throw new UsageError(`--uses takes a number from 1 to ${MAX_RECEIVERS}.`);
    return { kind: 'send', paths: rest, server, relay, uses };
  }
  if (command === 'receive') {
    if (values.uses !== undefined) throw new UsageError('--uses is an option of widesend send.');
    if (rest.length !== 1)
      throw new UsageError(rest.length ? 'Give one code or link.' : 'Give the code or link.');
    const target = parseTarget(rest[0], server);
    return {
      kind: 'receive',
      code: target.code,
      server: target.server,
      relay,
      output: resolve(cwd, values.output ?? '.'),
      yes: !!values.yes,
    };
  }
  throw new UsageError(`Unknown command ${command}. Use send or receive.`);
}

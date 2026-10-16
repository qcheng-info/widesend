import { HELP, parseCommand } from './args';
import { installEnvironment } from './environment';
import { UsageError } from './errors';
import { openFiles } from './files';
import { checkFolder } from './node-storage';
import { serverNotice } from './notice';
import { prepareServer } from './server';
import { aboutSite } from '../../src/site';
import { sendMany } from './many';
import { receive, send } from './run';
import { Screen } from './ui';

declare const __VERSION__: string;

async function main(screen: Screen): Promise<number> {
  try {
    const command = parseCommand(process.argv.slice(2), process.env, process.cwd());
    if (command.kind === 'version') {
      screen.say(__VERSION__);
      return 0;
    }
    if (command.kind === 'help') {
      if (command.requested) screen.say(HELP);
      else screen.warn(HELP);
      return command.requested ? 0 : 2;
    }
    if (command.kind === 'send') {
      const files = await openFiles(command.paths);
      const direct = await installEnvironment(command.server, command.relay);
      await prepareServer(command.server);
      serverNotice(command.server, aboutSite(), screen);
      const options = { screen, server: command.server, direct };
      return command.uses > 1
        ? await sendMany(files, command.uses, options)
        : await send(files, options);
    }
    await checkFolder(command.output).catch((error) => {
      throw new UsageError((error as Error).message);
    });
    if (!command.yes && !process.stdin.isTTY)
      throw new UsageError('Add -y to receive without a terminal to answer in.');
    const direct = await installEnvironment(command.server, command.relay);
    await prepareServer(command.server);
    serverNotice(command.server, aboutSite(), screen);
    return await receive(command.code, command.output, command.yes, {
      screen,
      server: command.server,
      direct,
    });
  } catch (error) {
    screen.warn(`widesend: ${(error as Error).message}`);
    return error instanceof UsageError ? 2 : 1;
  }
}

const code = await main(new Screen());
// Piped output on macOS is written asynchronously; let it drain before exiting.
await new Promise((resolve) => process.stdout.write('', resolve));
await new Promise((resolve) => process.stderr.write('', resolve));
// Exit explicitly: native WebRTC threads would otherwise keep the process alive.
process.exit(code);

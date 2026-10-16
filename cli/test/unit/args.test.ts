import { describe, expect, it } from 'vitest';
import { parseCommand } from '../../src/args';
import { UsageError } from '../../src/errors';

const parse = (argv: string[], env: Record<string, string> = {}) =>
  parseCommand(argv, env, '/home/me');
describe('parseCommand', () => {
  it('parses send with the default server', () => {
    expect(parse(['send', 'a.txt', 'b.txt'])).toEqual({
      kind: 'send',
      paths: ['a.txt', 'b.txt'],
      server: new URL('https://r.widesend.app'),
      relay: false,
      uses: 1,
    });
  });
  it('lets a send be used several times', () => {
    expect(parse(['send', 'a.txt', '--uses', '3'])).toMatchObject({ uses: 3 });
    expect(parse(['send', 'a.txt', '-n', '2'])).toMatchObject({ uses: 2 });
    expect(parse(['send', 'a.txt', '--uses=10'])).toMatchObject({ uses: 10 });
    for (const value of ['0', '11', '2.5', 'x', '-1', ''])
      expect(() => parse(['send', 'a', `--uses=${value}`]), value).toThrow(
        '--uses takes a number from 1 to 10.',
      );
    expect(() => parse(['receive', 'A1B2C3', '--uses', '2'])).toThrow(
      '--uses is an option of widesend send.',
    );
  });
  it('parses receive options and resolves the folder', () => {
    expect(parse(['receive', 'a1b2c3', '-o', 'in', '-y', '--relay'])).toEqual({
      kind: 'receive',
      code: 'A1B2C3',
      server: new URL('https://r.widesend.app'),
      relay: true,
      output: '/home/me/in',
      yes: true,
    });
  });
  it('uses --server over WIDESEND_SERVER over the default', () => {
    const env = { WIDESEND_SERVER: 'https://env.example.com' };
    expect(parse(['send', 'a'], env)).toMatchObject({ server: new URL('https://env.example.com') });
    expect(parse(['send', 'a', '--server', 'flag.example.com'], env)).toMatchObject({
      server: new URL('https://flag.example.com'),
    });
  });
  it('answers help and version', () => {
    expect(parse(['--version'])).toEqual({ kind: 'version' });
    expect(parse(['--help'])).toEqual({ kind: 'help', requested: true });
    expect(parse([])).toEqual({ kind: 'help', requested: false });
  });
  it('rejects misuse with a UsageError', () => {
    for (const argv of [
      ['send'],
      ['send', 'a', '-y'],
      ['receive'],
      ['receive', 'A1B2C3', 'B1C2D3'],
      ['fetch', 'x'],
      ['send', 'a', '--bogus'],
      ['send', 'a', '--server'],
    ])
      expect(() => parse(argv), argv.join(' ')).toThrow(UsageError);
  });
});

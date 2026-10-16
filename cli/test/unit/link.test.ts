import { describe, expect, it } from 'vitest';
import { UsageError } from '../../src/errors';
import { DEFAULT_SERVER, parseTarget, serverOrigin } from '../../src/link';

const server = new URL(DEFAULT_SERVER);
describe('serverOrigin', () => {
  it('keeps only the origin and adds https when missing', () => {
    expect(serverOrigin('https://widesend.example.com/some/path?x=1').href).toBe(
      'https://widesend.example.com/',
    );
    expect(serverOrigin('widesend.example.com').origin).toBe('https://widesend.example.com');
    expect(serverOrigin('http://localhost:8788').origin).toBe('http://localhost:8788');
  });
  it('refuses other schemes and nonsense', () => {
    expect(() => serverOrigin('ftp://example.com')).toThrow(UsageError);
    expect(() => serverOrigin('http://')).toThrow(UsageError);
  });
});
describe('parseTarget', () => {
  it('accepts codes in any case, with spaces or dashes', () => {
    expect(parseTarget('a1b2c3', server)).toEqual({ server, code: 'A1B2C3' });
    expect(parseTarget(' A1B-2C3 ', server).code).toBe('A1B2C3');
    expect(parseTarget('#a1b2c3', server).code).toBe('A1B2C3');
  });
  it('takes the server from a link', () => {
    const target = parseTarget('https://send.example.org/#a1b2c3', server);
    expect(target.server.origin).toBe('https://send.example.org');
    expect(target.code).toBe('A1B2C3');
    expect(parseTarget('send.example.org/#A1B2C3', server).server.origin).toBe(
      'https://send.example.org',
    );
  });
  it('refuses room links and bad codes', () => {
    expect(() => parseTarget('https://old.example.com/#room=A1B2C3', server)).toThrow(/room link/);
    expect(() => parseTarget('A1B2C', server)).toThrow(/6 letters and digits/);
    expect(() => parseTarget('https://old.example.com/', server)).toThrow(/no code/);
  });
});

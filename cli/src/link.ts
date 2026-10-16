import { parseCode } from '../../src/crypto';
import { siteName } from '../../src/site';
import { UsageError } from './errors';

export const DEFAULT_SERVER = 'https://r.widesend.app';

/** The link to receive with, on the deployment's site. */
export const shareLink = (code: string) => `${siteName()}/#${code}`;
const scheme = /^[a-z][a-z0-9+.-]*:\/\//i;

/** The deployment to talk to, reduced to its origin; `host.example` means https. */
export function serverOrigin(value: string): URL {
  const text = value.trim();
  let url: URL;
  try {
    url = new URL(scheme.test(text) ? text : `https://${text}`);
  } catch {
    throw new UsageError(`${value} is not a server address.`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    throw new UsageError(`${value} is not an http or https address.`);
  return new URL(url.origin);
}

/** A code (`a1b2c3`) or a shared link (`https://host/#A1B2C3`), which brings its own server. */
export function parseTarget(input: string, server: URL): { server: URL; code: string } {
  const text = input.trim();
  if (/#room=/i.test(text))
    throw new UsageError(
      'That is a room link. The command line sends one-to-one only; open rooms in a browser.',
    );
  if (scheme.test(text) || text.includes('/#')) {
    const hash = text.includes('#') ? text.slice(text.indexOf('#')) : '';
    if (hash.length < 2) throw new UsageError(`${input} has no code after #.`);
    return { server: serverOrigin(text.slice(0, text.indexOf('#'))), code: code(hash) };
  }
  return { server, code: code(text) };
}
function code(text: string): string {
  try {
    return parseCode(text.replace(/[\s-]/g, ''));
  } catch {
    throw new UsageError('A code has 6 letters and digits, like A1B2C3.');
  }
}

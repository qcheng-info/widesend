// Dashboard sign-in with a password (the ADMIN_PASSWORD secret), for sites without
// Cloudflare Access. A session is a signed expiry time in an HttpOnly cookie; the key
// comes from the password, so changing the password ends every session.
export const SESSION_COOKIE = 'widesend_admin';
export const SESSION_SECONDS = 12 * 60 * 60;
export const MIN_PASSWORD = 12;

const encoder = new TextEncoder();
const hex = (bytes: ArrayBuffer) =>
  Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
const digest = (text: string) => crypto.subtle.digest('SHA-256', encoder.encode(text));

/** The configured password, or null when there is none or it is too short to rely on. */
export function adminPassword(env: { ADMIN_PASSWORD?: string }): string | null {
  const password = env.ADMIN_PASSWORD ?? '';
  return password.length >= MIN_PASSWORD ? password : null;
}

// Compares digests, so the time taken says nothing about how much of a guess was right.
function sameBytes(x: Uint8Array, y: Uint8Array): boolean {
  let difference = x.length ^ y.length;
  for (let i = 0; i < Math.min(x.length, y.length); i++) difference |= x[i] ^ y[i];
  return difference === 0;
}
export async function passwordMatches(input: string, password: string): Promise<boolean> {
  return sameBytes(new Uint8Array(await digest(input)), new Uint8Array(await digest(password)));
}

async function signature(password: string, expiry: number): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    await digest(`widesend-admin-session\n${password}`),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return hex(await crypto.subtle.sign('HMAC', key, encoder.encode(String(expiry))));
}
export async function createSession(password: string, now: number): Promise<string> {
  const expiry = now + SESSION_SECONDS * 1000;
  return `${expiry}.${await signature(password, expiry)}`;
}
export async function validSession(
  cookieHeader: string | null,
  password: string,
  now: number,
): Promise<boolean> {
  const value = (cookieHeader ?? '')
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${SESSION_COOKIE}=`))
    ?.slice(SESSION_COOKIE.length + 1);
  const match = /^(\d{13,16})\.([0-9a-f]{64})$/.exec(value ?? '');
  if (!match) return false;
  const expiry = Number(match[1]);
  if (!(expiry > now)) return false;
  return sameBytes(encoder.encode(await signature(password, expiry)), encoder.encode(match[2]));
}
export const sessionCookie = (value: string) =>
  `${SESSION_COOKIE}=${value}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_SECONDS}`;
export const clearedCookie = () =>
  `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;

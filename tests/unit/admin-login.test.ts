import { describe, expect, it } from 'vitest';
import admin from '../../admin/index';
import { SESSION_COOKIE } from '../../admin/session';

const password = 'correct horse battery';
type Decision = { allowed: true } | { allowed: false; retryAfter: number };
function environment(
  settings: Record<string, string> = { ADMIN_PASSWORD: password },
  decision: Decision = { allowed: true },
) {
  const attempts: string[] = [];
  return {
    attempts,
    env: {
      ...settings,
      ASSETS: { fetch: async () => new Response('dashboard') },
      ACTIVITY: {},
      GUARD: {
        idFromName: (name: string) => name,
        get: () => ({
          adminLogin: async (network: string) => {
            attempts.push(network);
            return decision;
          },
          health: async () => ({}),
        }),
      },
    } as never,
  };
}
const site = 'https://admin.example';
const fetch = (env: never, path: string, init?: RequestInit) =>
  admin.fetch(new Request(site + path, init), env);
const signIn = (env: never, typed: string, origin = site) =>
  fetch(env, '/login', {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password: typed }),
  });
const sessionOf = (response: Response) =>
  /widesend_admin=[^;]*/.exec(response.headers.get('Set-Cookie') ?? '')?.[0] ?? '';

describe('admin password sign-in', () => {
  it('refuses to run without a usable sign-in', async () => {
    for (const settings of [{}, { ADMIN_PASSWORD: 'short' }])
      expect((await fetch(environment(settings).env, '/')).status).toBe(503);
  });
  it('says when the password is too short', async () => {
    const response = await fetch(environment({ ADMIN_PASSWORD: 'short' }).env, '/');
    expect(await response.text()).toMatch(/shorter than 12 characters/);
  });
  it('lets no password in while Access settings are present but unusable', async () => {
    // A typo in an Access setting must not quietly fall back to a leftover password.
    for (const access of [
      { ACCESS_AUD: 'admin-audience' },
      {
        ACCESS_TEAM_DOMAIN: 'not-access.example',
        ACCESS_AUD: 'aud',
        ADMIN_EMAILS: 'me@example.com',
      },
      {
        ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com',
        ACCESS_AUD: 'aud',
        ADMIN_EMAILS: 'not an e-mail',
      },
    ]) {
      const { env } = environment({ ADMIN_PASSWORD: password, ...access });
      const page = await fetch(env, '/');
      expect(page.status, JSON.stringify(access)).toBe(503);
      expect(await page.text()).toMatch(/Cloudflare Access settings/);
      expect((await signIn(env, password)).status).toBe(503);
    }
  });
  it('sends visitors without a session to the sign-in page', async () => {
    const { env } = environment();
    const page = await fetch(env, '/', { redirect: 'manual' });
    expect(page.status).toBe(303);
    expect(page.headers.get('Location')).toBe('/login');
    const api = await fetch(env, '/api/transfers');
    expect(api.status).toBe(401);
    const form = await fetch(env, '/login');
    expect(form.status).toBe(200);
    expect(await form.text()).toContain('type="password"');
    expect(form.headers.get('Cache-Control')).toContain('no-store');
  });
  it('signs in with the right password into a strict, short session', async () => {
    const { env, attempts } = environment();
    const response = await signIn(env, password);
    expect(response.status).toBe(303);
    expect(response.headers.get('Location')).toBe('/');
    const cookie = response.headers.get('Set-Cookie')!;
    for (const part of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/', 'Max-Age=43200'])
      expect(cookie).toContain(part);
    expect(attempts).toHaveLength(1);
    const page = await fetch(env, '/', { headers: { Cookie: sessionOf(response) } });
    expect(await page.text()).toBe('dashboard');
    const me = await fetch(env, '/api/me', { headers: { Cookie: sessionOf(response) } });
    expect(await me.json()).toMatchObject({ signOut: '/logout' });
  });
  it('accepts the form as browsers send it from the sign-in page', async () => {
    // A page with a no-referrer policy makes browsers send "Origin: null"; the fetch
    // metadata header still says where the form came from.
    const { env } = environment();
    const form = (headers: Record<string, string>) =>
      fetch(env, '/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
        body: new URLSearchParams({ password }),
      });
    expect((await form({ Origin: 'null', 'Sec-Fetch-Site': 'same-origin' })).status).toBe(303);
    expect((await form({ Origin: 'null', 'Sec-Fetch-Site': 'cross-site' })).status).toBe(403);
    expect((await form({ Origin: 'null' })).status).toBe(403);
    expect((await form({ 'Sec-Fetch-Site': 'same-site' })).status).toBe(403);
    const page = await fetch(env, '/login');
    expect(page.headers.get('Referrer-Policy')).toBe('same-origin');
  });
  it('refuses a wrong password, a foreign form and too many attempts', async () => {
    const { env } = environment();
    const wrong = await signIn(env, 'not the password');
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get('Set-Cookie')).toBeNull();
    expect((await signIn(env, password, 'https://evil.example')).status).toBe(403);
    const limited = environment(undefined, { allowed: false, retryAfter: 600 });
    const response = await signIn(limited.env, password);
    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('600');
    expect(response.headers.get('Set-Cookie')).toBeNull();
  });
  it('signs out, and a changed password ends every session', async () => {
    const { env } = environment();
    const session = sessionOf(await signIn(env, password));
    const out = await fetch(env, '/logout', { headers: { Cookie: session } });
    expect(out.status).toBe(303);
    expect(out.headers.get('Set-Cookie')).toContain(`${SESSION_COOKIE}=;`);
    expect(out.headers.get('Set-Cookie')).toContain('Max-Age=0');
    const changed = environment({ ADMIN_PASSWORD: 'a different long password' });
    expect((await fetch(changed.env, '/api/me', { headers: { Cookie: session } })).status).toBe(
      401,
    );
  });
  it('lets Cloudflare Access decide when it is configured', async () => {
    const both = environment({
      ADMIN_PASSWORD: password,
      ACCESS_TEAM_DOMAIN: 'test-team.cloudflareaccess.com',
      ACCESS_AUD: 'admin-audience',
      ADMIN_EMAILS: 'owner@example.com',
    });
    const session = sessionOf(await signIn(environment().env, password));
    expect((await fetch(both.env, '/', { headers: { Cookie: session } })).status).toBe(403);
    expect((await signIn(both.env, password)).status).toBe(403);
  });
  it('still serves only reads to signed-in admins', async () => {
    const { env } = environment();
    const session = sessionOf(await signIn(env, password));
    const response = await fetch(env, '/api/transfers', {
      method: 'DELETE',
      headers: { Cookie: session },
    });
    expect(response.status).toBe(405);
  });
});

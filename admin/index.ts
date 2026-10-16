import { accessConfiguration, authenticateAdmin, type AccessEnvironment } from './auth';
import { adminAPI } from './api';
import { loginPage, type LoginMessage } from './login';
import {
  adminPassword,
  MIN_PASSWORD,
  clearedCookie,
  createSession,
  passwordMatches,
  sessionCookie,
  validSession,
} from './session';
import { networkKey } from '../worker/network';
import type { AbuseGuard } from '../worker/protection';
interface Env extends AccessEnvironment {
  ACTIVITY: D1Database;
  ASSETS: Fetcher;
  GUARD: DurableObjectNamespace<AbuseGuard>;
  // Sign-in without Cloudflare Access: a Worker secret of at least 12 characters.
  ADMIN_PASSWORD?: string;
}
// What the sign-in page itself needs before anyone is signed in.
const LOGIN_ASSETS = new Set(['/admin.css', '/widesend.svg']);
function protect(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', 'private, no-store');
  headers.set('Vary', 'Cookie, Cf-Access-Jwt-Assertion');
  headers.set(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  );
  headers.set('X-Content-Type-Options', 'nosniff');
  // same-origin, not no-referrer: with no-referrer browsers post forms with "Origin: null".
  headers.set('Referrer-Policy', 'same-origin');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('X-Robots-Tag', 'noindex, nofollow');
  return new Response(response.body, { status: response.status, headers });
}
const redirect = (location: string, cookie?: string) =>
  new Response(null, {
    status: 303,
    headers: { Location: location, ...(cookie ? { 'Set-Cookie': cookie } : {}) },
  });
const page = (status: number, message: LoginMessage = null, headers: HeadersInit = {}) =>
  new Response(loginPage(message), {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', ...headers },
  });

/** Whether a form post came from this site. Browsers say so in Sec-Fetch-Site, and in Origin. */
function fromThisSite(request: Request, url: URL): boolean {
  const origin = request.headers.get('Origin');
  if (origin && origin !== 'null' && origin !== url.origin) return false;
  const site = request.headers.get('Sec-Fetch-Site');
  return site ? site === 'same-origin' : origin === url.origin;
}

async function signIn(request: Request, url: URL, env: Env, password: string, signedIn: boolean) {
  if (request.method === 'GET' || request.method === 'HEAD')
    return signedIn ? redirect('/') : page(200);
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  if (!fromThisSite(request, url)) return new Response('Sign-in refused.', { status: 403 });
  if (Number(request.headers.get('Content-Length') ?? 0) > 4096)
    return new Response('Sign-in refused.', { status: 413 });
  // Every attempt counts, so guessing stays slow whatever the outcome.
  const decision = await env.GUARD.get(env.GUARD.idFromName('public-admission')).adminLogin(
    await networkKey(request),
  );
  if (!decision.allowed)
    return page(429, 'limited', { 'Retry-After': String(decision.retryAfter) });
  let typed = '';
  try {
    const value = (await request.formData()).get('password');
    if (typeof value === 'string') typed = value.slice(0, 1024);
  } catch {
    /* An unreadable form is a wrong password. */
  }
  if (!(await passwordMatches(typed, password))) return page(401, 'wrong');
  return redirect('/', sessionCookie(await createSession(password, Date.now())));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const access = accessConfiguration(env);
    const unavailable = (text: string) => protect(new Response(text, { status: 503 }));
    // Access settings that are present but unusable (a typo, a missing value) never fall
    // back to a password: whoever set them meant Access to be the only way in.
    if (
      !access &&
      [env.ACCESS_TEAM_DOMAIN, env.ACCESS_AUD, env.ADMIN_EMAILS].some((v) => v?.trim())
    )
      return unavailable(
        'The Cloudflare Access settings are incomplete or invalid: the team domain (TEAM.cloudflareaccess.com), the AUD tag and the admin e-mail addresses are all needed. See docs/admin.md in the project.',
      );
    // Cloudflare Access, when configured, is the only way in.
    const password = access ? null : adminPassword(env);
    if (!access && !password)
      return unavailable(
        env.ADMIN_PASSWORD
          ? `The admin password is shorter than ${MIN_PASSWORD} characters. Set a longer one: npx wrangler secret put ADMIN_PASSWORD --config wrangler.admin.jsonc`
          : 'Admin sign-in is not configured. Run npm run setup, or see docs/admin.md in the project.',
      );
    const url = new URL(request.url);
    let viewer: string;
    let signOut: string;
    if (access) {
      const email = await authenticateAdmin(request, env);
      if (!email) return protect(new Response('Admin sign-in required.', { status: 403 }));
      viewer = email;
      signOut = '/cdn-cgi/access/logout';
    } else {
      const signedIn = await validSession(request.headers.get('Cookie'), password!, Date.now());
      if (url.pathname === '/login')
        return protect(await signIn(request, url, env, password!, signedIn));
      if (url.pathname === '/logout') return protect(redirect('/login', clearedCookie()));
      if (!signedIn) {
        if (request.method === 'GET' && LOGIN_ASSETS.has(url.pathname))
          return protect(await env.ASSETS.fetch(request));
        return protect(
          url.pathname.startsWith('/api/')
            ? Response.json({ error: 'Sign in again.' }, { status: 401 })
            : redirect('/login'),
        );
      }
      viewer = 'Administrator';
      signOut = '/logout';
    }
    if (!['GET', 'HEAD'].includes(request.method))
      return protect(new Response('Method not allowed', { status: 405 }));
    try {
      if (url.pathname.startsWith('/api/'))
        return protect(
          await adminAPI(
            url,
            env.ACTIVITY,
            viewer,
            () => env.GUARD.get(env.GUARD.idFromName('public-admission')).health(),
            signOut,
          ),
        );
      return protect(await env.ASSETS.fetch(request));
    } catch {
      return protect(
        Response.json(
          { error: 'Activity records are temporarily unavailable. Try again shortly.' },
          { status: 503 },
        ),
      );
    }
  },
} satisfies ExportedHandler<Env>;

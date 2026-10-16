import { beforeAll, describe, expect, it } from 'vitest';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { authenticateAdmin, accessConfiguration } from '../../admin/auth';
import admin from '../../admin/index';
const env = {
  ACCESS_TEAM_DOMAIN: 'test-team.cloudflareaccess.com',
  ACCESS_AUD: 'admin-audience',
  ADMIN_EMAILS: 'owner@example.com',
};
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let resolver: ReturnType<typeof createLocalJWKSet>;
beforeAll(async () => {
  keys = await generateKeyPair('RS256');
  resolver = createLocalJWKSet({
    keys: [{ ...(await exportJWK(keys.publicKey)), kid: 'one', alg: 'RS256' }],
  });
});
async function token(
  email = 'owner@example.com',
  aud = 'admin-audience',
  issuer = 'https://test-team.cloudflareaccess.com',
  expiry = '1h',
) {
  return new SignJWT({ email })
    .setProtectedHeader({ alg: 'RS256', kid: 'one' })
    .setSubject('admin-subject')
    .setIssuedAt()
    .setIssuer(issuer)
    .setAudience(aud)
    .setExpirationTime(expiry)
    .sign(keys.privateKey);
}
const request = (jwt: string) =>
  new Request('https://widesend-admin.example/api/transfers', {
    headers: { 'Cf-Access-Jwt-Assertion': jwt },
  });
describe('admin authorization', () => {
  it('accepts only a signed token for the configured application and exact email', async () => {
    expect(await authenticateAdmin(request(await token()), env, resolver)).toBe(
      'owner@example.com',
    );
    for (const jwt of [
      await token('outsider@example.com'),
      await token(undefined, 'other-app'),
      await token(undefined, undefined, 'https://evil.example'),
      await token(undefined, undefined, undefined, '-1h'),
      'unsigned.invalid.token',
    ])
      expect(await authenticateAdmin(request(jwt), env, resolver)).toBeNull();
  });
  it('does not trust an email header, missing settings, or arbitrary key servers', async () => {
    const forged = new Request('https://widesend-admin.example/', {
      headers: { 'Cf-Access-Authenticated-User-Email': 'owner@example.com' },
    });
    expect(await authenticateAdmin(forged, env, resolver)).toBeNull();
    expect(accessConfiguration({ ...env, ACCESS_TEAM_DOMAIN: 'attacker.example' })).toBeNull();
    expect(await authenticateAdmin(request(await token()), {}, resolver)).toBeNull();
  });
  it('denies every path before querying data or serving assets when login is absent', async () => {
    const unavailable = {
      get ACTIVITY() {
        throw new Error('Database must not be accessed');
      },
      get ASSETS() {
        throw new Error('Assets must not be accessed');
      },
      get GUARD() {
        throw new Error('Protection data must not be accessed');
      },
    };
    for (const path of [
      '/',
      '/api/transfers',
      '/api/health-overview',
      '/admin.js',
      '/health.js',
      '/widesend.svg',
    ]) {
      expect(
        (await admin.fetch(new Request('https://admin.example' + path), unavailable as never))
          .status,
      ).toBe(503);
      const response = await admin.fetch(
        new Request('https://admin.example' + path),
        Object.assign(Object.create(unavailable), env) as never,
      );
      expect(response.status).toBe(403);
      expect(response.headers.get('cache-control')).toContain('no-store');
    }
  });
});

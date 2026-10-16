import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
export interface AccessEnvironment {
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  ADMIN_EMAILS?: string;
}
const keySets = new Map<string, JWTVerifyGetKey>();
export function accessConfiguration(env: AccessEnvironment) {
  const domain = env.ACCESS_TEAM_DOMAIN?.trim().toLowerCase() || '';
  const audience = env.ACCESS_AUD?.trim() || '';
  const emails = (env.ADMIN_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  if (
    !/^[a-z0-9][a-z0-9-]*\.cloudflareaccess\.com$/.test(domain) ||
    !audience ||
    !emails.length ||
    emails.some((e) => !/^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(e))
  )
    return null;
  return { issuer: `https://${domain}`, audience, emails };
}
export async function authenticateAdmin(
  request: Request,
  env: AccessEnvironment,
  testKeys?: JWTVerifyGetKey,
): Promise<string | null> {
  const config = accessConfiguration(env);
  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!config || !token || token.length > 16_384) return null;
  try {
    let keys = testKeys || keySets.get(config.issuer);
    if (!keys) {
      keys = createRemoteJWKSet(new URL(`${config.issuer}/cdn-cgi/access/certs`), {
        timeoutDuration: 5000,
      });
      keySets.set(config.issuer, keys);
    }
    const { payload } = await jwtVerify(token, keys, {
      issuer: config.issuer,
      audience: config.audience,
      algorithms: ['RS256'],
      requiredClaims: ['exp', 'iat', 'sub', 'email'],
      clockTolerance: 5,
    });
    if (typeof payload.email !== 'string' || !config.emails.includes(payload.email.toLowerCase()))
      return null;
    return payload.email;
  } catch {
    return null;
  }
}

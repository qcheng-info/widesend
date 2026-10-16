import { describe, expect, it } from 'vitest';
import {
  SESSION_COOKIE,
  SESSION_SECONDS,
  adminPassword,
  createSession,
  passwordMatches,
  validSession,
} from '../../admin/session';

const password = 'correct horse battery';
const now = 1_800_000_000_000;
const cookie = (value: string) => `other=1; ${SESSION_COOKIE}=${value}`;

describe('admin password sessions', () => {
  it('accepts only passwords of at least 12 characters as a setting', () => {
    expect(adminPassword({})).toBeNull();
    expect(adminPassword({ ADMIN_PASSWORD: 'short' })).toBeNull();
    expect(adminPassword({ ADMIN_PASSWORD: '12345678901' })).toBeNull();
    expect(adminPassword({ ADMIN_PASSWORD: '123456789012' })).toBe('123456789012');
  });
  it('matches only the same password', async () => {
    expect(await passwordMatches(password, password)).toBe(true);
    for (const attempt of ['', 'correct horse', `${password} `, 'Correct horse battery'])
      expect(await passwordMatches(attempt, password), attempt).toBe(false);
  });
  it('accepts its own fresh session for twelve hours', async () => {
    const session = await createSession(password, now);
    expect(SESSION_SECONDS).toBe(43_200);
    expect(await validSession(cookie(session), password, now)).toBe(true);
    expect(await validSession(cookie(session), password, now + SESSION_SECONDS * 1000 - 1)).toBe(
      true,
    );
    expect(await validSession(cookie(session), password, now + SESSION_SECONDS * 1000 + 1)).toBe(
      false,
    );
  });
  it('refuses sessions that were changed, signed with another password, or missing', async () => {
    const session = await createSession(password, now);
    const [expiry, signature] = session.split('.');
    const forged = [
      `${Number(expiry) + 3_600_000}.${signature}`,
      `${expiry}.${signature.replace(/.$/, (c) => (c === '0' ? '1' : '0'))}`,
      `${expiry}.`,
      expiry,
      'garbage',
      await createSession('another long password', now),
    ];
    for (const value of forged)
      expect(await validSession(cookie(value), password, now), value).toBe(false);
    expect(await validSession(null, password, now)).toBe(false);
    expect(await validSession('other=1', password, now)).toBe(false);
  });
});

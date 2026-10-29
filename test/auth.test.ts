import { afterEach, expect, test, vi } from 'vitest';
import { FactsError, refresh, resolveLogin } from '../src/auth.js';
import { parseTotpSecret, totp } from '../src/totp.js';

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
const env = { FACTS_DISTRICT: 'D', FACTS_USERNAME: 'u', FACTS_PASSWORD: 'p', FACTS_TOTP_SECRET: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ' };

test('TOTP matches the RFC 6238 SHA1 vectors', () => {
  const secret = parseTotpSecret('gezd gnbv gy3t qojq gezd gnbv gy3t qojq');
  expect(secret.toString()).toBe('12345678901234567890');
  expect(totp(secret, 59_000)).toBe('287082');
  expect(totp(secret, 1_111_111_109_000)).toBe('081804');
  expect(parseTotpSecret('otpauth://totp/FACTS:u?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=FACTS')).toEqual(secret);
  expect(() => parseTotpSecret('otpauth://totp/x?secret=GEZDGNBV&digits=8')).toThrow(/6-digit/);
  expect(() => parseTotpSecret('not base32!')).toThrow(/base32/);
});

test('credentials come from env, with explicit options taking precedence', async () => {
  vi.useFakeTimers({ now: 59_000 - 25_000 });
  const { credentials, otp } = resolveLogin({ env, username: 'override' });
  expect(credentials).toEqual({ district: 'D', username: 'override', password: 'p' });
  expect(await otp({ type: 'authenticator' })).toBe('287082');
  await expect(otp({ type: 'email' })).rejects.toMatchObject({ code: 'FACTS_CONFIG' });
});

test('login refuses to start without credentials or an OTP source', () => {
  expect(() => resolveLogin({ env: { FACTS_DISTRICT: 'D' } })).toThrow(/FACTS_USERNAME, FACTS_PASSWORD/);
  expect(() => resolveLogin({ env: { ...env, FACTS_TOTP_SECRET: undefined } })).toThrow(/OTP/);
  expect(() => resolveLogin({ env: { ...env, FACTS_TOTP_SECRET: 'bad!' } })).toThrow(FactsError);
  expect(resolveLogin({ env: { ...env, FACTS_TOTP_SECRET: undefined }, otp: () => '1' }).credentials.username).toBe('u');
});

test('refresh keeps the old refresh token when FACTS does not rotate it, and maps rejection', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json({ access_token: 'a2', expires_in: 3600 }));
  const tokens = await refresh('r1');
  expect(tokens).toMatchObject({ accessToken: 'a2', refreshToken: 'r1' });
  expect(tokens.expiresAt).toBeGreaterThan(Date.now() + 3_500_000);
  const body = fetch.mock.calls[0]![1]!.body as URLSearchParams;
  expect(Object.fromEntries(body)).toEqual({ client_id: 'aware3', grant_type: 'refresh_token', refresh_token: 'r1' });
  fetch.mockResolvedValueOnce(new Response('', { status: 400 }));
  await expect(refresh('r1')).rejects.toMatchObject({ code: 'FACTS_LOGIN_REQUIRED' });
});

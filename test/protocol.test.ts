import { createHash } from 'node:crypto';
import { afterEach, expect, test, vi } from 'vitest';
import { authorization, callbackCode, formBody, LoginSession, parseForm, signinRedirect } from '../src/protocol.js';

const base = 'https://accounts.renweb.com/Account/Login';
const never = () => { throw new Error('OTP should not be requested'); };
afterEach(() => { vi.restoreAllMocks(); });

test('PKCE and callback state are bound to each login attempt', () => {
  const auth = authorization();
  expect(auth.url.searchParams.get('code_challenge')).toBe(createHash('sha256').update(auth.verifier).digest('base64url'));
  expect(callbackCode(`com.renweb.accounts:/oauthredirect?code=abc&state=${auth.state}`, auth.state)).toBe('abc');
  expect(() => callbackCode('com.renweb.accounts:/oauthredirect?code=abc&state=wrong', auth.state)).toThrow(/state/);
  expect(() => callbackCode(`https://example.com/oauthredirect?state=${auth.state}`, auth.state)).toThrow(/callback/);
});

test('district form preserves hidden CSRF and uses the visible submit', async () => {
  const form = parseForm(`<form method="post" action="/Account/SignIn">
    <input name="submit" type="submit" value="wrong" aria-hidden="true">
    <input name="__RequestVerificationToken" type="hidden" value="csrf">
    <input name="District"><input name="submit" type="submit" value="NEXT"></form>`, base);
  const { body } = await formBody(form, { district: 'A&B' }, never);
  expect(body.get('District')).toBe('A&B');
  expect(body.get('__RequestVerificationToken')).toBe('csrf');
  expect(body.getAll('submit')).toEqual(['NEXT']);
});

test('credentials are encoded; OTP is requested only when its form appears', async () => {
  const credentials = { username: 'a+b@example.com', password: 'p&=+#' };
  const form = parseForm('<form method="post"><input name="Username"><input name="Password" type="password"></form>', base);
  const { body } = await formBody(form, credentials, never);
  expect(new URLSearchParams(body.toString()).get('Password')).toBe(credentials.password);
  const otp = parseForm('<form method="post"><input name="Code" autocomplete="one-time-code"></form>', base);
  expect((await formBody(otp, credentials, async () => '123456')).body.get('Code')).toBe('123456');
  expect(() => parseForm('<form method="post" action="https://example.com"><input name="Password" type="password"></form>', base)).toThrow(/origin/);
  const unknown = parseForm('<form method="post"><input name="ChallengeAnswer"></form>', base);
  await expect(formBody(unknown, credentials, never)).rejects.toThrow(/Unrecognized/);
});

test('login carries cookies across redirects and never requests the custom scheme', async () => {
  let count = 0;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
    count++;
    if (count === 1) return new Response(null, { status: 302, headers: {
      'set-cookie': 'session=secret; Path=/; Secure; HttpOnly', location: '/next' } });
    expect((options?.headers as Record<string, string>).cookie).toBe('session=secret');
    expect(new URL(String(url)).pathname).toBe('/next');
    return new Response(null, { status: 302, headers: { location: 'com.renweb.accounts:/oauthredirect?code=x&state=y' } });
  });
  expect(await new LoginSession().request(base)).toEqual({ callback: 'com.renweb.accounts:/oauthredirect?code=x&state=y' });
  expect(count).toBe(2);
});

test('FACTS return page follows its explicit redirect without executing JavaScript', () => {
  const page = { url: 'https://accounts.renweb.com/External/Callback', html:
    '<meta http-equiv="refresh" data-url="com.renweb.accounts:/oauthredirect?code=test&amp;state=opaque">' };
  expect(signinRedirect(page)?.searchParams.get('state')).toBe('opaque');
  expect(() => signinRedirect({ ...page, html: '<meta http-equiv="refresh" data-url="https://example.com">' })).toThrow(/redirect/);
});

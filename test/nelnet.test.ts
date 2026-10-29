import { CookieJar } from 'tough-cookie';
import { expect, test } from 'vitest';
import { federationPost, NELNET, nelnetLogin, redirectTarget } from '../src/nelnet.js';
import type { LoginSession, Page } from '../src/protocol.js';
import type { OtpRequest } from '../src/types.js';

interface Step { path: string; body?: unknown; data?: unknown; page?: Page }
const initialPage = { url: `${NELNET}/login/sign-in?returnUrl=%2Fconnect%2Fauthorize%2Fcallback&tenantKey=school`, html: '' };
const never = () => { throw new Error('OTP should not be requested'); };

function fixture(steps: Step[]) {
  const jar = new CookieJar();
  const calls: { url: URL; options: RequestInit }[] = [];
  const session: Pick<LoginSession, 'jar' | 'request'> = { jar, async request(input, options = {}) {
    const url = new URL(input);
    calls.push({ url, options });
    const expected = steps.shift();
    expect(expected, `Unexpected request ${url.pathname}`).toBeDefined();
    expect(url.pathname).toBe(expected!.path);
    if (expected!.path === '/api/spa-data-json') {
      await jar.setCookie('Passport-Xsrf-Cookie=csrf; Path=/; Secure', NELNET);
    } else if (url.pathname !== '/connect/authorize/callback') {
      expect(url.searchParams.get('returnUrl')).toBe('/connect/authorize/callback');
      expect(url.searchParams.get('tenantKey')).toBe('school');
    }
    if (options.method === 'POST') {
      expect(options.headers?.['Passport-Xsrf-Header']).toBe('csrf');
      expect(JSON.parse(String(options.body))).toEqual(expected!.body);
    }
    return expected!.page ?? { url: url.href, html: JSON.stringify(expected!.data) };
  } };
  return { session, calls };
}
const spa: Step = { path: '/api/spa-data-json', data: { antiForgeryTokenInfo: {
  cookieName: 'Passport-Xsrf-Cookie', headerName: 'Passport-Xsrf-Header' } } };

test('Nelnet login carries CSRF, context and OTP through to the FACTS callback', async () => {
  const steps: Step[] = [spa,
    { path: '/bff/api/v2/login/sign-in', data: {} },
    { path: '/bff/api/v2/login/sign-in', body: { username: 'parent', password: 'p&+' },
      data: { isSuccess: true, redirectUrl: { url: '/mfa/verify?returnUrl=%2Fconnect%2Fauthorize%2Fcallback&tenantKey=school' } } },
    { path: '/mfa/verify', page: { url: `${NELNET}/mfa/verify?returnUrl=%2Fconnect%2Fauthorize%2Fcallback&tenantKey=school`, html: '' } },
    { path: '/bff/api/v2/mfa-verify-code', data: {} },
    { path: '/bff/api/v2/mfa-verify-code', body: { code: '123456' }, data: { result: 1, scenario: 0 } },
    { path: '/connect/authorize/callback', page: { callback: 'com.renweb.accounts:/oauthredirect?code=authorization&state=random' } },
  ];
  const { session } = fixture(steps);
  const requests: OtpRequest[] = [];
  const page = await nelnetLogin(session, initialPage, { district: 'd', username: 'parent', password: 'p&+' },
    async request => { requests.push(request); return '123456'; }, () => {});
  expect(requests).toEqual([{ type: 'authenticator' }]);
  expect(page.callback).toMatch(/code=authorization/);
  expect(steps).toHaveLength(0);
});

test('email MFA asks for a destination when several exist, then the emailed code', async () => {
  const mfaUrl = `${NELNET}/mfa/email?returnUrl=%2Fconnect%2Fauthorize%2Fcallback&tenantKey=school`;
  const steps: Step[] = [spa,
    { path: '/bff/api/v2/email-mfa/get-emails', data: { emailAddresses: [
      { emailAddressId: 7, emailAddress: 'a***@example.com' }, { emailAddressId: 9, emailAddress: 'b***@example.com' }] } },
    { path: '/bff/api/v2/email-mfa/send-verification-code', body: { emailAddressId: 9 }, data: { isSuccess: true } },
    { path: '/bff/api/v2/email-mfa/submit-code', body: { code: '654321' }, data: { result: 1, scenario: 0 } },
    { path: '/connect/authorize/callback', page: { callback: 'com.renweb.accounts:/oauthredirect?code=c&state=s' } },
  ];
  const { session } = fixture(steps);
  const page = await nelnetLogin(session, { url: mfaUrl, html: '' }, { district: 'd', username: 'u', password: 'p' },
    request => request.type === 'email-destination' ? 'b***@example.com' : '654321', () => {});
  expect(page.callback).toMatch(/code=c/);
});

test('rejected credentials stop after one password submission', async () => {
  const steps: Step[] = [spa,
    { path: '/bff/api/v2/login/sign-in', data: {} },
    { path: '/bff/api/v2/login/sign-in', body: { username: 'parent', password: 'wrong' }, data: { isSuccess: false, type: 1 } },
  ];
  const { session, calls } = fixture(steps);
  await expect(nelnetLogin(session, initialPage, { district: 'd', username: 'parent', password: 'wrong' }, never, () => {}))
    .rejects.toThrow(/No retry/);
  expect(calls.filter(call => call.options.method === 'POST')).toHaveLength(1);
});

test('redirects must stay within the two observed identity providers and use GET', () => {
  expect(redirectTarget({ url: '/mfa/verify' }, NELNET).origin).toBe(NELNET);
  expect(() => redirectTarget({ url: 'https://example.com' }, NELNET)).toThrow(/origin/);
  expect(() => redirectTarget({ url: '/next', method: 'POST' }, NELNET)).toThrow(/model/);
});

test('federated form-post accepts only the observed callback and hidden OAuth fields', () => {
  const page = { url: `${NELNET}/connect/authorize`, html: `<form method="post" action="https://accounts.renweb.com/signin-openidconnect_prod">
    <input type="hidden" name="code" value="secret-code"><input type="hidden" name="state" value="opaque-state">
    <input type="hidden" name="iss" value="https://login.nelnet.net"></form>` };
  const post = federationPost(page)!;
  expect(post.body.get('code')).toBe('secret-code');
  expect(post.action.pathname).toBe('/signin-openidconnect_prod');
  expect(() => federationPost({ ...page, html: page.html.replace('accounts.renweb.com', 'example.com') })).toThrow(/destination/);
  expect(() => federationPost({ ...page, html: page.html.replace('name="iss"', 'name="password"') })).toThrow(/field/);
});

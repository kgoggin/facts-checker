import { load } from 'cheerio';
import type { LoginSession, Page } from './protocol.js';
import type { Credentials, OtpProvider } from './types.js';

// Endpoints observed in Nelnet's public login SPA, rather than the legacy form flow.
export const NELNET = 'https://login.nelnet.net';

interface RedirectModel { url?: string; method?: string }
interface NelnetResult {
  redirectUrl?: RedirectModel; isSuccess?: boolean; type?: unknown;
  result?: number; scenario?: number; [key: string]: unknown;
}
interface MfaEmail { emailAddressId?: unknown; emailAddress?: unknown; maskedEmailAddress?: unknown; email?: unknown }

export function redirectTarget(model: RedirectModel | undefined, base: string | URL): URL {
  if (!model?.url || (model.method && model.method.toUpperCase() !== 'GET')) {
    throw new Error('Unsupported Nelnet redirect model.');
  }
  const target = new URL(model.url, base);
  if (!['https://accounts.renweb.com', NELNET].includes(target.origin)) throw new Error('Unexpected Nelnet redirect origin.');
  return target;
}

export function federationPost(page: { url: string; html: string }): { action: URL; body: URLSearchParams } | null {
  const current = new URL(page.url);
  if (current.origin !== NELNET || !['/connect/authorize', '/connect/authorize/callback'].includes(current.pathname)) return null;
  const $ = load(page.html);
  const form = $('form');
  if (form.length !== 1 || form.attr('method')?.toLowerCase() !== 'post') throw new Error('Unexpected federation response form.');
  const action = new URL(form.attr('action') ?? '', current);
  if (action.href !== 'https://accounts.renweb.com/signin-openidconnect_prod') throw new Error('Unexpected federation response destination.');
  const body = new URLSearchParams();
  for (const input of form.find('input').toArray()) {
    const name = $(input).attr('name') ?? '';
    if ($(input).attr('type') !== 'hidden' || !['code', 'state', 'session_state', 'iss'].includes(name)) throw new Error('Unexpected federation response field.');
    body.append(name, $(input).attr('value') ?? '');
  }
  if (!body.get('code') || !body.get('state')) throw new Error('Incomplete federation response.');
  return { action, body };
}

function chooseEmail(emails: MfaEmail[], answer: string, labels: string[]): MfaEmail {
  const index = labels.indexOf(answer.trim());
  const selected = index >= 0 ? index : Number(answer) - 1;
  if (!Number.isInteger(selected) || selected < 0 || selected >= emails.length) throw new Error('Invalid email selection.');
  return emails[selected]!;
}

export async function nelnetLogin(session: Pick<LoginSession, 'jar' | 'request'>, initialPage: Page, credentials: Credentials,
  otp: OtpProvider, onProgress: (message: string) => void): Promise<Page> {
  const spaPage = await session.request(`${NELNET}/api/spa-data-json?&menuids=global-header-v2,global-nav-common,global-nav-shared-services,global-footer`);
  if (spaPage.callback !== undefined) throw new Error('Unexpected Nelnet configuration response.');
  const csrf = (JSON.parse(spaPage.html) as { antiForgeryTokenInfo?: { cookieName?: string; headerName?: string } }).antiForgeryTokenInfo;
  if (!csrf?.cookieName || !csrf?.headerName) throw new Error('Nelnet CSRF configuration missing.');
  const { cookieName, headerName } = csrf;
  let page = initialPage;
  const seen = new Set<string>();
  for (let step = 0; step < 8; step++) {
    if (page.callback !== undefined || new URL(page.url).origin !== NELNET) return page;
    const current = new URL(page.url);
    const path = current.pathname;
    const post = federationPost(page);
    if (post) {
      return session.request(post.action, { method: 'POST', body: post.body });
    }
    if (seen.has(path)) throw new Error(`Nelnet returned to ${path}; stopped to avoid repeated login attempts.`);
    seen.add(path);
    const api = async <T = NelnetResult>(endpoint: string, payload?: unknown): Promise<T> => {
      const url = new URL(endpoint, NELNET); url.search = current.search;
      const cookies = await session.jar.getCookies(url.href);
      const xsrf = cookies.find(cookie => cookie.key === cookieName)?.value;
      const headers: Record<string, string> = { accept: 'application/json' };
      if (payload !== undefined) {
        if (!xsrf) throw new Error('Nelnet CSRF cookie missing.');
        headers[headerName] = decodeURIComponent(xsrf);
        headers['content-type'] = 'application/json';
        headers.origin = NELNET;
        headers.referer = current.href;
      }
      const response = await session.request(url, { method: payload === undefined ? 'GET' : 'POST',
        headers, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
      if (response.callback !== undefined) throw new Error(`Nelnet redirected unexpectedly from ${endpoint}.`);
      try { return JSON.parse(response.html) as T; } catch { throw new Error(`Nelnet returned non-JSON from ${endpoint}.`); }
    };
    let result: NelnetResult;
    if (path === '/login/sign-in') {
      const info = await api('/bff/api/v2/login/sign-in');
      if (info.redirectUrl) { page = await session.request(redirectTarget(info.redirectUrl, current)); continue; }
      onProgress('Submitting Nelnet credentials.');
      result = await api('/bff/api/v2/login/sign-in', { username: credentials.username, password: credentials.password });
    } else if (path === '/mfa/verify') {
      const info = await api('/bff/api/v2/mfa-verify-code');
      if (info.redirectUrl) { page = await session.request(redirectTarget(info.redirectUrl, current)); continue; }
      onProgress('Submitting authenticator code.');
      result = await api('/bff/api/v2/mfa-verify-code', { code: await otp({ type: 'authenticator' }) });
    } else if (path === '/mfa/email') {
      const info = await api<NelnetResult & { emailAddresses?: unknown; emails?: unknown }>('/bff/api/v2/email-mfa/get-emails');
      if (info.redirectUrl) { page = await session.request(redirectTarget(info.redirectUrl, current)); continue; }
      const emails = (info.emailAddresses ?? info.emails) as MfaEmail[] | undefined;
      if (!Array.isArray(emails) || !emails.length) throw new Error(`Unrecognized Nelnet email MFA model (fields: ${Object.keys(info).join(', ')}).`);
      let selected = emails[0]!;
      if (emails.length > 1) {
        const labels = emails.map((email, i) => String(email.emailAddress ?? email.maskedEmailAddress ?? email.email ?? `Email ${i + 1}`));
        selected = chooseEmail(emails, await otp({ type: 'email-destination', options: labels }), labels);
      }
      if (selected.emailAddressId == null) throw new Error('MFA email missing ID.');
      const sent = await api('/bff/api/v2/email-mfa/send-verification-code', { emailAddressId: selected.emailAddressId });
      if (sent.isSuccess === false) throw new Error('Nelnet could not send the OTP.');
      onProgress('FACTS sent an email verification code.');
      result = await api('/bff/api/v2/email-mfa/submit-code', { code: await otp({ type: 'email' }) });
    } else throw new Error(`Unsupported Nelnet step ${path}; inspect its API before continuing.`);
    if ('result' in result) {
      if (result.result !== 1) throw new Error(`Nelnet rejected the OTP (result ${result.result}). No retry attempted.`);
      if (result.scenario !== 0) throw new Error(`OTP accepted; additional account step required (scenario ${result.scenario}). Resolve it in FACTS, then log in again.`);
      const returnUrl = current.searchParams.get('returnUrl');
      if (!returnUrl) throw new Error('OTP accepted but return URL missing.');
      result = { redirectUrl: { url: returnUrl } };
    }
    if (result.isSuccess === false || !result.redirectUrl) {
      throw new Error(`Nelnet rejected ${path} (type: ${result.type ?? 'unknown'}; fields: ${Object.keys(result).join(', ')}). No retry attempted.`);
    }
    page = await session.request(redirectTarget(result.redirectUrl, current));
  }
  throw new Error('Too many Nelnet login steps.');
}

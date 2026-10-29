import { randomBytes, createHash } from 'node:crypto';
import { load } from 'cheerio';
import { CookieJar } from 'tough-cookie';
import { FACTS_OAUTH } from './config.js';
import { FactsError, timeoutSignal } from './errors.js';
import { nelnetLogin, NELNET } from './nelnet.js';
import type { Credentials, OtpProvider, Tokens } from './types.js';

export const ISSUER = FACTS_OAUTH.issuer;
export const REDIRECT = FACTS_OAUTH.redirectUri;

export type Page = { callback: string } | { url: string; html: string; callback?: undefined };
type Options = Omit<RequestInit, 'headers'> & { headers?: Record<string, string> };
export interface FormField {
  name: string; type: string; value: string; autocomplete?: string;
  checked: boolean; disabled: boolean; hidden: boolean;
}
export interface Form { action: string; fields: FormField[] }
export interface Authorization { url: URL; verifier: string; state: string }

export function authorization(): Authorization {
  const verifier = randomBytes(32).toString('base64url');
  const state = randomBytes(32).toString('base64url');
  const url = new URL(FACTS_OAUTH.authorizationEndpoint);
  url.search = new URLSearchParams({ client_id: FACTS_OAUTH.clientId, response_type: 'code',
    scope: FACTS_OAUTH.scopes.join(' '),
    redirect_uri: REDIRECT, code_challenge_method: 'S256',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    state, nonce: randomBytes(32).toString('base64url') }).toString();
  return { url, verifier, state };
}

export function callbackCode(url: string, state: string): string {
  const parsed = new URL(url);
  if (parsed.protocol !== 'com.renweb.accounts:' || parsed.host !== '' || parsed.pathname !== '/oauthredirect') {
    throw new Error('Unexpected OAuth callback.');
  }
  if (parsed.searchParams.get('state') !== state) throw new Error('OAuth state mismatch.');
  if (parsed.searchParams.has('error')) throw new Error(`OAuth rejected: ${parsed.searchParams.get('error')}`);
  const code = parsed.searchParams.get('code');
  if (!code) throw new Error('OAuth callback did not include a code.');
  return code;
}

export function signinRedirect(page: { url: string; html: string }): URL | null {
  const url = new URL(page.url);
  if (url.origin !== ISSUER || url.pathname !== '/External/Callback') return null;
  const $ = load(page.html);
  const target = $('meta[http-equiv="refresh"]').attr('data-url');
  if (!target) throw new Error('FACTS sign-in return page has no redirect.');
  const next = new URL(target, url);
  if (next.origin !== ISSUER && !next.href.startsWith(REDIRECT + '?')) throw new Error('Unexpected FACTS sign-in redirect.');
  return next;
}

export class LoginSession {
  readonly jar = new CookieJar();
  constructor(private readonly signal?: AbortSignal) {}
  async request(url: string | URL, options: Options = {}): Promise<Page> {
    let target = new URL(url);
    for (let hops = 0; hops < 15; hops++) {
      if (target.protocol === 'com.renweb.accounts:') return { callback: target.href };
      if (target.username || target.password || ![ISSUER, NELNET].includes(target.origin)) throw new Error('Login redirected to an unsupported identity provider.');
      const cookie = await this.jar.getCookieString(target.href);
      const response = await fetch(target, { ...options, redirect: 'manual',
        signal: timeoutSignal(this.signal), headers: { ...options.headers, cookie } });
      for (const value of response.headers.getSetCookie()) await this.jar.setCookie(value, target.href);
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        if (!location) throw new Error('Login redirect missing Location.');
        const next = new URL(location, target);
        if ([307, 308].includes(response.status) && next.origin !== target.origin && options.method === 'POST') throw new Error('Refusing cross-origin credential redirect.');
        target = next;
        if (response.status === 303 || ([301, 302].includes(response.status) && options.method === 'POST')) options = {};
        continue;
      }
      if (!response.ok) throw new Error(`Login HTTP ${response.status} at ${target.pathname}`);
      return { url: target.href, html: await response.text() };
    }
    throw new Error('Too many login redirects.');
  }
}

export function parseForm(html: string, url: string): Form {
  const $ = load(html);
  const form = $('form').filter((_, el) => $(el).find('input[name="District"], input[type="password"], input[autocomplete="one-time-code"]').length > 0).first();
  const selected = form.length ? form : $('form').filter((_, el) => /post/i.test($(el).attr('method') ?? '')).first();
  if (!selected.length) throw new Error('No supported login form found. The OAuth client or login flow may have changed.');
  if ((selected.attr('method') ?? 'get').toLowerCase() !== 'post') throw new Error('Unsupported login form method.');
  const action = new URL(selected.attr('action') || url, url);
  if (action.origin !== ISSUER) throw new Error('Refusing to submit credentials to a different origin.');
  const fields = selected.find('input[name], select[name], button[name]').toArray().map(el => ({
    name: $(el).attr('name')!, type: ($(el).attr('type') ?? (el.tagName === 'button' ? 'submit' : el.tagName)).toLowerCase(),
    value: $(el).attr('value') ?? '', autocomplete: $(el).attr('autocomplete'),
    checked: $(el).is(':checked'), disabled: $(el).is(':disabled'),
    hidden: $(el).attr('aria-hidden') === 'true',
  }));
  return { action: action.href, fields };
}

export async function formBody(form: Form, credentials: Partial<Credentials>, otp: OtpProvider) {
  const body = new URLSearchParams();
  let stage: string | undefined;
  for (const field of form.fields) {
    if (field.disabled || ['submit', 'button', 'reset'].includes(field.type)) continue;
    if (['checkbox', 'radio'].includes(field.type) && !field.checked) continue;
    if (field.type === 'hidden' || ['checkbox', 'radio'].includes(field.type)) { body.append(field.name, field.value); continue; }
    let value: string | undefined;
    if (/^district(code)?$/i.test(field.name)) { value = credentials.district; stage = 'district'; }
    else if (/^(username|email|userNameOrEmail)$/i.test(field.name)) { value = credentials.username; stage = 'credentials'; }
    else if (field.type === 'password') { value = credentials.password; stage = 'credentials'; }
    else if (field.autocomplete === 'one-time-code' || /^(code|otp|verificationcode|securitycode|twofactorcode|twofactorauthenticationcode)$/i.test(field.name)) {
      value = await otp({ type: 'authenticator' }); stage = 'OTP';
    } else throw new Error(`Unrecognized login field "${field.name}" (${field.type}). Inspect this step before submitting.`);
    if (!value) throw new Error(`Missing value for ${field.name}.`);
    body.append(field.name, value);
  }
  const submit = form.fields.find(f => f.type === 'submit' && !f.hidden && !f.disabled);
  if (submit) body.append(submit.name, submit.value);
  if (!stage) throw new Error('Login requires an unfamiliar confirmation step; inspect it before submitting.');
  return { body, stage };
}

export async function tokenRequest(values: Record<string, string>, signal?: AbortSignal): Promise<Tokens> {
  let response: Response;
  try {
    response = await fetch(FACTS_OAUTH.tokenEndpoint, { method: 'POST', redirect: 'error', signal: timeoutSignal(signal),
      body: new URLSearchParams({ client_id: FACTS_OAUTH.clientId, ...values }) });
  } catch (cause) {
    if (signal?.aborted) throw cause;
    throw new FactsError('FACTS_UNAVAILABLE', 'FACTS token endpoint is unavailable.', { cause });
  }
  if (!response.ok) {
    throw new FactsError([400, 401, 403].includes(response.status) ? 'FACTS_LOGIN_REQUIRED' : 'FACTS_UNAVAILABLE',
      `FACTS token request HTTP ${response.status}.`);
  }
  const json = await response.json() as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown };
  if (typeof json.access_token !== 'string' || !json.access_token) throw new FactsError('FACTS_UNAVAILABLE', 'FACTS token response has no access token.');
  const expiresIn = typeof json.expires_in === 'number' && json.expires_in > 0 ? json.expires_in : 3600;
  return { accessToken: json.access_token, refreshToken: typeof json.refresh_token === 'string' ? json.refresh_token : values.refresh_token ?? '',
    expiresAt: Date.now() + expiresIn * 1000 };
}

export interface RunLoginOptions {
  session?: LoginSession; auth?: Authorization; page?: Page;
  onProgress?: (message: string) => void; signal?: AbortSignal;
}

export async function runLogin(credentials: Credentials, otp: OtpProvider,
  { signal, session = new LoginSession(signal), auth = authorization(), page, onProgress = () => {} }: RunLoginOptions = {}): Promise<Tokens> {
  page ??= await session.request(auth.url);
  const seen = new Set<string>();
  for (let step = 0; step < 8; step++) {
    if (page.callback !== undefined) {
      const code = callbackCode(page.callback, auth.state);
      return tokenRequest({ grant_type: 'authorization_code', code, code_verifier: auth.verifier, redirect_uri: REDIRECT }, signal);
    }
    const redirect = signinRedirect(page);
    if (redirect) { page = await session.request(redirect); continue; }
    if (new URL(page.url).origin === NELNET) {
      page = await nelnetLogin(session, page, credentials, otp, onProgress);
      continue;
    }
    const form = parseForm(page.html, page.url);
    const { body, stage } = await formBody(form, credentials, otp);
    const signature = `${new URL(form.action).pathname}:${stage}`;
    if (seen.has(signature)) throw new Error(`Login returned to the ${stage} step; stopped to avoid repeated attempts. Check credentials or inspect the flow.`);
    seen.add(signature);
    onProgress(`Submitting ${stage} step.`);
    page = await session.request(form.action, { method: 'POST', body });
  }
  throw new Error('Login did not finish within eight steps.');
}

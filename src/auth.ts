import { FactsError } from './errors.js';
import { runLogin, tokenRequest } from './protocol.js';
import { freshTotp, parseTotpSecret } from './totp.js';
import type { Credentials, OtpProvider, Tokens } from './types.js';

export type { Credentials, OtpProvider, OtpRequest, Tokens } from './types.js';
export { FactsError, type FactsErrorCode } from './errors.js';

export interface LoginOptions extends Partial<Credentials> {
  /** Base32 authenticator secret or `otpauth://` URI. Defaults to `FACTS_TOTP_SECRET`. */
  totpSecret?: string;
  /** Answers OTP prompts the TOTP secret cannot (email codes), or all of them when no secret is set. */
  otp?: OtpProvider;
  /** Source for `FACTS_*` defaults. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  onProgress?: (message: string) => void;
  signal?: AbortSignal;
}

export interface ResolvedLogin { credentials: Credentials; otp: OtpProvider }

/** Merges explicit options over `FACTS_*` environment variables; throws `FACTS_CONFIG` if anything required is missing. */
export function resolveLogin(options: LoginOptions = {}): ResolvedLogin {
  const env = options.env ?? process.env;
  const credentials = {
    district: options.district ?? env.FACTS_DISTRICT,
    username: options.username ?? env.FACTS_USERNAME,
    password: options.password ?? env.FACTS_PASSWORD,
  };
  const missing = Object.entries({ district: 'FACTS_DISTRICT', username: 'FACTS_USERNAME', password: 'FACTS_PASSWORD' })
    .filter(([key]) => !credentials[key as keyof Credentials]).map(([, name]) => name);
  if (missing.length) throw new FactsError('FACTS_CONFIG', `Missing FACTS credentials: ${missing.join(', ')}.`);

  const rawSecret = options.totpSecret ?? env.FACTS_TOTP_SECRET;
  if (!rawSecret && !options.otp) {
    throw new FactsError('FACTS_CONFIG', 'FACTS login always requires an OTP: set FACTS_TOTP_SECRET or pass an otp callback.');
  }
  let secret: Buffer | undefined;
  try { secret = rawSecret ? parseTotpSecret(rawSecret) : undefined; }
  catch (cause) { throw new FactsError('FACTS_CONFIG', `Invalid FACTS_TOTP_SECRET: ${(cause as Error).message}`, { cause }); }

  const otp: OtpProvider = async request => {
    if (secret && request.type === 'authenticator') return freshTotp(secret);
    if (!options.otp) throw new FactsError('FACTS_CONFIG', `FACTS asked for ${request.type === 'authenticator' ? 'an authenticator code' : 'email verification'}; pass an otp callback to answer it.`);
    return options.otp(request);
  };
  return { credentials: credentials as Credentials, otp };
}

/** Runs the full FACTS/Nelnet login (credentials + OTP) and returns fresh tokens. */
export async function login(options: LoginOptions = {}): Promise<Tokens> {
  const { credentials, otp } = resolveLogin(options);
  try {
    return await runLogin(credentials, otp, { signal: options.signal, onProgress: options.onProgress });
  } catch (cause) {
    if (cause instanceof FactsError || options.signal?.aborted) throw cause;
    throw new FactsError('FACTS_LOGIN_FAILED', (cause as Error).message, { cause });
  }
}

/** Exchanges a refresh token for new tokens. Rejected tokens throw `FACTS_LOGIN_REQUIRED`. */
export function refresh(refreshToken: string, options: { signal?: AbortSignal } = {}): Promise<Tokens> {
  if (!refreshToken) return Promise.reject(new FactsError('FACTS_LOGIN_REQUIRED', 'No FACTS refresh token.'));
  return tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken }, options.signal);
}

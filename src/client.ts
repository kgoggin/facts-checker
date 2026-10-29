import { FactsApi, type RequestOptions } from './api.js';
import { login, refresh, type LoginOptions } from './auth.js';
import { FactsError } from './errors.js';
import type { Tokens } from './types.js';

export type { Tokens } from './types.js';
export { FactsError, type FactsErrorCode } from './errors.js';

export { API_BASE, FACTS_OAUTH } from './config.js';
export type { Student, Homework, RequestOptions } from './api.js';

export interface ClientOptions {
  /** Previously saved tokens. With only a refresh token, the first request refreshes. */
  tokens?: Partial<Tokens>;
  /**
   * Options for a full login when there are no usable tokens or the refresh token is rejected.
   * Defaults to `FACTS_*` environment variables. `false` disables login; requests then throw `FACTS_LOGIN_REQUIRED`.
   */
  login?: LoginOptions | false;
  /** Called after every login or refresh; persist the tokens here to survive restarts. */
  onTokens?: (tokens: Tokens) => void | Promise<void>;
  /** Refresh this long before the access token expires. Defaults to 60 seconds. */
  refreshMarginMs?: number;
}

export class FactsClient extends FactsApi {
  #tokens: Partial<Tokens> | undefined;
  #pending: Promise<Tokens> | undefined;
  readonly #login: LoginOptions | false;
  readonly #onTokens: ClientOptions['onTokens'];
  readonly #margin: number;

  constructor(options: ClientOptions = {}) {
    super({ fetch: (url, init) => fetch(url, { ...init,
      headers: { ...init.headers, authorization: `Bearer ${this.#tokens?.accessToken}` } }) });
    this.#tokens = options.tokens && { ...options.tokens };
    this.#login = options.login ?? {};
    this.#onTokens = options.onTokens;
    this.#margin = options.refreshMarginMs ?? 60_000;
  }

  /** The current tokens, if any have been loaded or issued. */
  get tokens(): Tokens | undefined {
    const tokens = this.#tokens;
    return tokens?.accessToken ? { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken ?? '', expiresAt: tokens.expiresAt ?? 0 } : undefined;
  }

  /** Returns a valid access token, refreshing (or logging in) when needed. */
  async accessToken(): Promise<string> {
    const tokens = this.#tokens;
    if (tokens?.accessToken && (tokens.expiresAt == null || tokens.expiresAt - this.#margin > Date.now())) return tokens.accessToken;
    return (await this.#renew()).accessToken;
  }

  /** Authenticated GET against the FACTS mobile API, relative to {@link API_BASE}. */
  override async get<T = unknown>(path: string, options: RequestOptions = {}): Promise<T> {
    const token = await this.accessToken();
    try {
      return await super.get<T>(path, options);
    } catch (error) {
      if (!(error instanceof FactsError && error.code === 'FACTS_LOGIN_REQUIRED')) throw error;
      // Renew once unless a concurrent request already replaced the rejected token.
      if (this.#tokens?.accessToken === token) await this.#renew();
      await this.accessToken();
      return super.get<T>(path, options);
    }
  }

  #renew(): Promise<Tokens> {
    if (!this.#pending) {
      const pending = this.#issue();
      this.#pending = pending;
      pending.finally(() => { if (this.#pending === pending) this.#pending = undefined; }).catch(() => {});
    }
    return this.#pending;
  }

  async #issue(): Promise<Tokens> {
    const refreshToken = this.#tokens?.refreshToken;
    if (refreshToken) {
      try {
        return await this.#store(await refresh(refreshToken));
      } catch (error) {
        if (!(error instanceof FactsError && error.code === 'FACTS_LOGIN_REQUIRED') || this.#login === false) throw error;
      }
    }
    if (this.#login === false) throw new FactsError('FACTS_LOGIN_REQUIRED', 'FACTS tokens are missing or expired and login is disabled.');
    return this.#store(await login(this.#login));
  }

  async #store(tokens: Tokens): Promise<Tokens> {
    const next = { ...tokens, refreshToken: tokens.refreshToken || this.#tokens?.refreshToken || '' };
    this.#tokens = next;
    await this.#onTokens?.(next);
    return next;
  }
}

export function createClient(options: ClientOptions = {}): FactsClient {
  return new FactsClient(options);
}

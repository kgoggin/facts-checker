export type FactsErrorCode =
  /** Credentials, OTP or tokens were rejected; a new login is needed. */
  | 'FACTS_LOGIN_REQUIRED'
  /** The login flow failed or changed shape; inspect before retrying. */
  | 'FACTS_LOGIN_FAILED'
  /** A required credential or OTP source is missing. */
  | 'FACTS_CONFIG'
  /** FACTS could not be reached or returned an unsupported response. */
  | 'FACTS_UNAVAILABLE';

export class FactsError extends Error {
  override name = 'FactsError';
  constructor(readonly code: FactsErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

export function timeoutSignal(signal?: AbortSignal, ms = 30_000): AbortSignal {
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);
}

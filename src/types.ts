export interface Credentials {
  district: string;
  username: string;
  password: string;
}

/** What the login needs a one-time code (or choice) for. */
export type OtpRequest =
  | { type: 'authenticator' }
  | { type: 'email' }
  /** Several OTP email addresses exist; answer with one of `options` or its 1-based index. */
  | { type: 'email-destination'; options: string[] };

export type OtpProvider = (request: OtpRequest) => string | Promise<string>;

export interface Tokens {
  accessToken: string;
  refreshToken: string;
  /** Access-token expiry, epoch milliseconds. */
  expiresAt: number;
}

export { login, refresh, resolveLogin, type LoginOptions, type ResolvedLogin } from './auth.js';
export { createApi, FactsApi, type ApiFetch, type ApiOptions, type RequestOptions, type Student, type Homework } from './api.js';
export { createClient, FactsClient, type ClientOptions } from './client.js';
export { API_BASE, FACTS_OAUTH } from './config.js';
export { FactsError, type FactsErrorCode } from './errors.js';
export type { Credentials, OtpProvider, OtpRequest, Tokens } from './types.js';

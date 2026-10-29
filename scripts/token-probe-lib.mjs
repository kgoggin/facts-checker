// @ts-check
// Pure probe logic. No environment, filesystem, login or network access here.
import { createHash } from 'node:crypto';

export const TOKEN_ENDPOINT = 'https://accounts.renweb.com/connect/token';
export const LANES = /** @type {const} */ (['rolling', 'reuse', 'idle-1d', 'idle-7d', 'idle-16d', 'idle-31d']);
const IDLE_HOURS = { 'idle-1d': 24, 'idle-7d': 168, 'idle-16d': 384, 'idle-31d': 744 };
const OAUTH_ERRORS = new Set(['invalid_request', 'invalid_client', 'invalid_grant', 'unauthorized_client',
  'unsupported_grant_type', 'invalid_scope', 'access_denied', 'invalid_token', 'server_error', 'temporarily_unavailable']);

/** @typedef {typeof LANES[number]} LaneName */
/** @typedef {{ name: LaneName, createdAt: string, refreshToken?: string, status: 'active' | 'dead' | 'retired',
 * phase?: 'reuse-old', lastSuccessAgeHours?: number, rejectedAgeHours?: number }} Lane */
/** @typedef {{ version: 1, runId: string, startedAt: string, lanes: Lane[] }} ProbeState */
/** @typedef {Record<string, string | number | string[]>} Claims */
/** @typedef {{ outcome: 'ok' | 'rejected' | 'unavailable', status: number | null, error?: string,
 * rotated: boolean, inputTokenHash: string, tokenHash: string, expires_in?: number,
 * responseFields: string[], responseValues: Record<string, string | number>, accessClaims: Claims, refreshClaims: Claims }} Summary */
/** @typedef {{ runId: string, time: string, type: string, lane?: LaneName, ageHours?: number,
 * operation?: 'refresh' | 'reuse-old', note?: string } & Partial<Summary>} ProbeEvent */

/** @param {string} token */
export function tokenHash(token) {
  return createHash('sha256').update(token).digest('hex').slice(0, 12);
}

/** Decode for observation only; this does not verify a JWT signature. @param {unknown} token @returns {Record<string, unknown> | null} */
export function decodeJwt(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[1] || !/^[\w-]+$/.test(parts[1])) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : null;
  } catch { return null; }
}

/** @param {Record<string, unknown> | null} claims @returns {Claims} */
export function whitelistClaims(claims) {
  /** @type {Claims} */
  const result = {};
  for (const name of ['iat', 'exp', 'nbf', 'auth_time', 'client_id', 'scope', 'idp', 'amr']) {
    if (!claims || !Object.hasOwn(claims, name)) continue;
    const value = claims[name];
    if (['iat', 'exp', 'nbf', 'auth_time'].includes(name)) {
      if (typeof value === 'number' && Number.isFinite(value)) result[name] = value;
    } else if (typeof value === 'string' || (Array.isArray(value) && value.every(v => typeof v === 'string'))) {
      result[name] = value;
    }
  }
  return result;
}

/** @param {Lane} lane @param {number} now */
export function ageHours(lane, now) {
  return Math.max(0, (now - Date.parse(lane.createdAt)) / 3_600_000);
}

/** @param {Lane} lane @param {number} now */
export function isDue(lane, now) {
  if (lane.status !== 'active' || !lane.refreshToken) return false;
  if (lane.name === 'rolling' || lane.name === 'reuse') return true;
  return ageHours(lane, now) >= IDLE_HOURS[lane.name];
}

/** Wait a whole new 30-second period between grants, even if login itself used the next period. @param {number} now */
export function nextTotpDelay(now) {
  return 30_000 - (now % 30_000) + 50;
}

/** Select safe observations only. Never retain raw response bodies, tokens, or error descriptions.
 * @param {number | null} status @param {unknown} body @param {string} previousToken @returns {Summary} */
export function summarizeResponse(status, body, previousToken) {
  const fields = body && typeof body === 'object' && !Array.isArray(body)
    ? /** @type {Record<string, unknown>} */ (body) : {};
  const responseFields = Object.keys(fields).sort();
  /** @type {Record<string, string | number>} */
  const responseValues = {};
  for (const name of responseFields) {
    const value = fields[name];
    if ((name === 'token_type' || name === 'scope') && typeof value === 'string') responseValues[name] = value;
    // Expiry observations are numeric durations or ISO timestamps, never arbitrary strings/objects.
    if (/expires/i.test(name) && ((typeof value === 'number' && Number.isFinite(value))
      || (typeof value === 'string' && /^(?:\d+(?:\.\d+)?|\d{4}-\d\d-\d\dT[\d:.]+Z)$/.test(value)))) {
      responseValues[name] = value;
    }
  }
  const error = typeof fields.error === 'string'
    ? (OAUTH_ERRORS.has(fields.error) ? fields.error : 'unrecognized_error') : undefined;
  const temporary = error === 'server_error' || error === 'temporarily_unavailable';
  const ok = status !== null && status >= 200 && status < 300 && !fields.error
    && typeof fields.access_token === 'string' && fields.access_token.length > 0;
  const outcome = ok ? 'ok' : (!temporary && [400, 401, 403].includes(status ?? 0) ? 'rejected' : 'unavailable');
  const returned = typeof fields.refresh_token === 'string' && fields.refresh_token.length > 0
    ? fields.refresh_token : previousToken;
  return { outcome, status, ...(error ? { error } : {}), rotated: ok && returned !== previousToken,
    inputTokenHash: tokenHash(previousToken), tokenHash: tokenHash(returned),
    ...(typeof fields.expires_in === 'number' && Number.isFinite(fields.expires_in) ? { expires_in: fields.expires_in } : {}),
    responseFields, responseValues,
    accessClaims: whitelistClaims(decodeJwt(fields.access_token)), refreshClaims: whitelistClaims(decodeJwt(returned)) };
}

/** Pure lane transition. Only the rolling lane retains a replacement token; reuse keeps the old token for its second phase.
 * @param {Lane} lane @param {Summary} summary @param {number} now @param {string | undefined} replacement @returns {Lane} */
export function applyAttempt(lane, summary, now, replacement) {
  if (lane.status !== 'active' || summary.outcome === 'unavailable') return { ...lane };
  const next = { ...lane };
  if (summary.outcome === 'rejected') {
    next.status = 'dead';
    next.rejectedAgeHours = ageHours(lane, now);
  } else {
    next.lastSuccessAgeHours = ageHours(lane, now);
    if (lane.name === 'rolling') next.refreshToken = replacement || lane.refreshToken;
    else if (lane.name === 'reuse' && lane.phase !== 'reuse-old' && summary.rotated) next.phase = 'reuse-old';
    else next.status = 'retired';
  }
  if (next.status !== 'active') delete next.refreshToken;
  return next;
}

/** @param {ProbeState | null} state @param {ProbeEvent[]} events @param {number} now */
export function buildReport(state, events, now) {
  if (!state || state.lanes.length === 0) return 'No token-probe lanes recorded. Run start to create an experiment.';
  const current = events.filter(event => event.runId === state.runId);
  const lines = [`Token probe started ${state.startedAt}`, 'Ages are hours since each lane logged in.',
    'Lane | Status | Age now | Last success | Rejected at | Rotation / old-token reuse'];
  const hours = (/** @type {number | undefined} */ value) => value === undefined ? '—' : value.toFixed(2);
  for (const name of LANES) {
    const lane = state.lanes.find(candidate => candidate.name === name);
    if (!lane) { lines.push(`${name} | not started | — | — | — | —`); continue; }
    const attempts = current.filter(event => event.type === 'attempt' && event.lane === name);
    const successes = attempts.filter(event => event.outcome === 'ok');
    const reused = attempts.find(event => event.operation === 'reuse-old' && event.outcome !== 'unavailable');
    let rotation = successes.length ? `${successes.filter(event => event.rotated).length}/${successes.length} successful refreshes rotated` : 'not measured';
    if (name === 'reuse') {
      rotation += reused ? `; old token ${reused.outcome === 'ok' ? 'accepted' : 'rejected'}`
        : lane.phase === 'reuse-old' ? '; old-token result pending'
        : lane.status === 'retired' ? '; no rotation to test' : '';
    }
    if (attempts.at(-1)?.outcome === 'unavailable') rotation += '; last attempt unavailable';
    lines.push(`${name} | ${lane.status} | ${hours(ageHours(lane, now))} | ${hours(lane.lastSuccessAgeHours)} | ${hours(lane.rejectedAgeHours)} | ${rotation}`);
  }
  lines.push('', 'Manual marks:');
  const marks = current.filter(event => event.type === 'mark');
  lines.push(...(marks.length ? marks.map(event => `${event.time}  ${event.note}`) : ['(none)']));
  return lines.join('\n');
}

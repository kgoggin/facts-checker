import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { LANES, TOKEN_ENDPOINT, ageHours, applyAttempt, buildReport, decodeJwt, isDue, nextTotpDelay,
  summarizeResponse, tokenHash, whitelistClaims } from '../scripts/token-probe-lib.mjs';
import type { Lane, ProbeEvent, ProbeState } from '../scripts/token-probe-lib.mjs';

// All token/claim material is synthetic; even accidental network access fails this suite.
beforeAll(() => vi.stubGlobal('fetch', () => { throw new Error('Network forbidden in probe tests'); }));
afterAll(() => vi.unstubAllGlobals());
const fixture = JSON.parse(readFileSync(new URL('./fixtures/token-probe.json', import.meta.url), 'utf8')) as {
  claims: Record<string, unknown>; response: Record<string, unknown>;
};
const jwt = (payload: unknown) => `e30.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.fixture`;
const createdAt = '2026-10-29T00:00:00.000Z';
const start = Date.parse(createdAt);
const hour = 3_600_000;
const lane = (name: Lane['name'] = 'rolling'): Lane => ({ name, createdAt, status: 'active', refreshToken: 'fixture-old-token' });
const state = (lanes: Lane[]): ProbeState => ({ version: 1, runId: 'fixture-run', startedAt: createdAt, lanes });
const body = { ...fixture.response, access_token: jwt(fixture.claims), refresh_token: jwt({ ...fixture.claims, exp: 1701296000 }) };
const success = summarizeResponse(200, body, 'fixture-old-token');
const rejected = summarizeResponse(400, { error: 'invalid_grant' }, 'fixture-old-token');
const unavailable = summarizeResponse(null, null, 'fixture-old-token');

test('probe uses the existing FACTS token endpoint', () => {
  expect(TOKEN_ENDPOINT).toBe('https://accounts.renweb.com/connect/token');
});

test.each([['idle-1d', 24], ['idle-7d', 168], ['idle-16d', 384], ['idle-31d', 744]] as const)(
  '%s remains untouched until its target, then is due', (name, hours) => {
    expect(isDue(lane(name), start + hours * hour - 1)).toBe(false);
    expect(isDue(lane(name), start + hours * hour)).toBe(true);
    expect(isDue(lane(name), start + (hours + 6) * hour)).toBe(true);
  },
);

test('rolling and reuse are due immediately, and dead/retired/tokenless lanes are never due', () => {
  expect(LANES[0]).toBe('rolling');
  expect(isDue(lane(), start)).toBe(true);
  expect(isDue(lane('reuse'), start)).toBe(true);
  for (const name of LANES) {
    for (const status of ['dead', 'retired'] as const) expect(isDue({ ...lane(name), status }, start + 1000 * hour)).toBe(false);
    expect(isDue({ ...lane(name), refreshToken: undefined }, start + 1000 * hour)).toBe(false);
  }
  expect(ageHours(lane(), start + 6 * hour)).toBe(6);
  expect(ageHours(lane(), start - hour)).toBe(0);
});

test('next login always waits for a fresh TOTP period with a small boundary margin', () => {
  expect(nextTotpDelay(0)).toBe(30_050);
  expect(nextTotpDelay(29_999)).toBe(51);
  expect(nextTotpDelay(30_001)).toBe(30_049);
});

test('token identifiers are the first twelve SHA-256 hex characters', () => {
  expect(tokenHash('abc')).toBe('ba7816bf8f01');
  expect(tokenHash('fixture-old-token')).toMatch(/^[a-f0-9]{12}$/);
});

test('JWT decoder tolerates opaque, malformed and non-object payloads without throwing', () => {
  expect(decodeJwt(jwt(fixture.claims))).toEqual(fixture.claims);
  for (const token of [null, 42, '', 'opaque', 'a.b.c.d', 'a.%%%25.c', 'a.eA.c', jwt(null), jwt([]), jwt('text')]) {
    expect(decodeJwt(token)).toBeNull();
  }
});

test('claims allow only the requested names and simple expected types', () => {
  const claims = whitelistClaims(fixture.claims);
  expect(Object.keys(claims)).toEqual(['iat', 'exp', 'nbf', 'auth_time', 'client_id', 'scope', 'idp', 'amr']);
  expect(claims.amr).toEqual(['pwd', 'mfa']);
  expect(whitelistClaims(null)).toEqual({});
  expect(whitelistClaims({ exp: 'not-a-number', iat: Infinity, amr: [{ token: 'fixture-secret' }], scope: ['openid'], idp: {} })).toEqual({ scope: ['openid'] });
  expect(whitelistClaims(Object.create({ client_id: 'inherited' }) as Record<string, unknown>)).toEqual({});
});

test('response summary records rotation, fields, safe expiry values and whitelisted JWT claims', () => {
  expect(success).toMatchObject({ outcome: 'ok', status: 200, rotated: true,
    inputTokenHash: tokenHash('fixture-old-token'), tokenHash: tokenHash(body.refresh_token), expires_in: 3600,
    responseFields: Object.keys(body).sort(),
    responseValues: { token_type: 'Bearer', scope: 'openid offline_access', expires_in: 3600,
      refresh_token_expires_in: 1296000, absolute_expires_at: '2026-11-29T00:00:00Z' },
    accessClaims: whitelistClaims(fixture.claims), refreshClaims: { exp: 1701296000 } });
  const serialized = JSON.stringify(success);
  for (const value of ['fixture-old-token', body.access_token, body.refresh_token, 'private-fixture-value',
    'private-fixture-id-token', 'private-fixture-session', 'private-fixture-password', 'private-fixture-subject', 'fixture@example.invalid']) {
    expect(serialized).not.toContain(value);
  }
});

test('missing, empty or identical replacement tokens do not imply rotation', () => {
  for (const refresh_token of [undefined, '', 'fixture-old-token']) {
    const summary = summarizeResponse(200, { access_token: 'opaque-access', refresh_token }, 'fixture-old-token');
    expect(summary).toMatchObject({ outcome: 'ok', rotated: false, tokenHash: tokenHash('fixture-old-token'), accessClaims: {}, refreshClaims: {} });
  }
  expect(summarizeResponse(200, { access_token: 'opaque-access' }, body.refresh_token).refreshClaims.exp).toBe(1701296000);
});

test.each([400, 401, 403])('HTTP %s is a rejection; error descriptions and unknown error strings are never logged', status => {
  expect(summarizeResponse(status, { error: 'invalid_grant', error_description: 'fixture-private-description' }, 'old'))
    .toMatchObject({ outcome: 'rejected', status, error: 'invalid_grant', rotated: false });
  const summary = summarizeResponse(status, { error: 'fixture-private-error-value' }, 'old');
  expect(summary.error).toBe('unrecognized_error');
  expect(JSON.stringify(summary)).not.toContain('fixture-private-error');
});

test.each([null, 200, 302, 404, 429, 500, 503])('transport or unsupported response %s remains unavailable', status => {
  expect(summarizeResponse(status, null, 'old').outcome).toBe('unavailable');
});

test('malformed successful responses and temporary OAuth failures remain unavailable', () => {
  for (const response of [[], { access_token: '' }, { access_token: 42 }, { error: 'invalid_grant' }]) {
    expect(summarizeResponse(200, response, 'old').outcome).toBe('unavailable');
  }
  expect(summarizeResponse(400, { error: 'temporarily_unavailable' }, 'old').outcome).toBe('unavailable');
  expect(summarizeResponse(400, { error: 'server_error' }, 'old').outcome).toBe('unavailable');
});

test('rolling saves replacement tokens, keeps an unrotated token, and drops rejected tokens', () => {
  const original = lane();
  expect(applyAttempt(original, success, start + 6 * hour, body.refresh_token))
    .toMatchObject({ status: 'active', lastSuccessAgeHours: 6, refreshToken: body.refresh_token });
  expect(applyAttempt(original, summarizeResponse(200, { access_token: 'a' }, original.refreshToken!), start, undefined).refreshToken)
    .toBe(original.refreshToken);
  const dead = applyAttempt(original, rejected, start + 12 * hour, undefined);
  expect(dead).toMatchObject({ status: 'dead', rejectedAgeHours: 12 });
  expect(dead).not.toHaveProperty('refreshToken');
  expect(applyAttempt(dead, success, start + 18 * hour, 'new')).toEqual(dead);
  expect(original).toEqual(lane());
});

test('idle lanes retire after one success and retain their original token only while unavailable', () => {
  for (const name of LANES.filter(name => name.startsWith('idle-'))) {
    const original = lane(name);
    expect(applyAttempt(original, unavailable, start + 24 * hour, undefined)).toEqual(original);
    const retired = applyAttempt(original, success, start + 24 * hour, 'new');
    expect(retired.status).toBe('retired');
    expect(retired).not.toHaveProperty('refreshToken');
    expect(isDue(retired, start + 1000 * hour)).toBe(false);
  }
});

test('reuse preserves the original token for the old-token phase, including across unavailable attempts', () => {
  const pending = applyAttempt(lane('reuse'), success, start + hour, 'new');
  expect(pending).toMatchObject({ status: 'active', phase: 'reuse-old', refreshToken: 'fixture-old-token' });
  expect(applyAttempt(pending, unavailable, start + 2 * hour, undefined)).toEqual(pending);
  const accepted = applyAttempt(pending, success, start + 3 * hour, 'newer');
  expect(accepted).toMatchObject({ status: 'retired', lastSuccessAgeHours: 3 });
  expect(accepted).not.toHaveProperty('refreshToken');
  const denied = applyAttempt(pending, rejected, start + 3 * hour, undefined);
  expect(denied).toMatchObject({ status: 'dead', rejectedAgeHours: 3 });
  expect(denied).not.toHaveProperty('refreshToken');
  expect(applyAttempt(lane('reuse'), { ...success, rotated: false }, start, undefined).status).toBe('retired');
});

test('report handles absent and empty state clearly', () => {
  expect(buildReport(null, [], start)).toContain('No token-probe lanes recorded');
  expect(buildReport(state([]), [], start)).toContain('No token-probe lanes recorded');
});

test('report shows each lane, success/rejection ages, rotation, old reuse, and marks without exposing tokens', () => {
  const events: ProbeEvent[] = [
    { runId: 'fixture-run', time: createdAt, type: 'attempt', lane: 'rolling', operation: 'refresh', ...success },
    { runId: 'fixture-run', time: createdAt, type: 'attempt', lane: 'reuse', operation: 'refresh', ...success },
    { runId: 'fixture-run', time: createdAt, type: 'attempt', lane: 'reuse', operation: 'reuse-old', ...rejected },
    { runId: 'fixture-run', time: createdAt, type: 'mark', note: 'logged in on phone app' },
    { runId: 'previous-run', time: createdAt, type: 'mark', note: 'old experiment mark' },
  ];
  const report = buildReport(state([
    { ...lane(), lastSuccessAgeHours: 6 },
    { ...lane('reuse'), status: 'dead', lastSuccessAgeHours: 6, rejectedAgeHours: 6.01 },
  ]), events, start + 12 * hour);
  expect(report).toContain('rolling | active | 12.00 | 6.00 | — | 1/1 successful refreshes rotated');
  expect(report).toContain('reuse | dead | 12.00 | 6.00 | 6.01');
  expect(report).toContain('old token rejected');
  for (const name of LANES.slice(2)) expect(report).toContain(`${name} | not started`);
  expect(report).toContain(`${createdAt}  logged in on phone app`);
  expect(report).not.toContain('old experiment mark');
  expect(report).not.toContain('fixture-old-token');
});

test('report distinguishes pending/unavailable old-token checks, accepted old tokens and no rotation', () => {
  const event: ProbeEvent = { runId: 'fixture-run', time: createdAt, type: 'attempt', lane: 'reuse', operation: 'reuse-old', ...unavailable };
  const pending = { ...lane('reuse'), phase: 'reuse-old' as const };
  expect(buildReport(state([pending]), [event], start)).toContain('old-token result pending; last attempt unavailable');
  expect(buildReport(state([{ ...pending, status: 'retired' }]), [{ ...event, ...success }], start)).toContain('old token accepted');
  expect(buildReport(state([{ ...lane('reuse'), status: 'retired' }]), [], start)).toContain('no rotation to test');
});

test('offline CLI needs no environment/build, reports absent state, and keeps state and append-only marks private', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'facts-token-probe-test-'));
  const script = fileURLToPath(new URL('../scripts/token-probe.mjs', import.meta.url));
  const run = (...args: string[]) => execFileSync(process.execPath, [script, ...args], {
    cwd, env: {}, encoding: 'utf8', stdio: 'pipe', timeout: 10_000,
  });
  const directory = join(cwd, '.token-probe');
  try {
    expect(run('--help')).toContain('start [--force]');
    expect(run('report')).toContain('No token-probe state found');
    expect(existsSync(directory)).toBe(false);
    mkdirSync(directory, { mode: 0o755 });
    writeFileSync(join(directory, 'state.json'), JSON.stringify(state([])), { mode: 0o644 });
    expect(run('report')).toContain('No token-probe lanes recorded');
    writeFileSync(join(directory, 'state.json'), JSON.stringify(state([lane()])));
    expect(run('mark', 'logged in on phone app')).toContain('Manual mark recorded');
    const firstLog = readFileSync(join(directory, 'log.jsonl'), 'utf8');
    run('mark', 'logged out on phone app');
    const finalLog = readFileSync(join(directory, 'log.jsonl'), 'utf8');
    expect(finalLog.startsWith(firstLog)).toBe(true);
    expect(finalLog.trim().split('\n')).toHaveLength(2);
    const report = run('report');
    expect(report).toContain('logged in on phone app');
    expect(report).toContain('logged out on phone app');
    expect(`${report}${finalLog}`).not.toContain('fixture-old-token');
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    for (const file of ['state.json', 'log.jsonl']) expect(statSync(join(directory, file)).mode & 0o777).toBe(0o600);
    expect(existsSync(join(directory, '.lock'))).toBe(false);
    mkdirSync(join(directory, '.lock'), { mode: 0o700 });
    expect(() => run('mark', 'must not append')).toThrow();
    expect(readFileSync(join(directory, 'log.jsonl'), 'utf8')).toBe(finalLog);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

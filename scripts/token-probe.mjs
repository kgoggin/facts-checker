#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { appendFile, chmod, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { LANES, TOKEN_ENDPOINT, ageHours, applyAttempt, buildReport, isDue, nextTotpDelay,
  summarizeResponse, tokenHash, decodeJwt, whitelistClaims } from './token-probe-lib.mjs';

const HELP = `Usage: node scripts/token-probe.mjs <command>

Build first: npm run build
For start/check with FACTS_* defaults: npm run probe -- <command>

  start [--force]  Log in once per lane, sequentially, with a fresh TOTP period.
                  Stops on the first failure; never retries a login.
                  --force replaces state, preserving the append-only event log.
  check            Refresh due lanes once; reuse may also test its old token once.
  mark "<note>"    Record a phone-app login/logout or other manual event.
  report           Show lane status, ages, rotation and manual marks (offline).
  --help           Show this help (offline; no build or environment file required).

Lanes: rolling, reuse, idle-1d, idle-7d, idle-16d, idle-31d.
State is in .token-probe/ relative to the working directory, with private permissions.
Never put passwords, tokens, TOTP secrets or personal data in a manual mark.
See docs/token-probe.md for scheduling and interpretation.`;

const directory = resolve('.token-probe');
const statePath = join(directory, 'state.json');
const logPath = join(directory, 'log.jsonl');
const lockPath = join(directory, '.lock');
class ProbeError extends Error {}
const absent = error => error?.code === 'ENOENT';

async function exists(path) {
  try { await lstat(path); return true; }
  catch (error) { if (absent(error)) return false; throw error; }
}

async function secureDirectory() {
  await mkdir(directory, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new ProbeError('.token-probe must be a real directory.');
  await chmod(directory, 0o700);
}

async function secureFile(path) {
  if (!await exists(path)) return;
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new ProbeError('Probe state and log must be regular files, not symbolic links.');
  await chmod(path, 0o600);
}

async function withLock(action) {
  await secureDirectory();
  try { await mkdir(lockPath, { mode: 0o700 }); }
  catch (error) {
    if (error.code === 'EEXIST') throw new ProbeError('Another probe command holds .token-probe/.lock. If it crashed, verify it has stopped before removing that directory.');
    throw error;
  }
  try {
    await writeFile(join(lockPath, 'pid'), `${process.pid}\n`, { mode: 0o600, flag: 'wx' });
    await secureFile(statePath);
    await secureFile(logPath);
    return await action();
  } finally { await rm(lockPath, { recursive: true, force: true }); }
}

async function saveState(state) {
  const temporary = join(directory, `state-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await rename(temporary, statePath);
  } finally { await rm(temporary, { force: true }); }
}

async function logEvent(state, event) {
  await appendFile(logPath, `${JSON.stringify({ runId: state.runId, time: new Date().toISOString(), ...event })}\n`, { mode: 0o600 });
}

async function loadState() {
  if (!await exists(statePath)) return null;
  let state;
  try { state = JSON.parse(await readFile(statePath, 'utf8')); }
  catch { throw new ProbeError('Cannot read probe state.json. Preserve it for inspection before starting a new experiment.'); }
  if (state?.version !== 1 || typeof state.runId !== 'string' || !Number.isFinite(Date.parse(state.startedAt))
    || !Array.isArray(state.lanes) || new Set(state.lanes.map(lane => lane?.name)).size !== state.lanes.length
    || state.lanes.some(lane => !lane || !LANES.includes(lane.name) || !Number.isFinite(Date.parse(lane.createdAt))
      || !['active', 'dead', 'retired'].includes(lane.status)
      || (lane.status === 'active' && (typeof lane.refreshToken !== 'string' || !lane.refreshToken))
      || (lane.phase !== undefined && (lane.name !== 'reuse' || lane.phase !== 'reuse-old')))) {
    throw new ProbeError('Unsupported or invalid probe state.json. Preserve it before starting a new experiment.');
  }
  return state;
}

async function start(force) {
  if (!force && await exists(statePath)) throw new ProbeError('Probe state already exists. Use report/check, or start --force for a new experiment.');
  let login;
  try { ({ login } = await import('../dist/auth.js')); }
  catch { throw new ProbeError('Cannot load dist/auth.js. Run npm run build before start.'); }
  const state = { version: 1, runId: randomUUID(), startedAt: new Date().toISOString(), lanes: [] };
  await saveState(state);
  await logEvent(state, { type: 'start' });
  for (const name of LANES) {
    if (state.lanes.length) {
      console.log('Waiting for a new authenticator period before the next login.');
      await delay(nextTotpDelay(Date.now()));
    }
    console.log(`Logging in for ${name}.`);
    let tokens;
    try {
      tokens = await login();
      if (!tokens.refreshToken) throw new Error();
    } catch {
      await logEvent(state, { type: 'login-failed', lane: name });
      throw new ProbeError('Login failed; stopped immediately without retrying. Earlier lanes are saved. Review configuration and credentials before any new start.');
    }
    state.lanes.push({ name, createdAt: new Date().toISOString(), status: 'active', refreshToken: tokens.refreshToken });
    await saveState(state);
    await logEvent(state, { type: 'login', lane: name, ageHours: 0, tokenHash: tokenHash(tokens.refreshToken),
      accessClaims: whitelistClaims(decodeJwt(tokens.accessToken)), refreshClaims: whitelistClaims(decodeJwt(tokens.refreshToken)) });
  }
  console.log('All six lanes created. Run check every six hours.');
}

async function attempt(state, index) {
  const lane = state.lanes[index];
  let status = null;
  let body = null;
  try {
    // Fixed allowlisted endpoint; redirects can never forward a refresh token elsewhere.
    const response = await fetch(TOKEN_ENDPOINT, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000),
      body: new URLSearchParams({ grant_type: 'refresh_token', client_id: 'aware3', refresh_token: lane.refreshToken }) });
    status = response.status;
    body = await response.json();
  } catch { /* Never log transport errors, timeout/redirect details or non-JSON response text. */ }
  const now = Date.now();
  const summary = summarizeResponse(status, body, lane.refreshToken);
  const replacement = typeof body?.refresh_token === 'string' ? body.refresh_token : undefined;
  state.lanes[index] = applyAttempt(lane, summary, now, replacement);
  // Persist the rotated token/retirement before another request can happen.
  await saveState(state);
  await logEvent(state, { type: 'attempt', time: new Date(now).toISOString(), lane: lane.name,
    ageHours: ageHours(lane, now), operation: lane.phase === 'reuse-old' ? 'reuse-old' : 'refresh', ...summary });
  console.log(`${lane.name}${lane.phase === 'reuse-old' ? ' (old token)' : ''}: ${summary.outcome}.`);
  return summary;
}

async function check(state) {
  let attempted = false;
  for (let index = 0; index < state.lanes.length; index++) {
    const lane = state.lanes[index];
    if (!isDue(lane, Date.now())) continue;
    attempted = true;
    const summary = await attempt(state, index);
    if (lane.name === 'reuse' && lane.phase !== 'reuse-old' && summary.outcome === 'ok'
      && state.lanes[index].phase === 'reuse-old') await attempt(state, index);
  }
  if (!attempted) console.log('No live lanes are due.');
}

async function report(state) {
  let events = [];
  if (await exists(logPath)) {
    try { events = (await readFile(logPath, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line)); }
    catch { throw new ProbeError('Cannot read log.jsonl. Preserve the log for inspection.'); }
  }
  console.log(buildReport(state, events, Date.now()));
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === '--help' || command === '-h' || command === undefined) { console.log(HELP); return; }
  if (!['start', 'check', 'mark', 'report'].includes(command)
    || (command === 'start' && (args.length > 1 || (args.length === 1 && args[0] !== '--force')))
    || (command === 'mark' ? args.length !== 1 || !args[0].trim() : command !== 'start' && args.length !== 0)) {
    throw new ProbeError('Invalid command or arguments. Use --help for usage.');
  }
  process.umask(0o077);
  if (command !== 'start' && !await exists(directory)) {
    console.log('No token-probe state found. Run start to create an experiment.');
    return;
  }
  await withLock(async () => {
    if (command === 'start') return start(args[0] === '--force');
    const state = await loadState();
    if (!state) { console.log('No token-probe state found. Run start to create an experiment.'); return; }
    if (command === 'check') return check(state);
    if (command === 'report') return report(state);
    await logEvent(state, { type: 'mark', note: args[0] });
    console.log('Manual mark recorded.');
  });
}

main().catch(error => {
  // Provider errors, response bodies and stacks can contain secrets. Print only our own fixed messages.
  console.error(error instanceof ProbeError ? error.message : 'Token probe stopped because of a local I/O or unexpected error. No automatic retry was attempted.');
  process.exitCode = 1;
});

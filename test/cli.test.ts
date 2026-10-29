import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { resolveLogin, type LoginOptions } from '../src/auth.js';
import { main, type CliIO } from '../src/cli.js';
import { API_BASE, FACTS_OAUTH } from '../src/config.js';
import { FactsError } from '../src/errors.js';

const env = {
  FACTS_DISTRICT: 'TEST-DISTRICT',
  FACTS_USERNAME: 'test-parent',
  FACTS_PASSWORD: 'test-password',
  FACTS_TOTP_SECRET: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
};
const tokens = { refreshToken: 'test-refresh-token', accessToken: 'test-access-token', expiresAt: Date.UTC(2026, 0, 1) };

beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('CLI tests must never contact FACTS.'));
});
afterEach(() => {
  expect(globalThis.fetch).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});

function fixture(options: { env?: CliIO['env']; isTTY?: boolean; answers?: string[] } = {}) {
  const output = { stdout: '', stderr: '' };
  const answers = [...(options.answers ?? [])];
  const prompt = vi.fn(async (question: string) => {
    output.stderr += question;
    const answer = answers.shift();
    if (answer === undefined) throw new Error('Unexpected prompt.');
    return answer;
  });
  const login = vi.fn<(options?: LoginOptions) => Promise<typeof tokens>>().mockResolvedValue(tokens);
  const io: CliIO = {
    env: options.env ?? { ...env },
    isTTY: options.isTTY ?? false,
    stdout: { write(text) { output.stdout += text; } },
    stderr: { write(text) { output.stderr += text; } },
    prompt,
    login,
  };
  return { io, output, prompt, login };
}

test('token prints only the refresh token to stdout and progress to stderr, logging in once', async () => {
  const { io, output, prompt, login } = fixture();
  login.mockImplementation(async options => {
    options?.onProgress?.('Submitting Nelnet credentials.');
    return tokens;
  });
  expect(await main(['token'], io)).toBe(0);
  expect(output).toEqual({ stdout: `${tokens.refreshToken}\n`, stderr: 'Submitting Nelnet credentials.\n' });
  expect(login).toHaveBeenCalledExactlyOnceWith({ env: io.env, onProgress: expect.any(Function) });
  expect(prompt).not.toHaveBeenCalled();
});

test('token --json prints the token set, ISO expiry and shared OAuth/API configuration', async () => {
  const { io, output, login } = fixture();
  expect(await main(['token', '--json'], io)).toBe(0);
  expect(JSON.parse(output.stdout)).toEqual({
    refreshToken: tokens.refreshToken,
    accessToken: tokens.accessToken,
    expiresAt: '2026-01-01T00:00:00.000Z',
    oauth: FACTS_OAUTH,
    apiBase: API_BASE,
  });
  expect(output.stdout.endsWith('\n')).toBe(true);
  expect(output.stderr).toBe('');
  expect(login).toHaveBeenCalledTimes(1);
});

test('config prints the shared constants without credentials, prompts or login', async () => {
  const { io, output, prompt, login } = fixture({ env: {}, isTTY: true });
  expect(await main(['config'], io)).toBe(0);
  expect(output).toEqual({ stdout: `${JSON.stringify({ oauth: FACTS_OAUTH, apiBase: API_BASE })}\n`, stderr: '' });
  expect(login).not.toHaveBeenCalled();
  expect(prompt).not.toHaveBeenCalled();
});

test.each([
  [{}, 'Missing FACTS credentials: FACTS_DISTRICT, FACTS_USERNAME, FACTS_PASSWORD.'],
  [{ ...env, FACTS_PASSWORD: '' }, 'Missing FACTS credentials: FACTS_PASSWORD.'],
  [{ ...env, FACTS_TOTP_SECRET: undefined }, 'FACTS login always requires an OTP: set FACTS_TOTP_SECRET or pass an otp callback.'],
])('missing configuration without a TTY uses the existing FACTS_CONFIG error (%j)', async (missingEnv, message) => {
  const { io, output, prompt, login } = fixture({ env: missingEnv });
  expect(await main(['token'], io)).toBe(1);
  expect(output).toEqual({ stdout: '', stderr: `FACTS_CONFIG: ${message}\n` });
  expect(prompt).not.toHaveBeenCalled();
  expect(login).not.toHaveBeenCalled();
});

test('missing credentials on a TTY are prompted for and passed to login without changing env', async () => {
  const suppliedEnv = Object.freeze({});
  const answers = [env.FACTS_DISTRICT, env.FACTS_USERNAME, env.FACTS_PASSWORD, env.FACTS_TOTP_SECRET];
  const { io, output, prompt, login } = fixture({ env: suppliedEnv, isTTY: true, answers });
  expect(await main(['token'], io)).toBe(0);
  expect(prompt.mock.calls.map(([question]) => question)).toEqual([
    'FACTS district: ',
    'FACTS username: ',
    'FACTS password: ',
    'Authenticator secret (leave blank to enter MFA codes): ',
  ]);
  expect(login).toHaveBeenCalledExactlyOnceWith({
    district: env.FACTS_DISTRICT,
    username: env.FACTS_USERNAME,
    password: env.FACTS_PASSWORD,
    totpSecret: env.FACTS_TOTP_SECRET,
    env: suppliedEnv,
    otp: expect.any(Function),
    onProgress: expect.any(Function),
  });
  expect(suppliedEnv).toEqual({});
  for (const answer of answers) expect(output.stderr).not.toContain(answer);
  expect(output.stdout).toBe(`${tokens.refreshToken}\n`);
});

test('a TTY prompts only for missing values and does not retry empty answers', async () => {
  const { io, output, prompt, login } = fixture({ env: { ...env, FACTS_PASSWORD: undefined }, isTTY: true, answers: [''] });
  expect(await main(['token'], io)).toBe(1);
  expect(prompt).toHaveBeenCalledExactlyOnceWith('FACTS password: ');
  expect(output.stdout).toBe('');
  expect(output.stderr).toContain('FACTS_CONFIG: Missing FACTS credentials: FACTS_PASSWORD.\n');
  expect(login).not.toHaveBeenCalled();
});

test('a blank authenticator secret lets a TTY answer authenticator MFA interactively', async () => {
  const { io, output, prompt, login } = fixture({
    env: { ...env, FACTS_TOTP_SECRET: undefined }, isTTY: true, answers: ['', '123456'],
  });
  login.mockImplementation(async options => {
    const { otp } = resolveLogin(options);
    expect(await otp({ type: 'authenticator' })).toBe('123456');
    return tokens;
  });
  expect(await main(['token'], io)).toBe(0);
  expect(prompt).toHaveBeenCalledTimes(2);
  expect(prompt).toHaveBeenLastCalledWith('Authenticator code: ');
  expect(output.stderr).not.toContain('123456');
});

test('email destination and email code requests use the interactive OTP callback even with a TOTP secret', async () => {
  const { io, output, prompt, login } = fixture({ isTTY: true, answers: ['2', '654321'] });
  login.mockImplementation(async options => {
    const { otp } = resolveLogin(options);
    expect(await otp({ type: 'email-destination', options: ['first@example.test', 'second@example.test'] })).toBe('2');
    expect(await otp({ type: 'email' })).toBe('654321');
    return tokens;
  });
  expect(await main(['token'], io)).toBe(0);
  expect(prompt.mock.calls.map(([question]) => question)).toEqual([
    'Choose an email destination:\n  1. first@example.test\n  2. second@example.test\nEmail destination (address or number): ',
    'Email verification code: ',
  ]);
  expect(output.stderr).not.toContain('654321');
  expect(output.stdout).toBe(`${tokens.refreshToken}\n`);
  expect(login).toHaveBeenCalledTimes(1);
});

test('invalid TOTP configuration fails before login', async () => {
  const { io, output, login } = fixture({ env: { ...env, FACTS_TOTP_SECRET: 'invalid!' } });
  expect(await main(['token'], io)).toBe(1);
  expect(output.stdout).toBe('');
  expect(output.stderr).toMatch(/^FACTS_CONFIG: Invalid FACTS_TOTP_SECRET:/);
  expect(login).not.toHaveBeenCalled();
});

test('FactsError prints only code and message, with no cause or stack, and never retries', async () => {
  const { io, output, login } = fixture();
  login.mockRejectedValue(new FactsError('FACTS_LOGIN_REQUIRED', 'Credentials or code rejected.', {
    cause: new Error('sensitive cause'),
  }));
  expect(await main(['token'], io)).toBe(1);
  expect(output).toEqual({ stdout: '', stderr: 'FACTS_LOGIN_REQUIRED: Credentials or code rejected.\n' });
  expect(login).toHaveBeenCalledTimes(1);
});

test('unexpected failures do not disclose exception messages or stacks', async () => {
  const { io, output, login } = fixture();
  login.mockRejectedValue(new Error('sensitive exception'));
  expect(await main(['token'], io)).toBe(1);
  expect(output).toEqual({ stdout: '', stderr: 'FACTS_LOGIN_FAILED: FACTS login failed.\n' });
  expect(login).toHaveBeenCalledTimes(1);
});

test('cancelled input fails with FACTS_CONFIG before login', async () => {
  const { io, output, prompt, login } = fixture({ env: {}, isTTY: true });
  prompt.mockRejectedValue(new FactsError('FACTS_CONFIG', 'Input cancelled.'));
  expect(await main(['token'], io)).toBe(1);
  expect(output).toEqual({ stdout: '', stderr: 'FACTS_CONFIG: Input cancelled.\n' });
  expect(login).not.toHaveBeenCalled();
});

test.each([[], ['--help'], ['-h'], ['token', '--help'], ['config', '-h']])('help (%j) prints usage to stderr without login', async (...argv) => {
  const { io, output, prompt, login } = fixture({ env: {} });
  expect(await main(argv, io)).toBe(0);
  expect(output.stdout).toBe('');
  expect(output.stderr).toMatch(/^Usage: facts-checker/);
  expect(prompt).not.toHaveBeenCalled();
  expect(login).not.toHaveBeenCalled();
});

test.each([
  ['unknown'], ['token', '--unknown'], ['config', '--json'], ['--json'], ['token', 'extra'],
  ['token', '--json=true'], ['unknown', '--help'],
])('invalid arguments (%j) print usage to stderr and exit 2', async (...argv) => {
  const { io, output, prompt, login } = fixture({ env: {} });
  expect(await main(argv, io)).toBe(2);
  expect(output.stdout).toBe('');
  expect(output.stderr).toMatch(/^Usage: facts-checker/);
  expect(prompt).not.toHaveBeenCalled();
  expect(login).not.toHaveBeenCalled();
});

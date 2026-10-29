#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { login, resolveLogin, type LoginOptions } from './auth.js';
import { API_BASE, FACTS_OAUTH } from './config.js';
import { FactsError } from './errors.js';
import type { OtpRequest } from './types.js';

const usage = `Usage: facts-checker <command>

Commands:
  token [--json]  Log in once and print a refresh token (or token JSON)
  config         Print OAuth and API configuration as JSON without logging in

Options:
  -h, --help     Show this help

Uses FACTS_DISTRICT, FACTS_USERNAME, FACTS_PASSWORD and FACTS_TOTP_SECRET.
Missing values are prompted for on a terminal; inputs are not echoed.
Token output contains live credentials. Treat refresh tokens like passwords.
`;

export interface CliIO {
  stdout: { write(text: string): unknown };
  stderr: { write(text: string): unknown };
  env: Record<string, string | undefined>;
  isTTY: boolean;
  /** Writes the question to stderr and reads an answer without echoing input. */
  prompt(question: string): Promise<string>;
  login: typeof login;
}

function otpQuestion(request: OtpRequest): string {
  switch (request.type) {
    case 'authenticator': return 'Authenticator code: ';
    case 'email': return 'Email verification code: ';
    case 'email-destination':
      return `Choose an email destination:\n${request.options.map((address, index) => `  ${index + 1}. ${address}`).join('\n')}\nEmail destination (address or number): `;
  }
}

/** Runs one command without reading files or changing the supplied environment. */
export async function main(argv: string[], io: CliIO): Promise<0 | 1 | 2> {
  let command: string | undefined;
  let json: boolean | undefined;
  let help: boolean | undefined;
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      options: { json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } },
      allowPositionals: true,
      strict: true,
    });
    [command] = positionals;
    ({ json, help } = values);
    if (positionals.length > 1 || (command !== undefined && command !== 'token' && command !== 'config') || (json && command !== 'token')) {
      io.stderr.write(usage);
      return 2;
    }
  } catch {
    io.stderr.write(usage);
    return 2;
  }

  if (help || !command) {
    io.stderr.write(usage);
    return 0;
  }
  if (command === 'config') {
    io.stdout.write(`${JSON.stringify({ oauth: FACTS_OAUTH, apiBase: API_BASE })}\n`);
    return 0;
  }

  try {
    const options: LoginOptions = {
      env: io.env,
      onProgress: message => { io.stderr.write(`${message}\n`); },
    };
    if (io.isTTY) {
      if (!io.env.FACTS_DISTRICT) options.district = await io.prompt('FACTS district: ');
      if (!io.env.FACTS_USERNAME) options.username = await io.prompt('FACTS username: ');
      if (!io.env.FACTS_PASSWORD) options.password = await io.prompt('FACTS password: ');
      if (!io.env.FACTS_TOTP_SECRET) {
        options.totpSecret = await io.prompt('Authenticator secret (leave blank to enter MFA codes): ');
      }
      options.otp = request => io.prompt(otpQuestion(request));
    }
    // Validate before calling the injected login, with the same errors as the auth API.
    resolveLogin(options);
    const tokens = await io.login(options);
    io.stdout.write(json
      ? `${JSON.stringify({ refreshToken: tokens.refreshToken, accessToken: tokens.accessToken, expiresAt: new Date(tokens.expiresAt).toISOString(), oauth: FACTS_OAUTH, apiBase: API_BASE })}\n`
      : `${tokens.refreshToken}\n`);
    return 0;
  } catch (cause) {
    const error = cause instanceof FactsError ? cause : new FactsError('FACTS_LOGIN_FAILED', 'FACTS login failed.');
    io.stderr.write(`${error.code}: ${error.message}\n`);
    return 1;
  }
}

async function prompt(question: string): Promise<string> {
  // Readline still handles editing and restores the terminal on close, but its
  // output is discarded so no typed or pasted input reaches either output stream.
  const muted = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const reader = createInterface({ input: process.stdin, output: muted, terminal: true });
  try {
    process.stderr.write(question);
    return await new Promise<string>((resolve, reject) => {
      reader.once('SIGINT', () => { reader.close(); });
      reader.once('close', () => { reject(new FactsError('FACTS_CONFIG', 'Input cancelled.')); });
      reader.question('', resolve);
    });
  } finally {
    reader.close();
    muted.destroy();
    process.stderr.write('\n');
  }
}

// Resolve npm's bin symlink too; importing main in tests must never start a login.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2), {
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env,
    isTTY: !!process.stdin.isTTY,
    prompt,
    login,
  });
}

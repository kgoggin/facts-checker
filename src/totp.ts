import { createHmac } from 'node:crypto';

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const PERIOD = 30;

/** Accepts a base32 secret or an `otpauth://` URI, as exported by authenticator apps. */
export function parseTotpSecret(input: string): Buffer {
  let secret = input.trim();
  if (/^otpauth:/i.test(secret)) {
    const uri = new URL(secret);
    const algorithm = uri.searchParams.get('algorithm');
    if ((algorithm && algorithm.toUpperCase() !== 'SHA1') || (uri.searchParams.get('digits') ?? '6') !== '6'
      || (uri.searchParams.get('period') ?? '30') !== '30') throw new Error('Only SHA1, 6-digit, 30-second TOTP secrets are supported.');
    secret = uri.searchParams.get('secret') ?? '';
  }
  const chars = secret.toUpperCase().replace(/[\s=-]/g, '');
  if (!chars || [...chars].some(char => !BASE32.includes(char))) throw new Error('TOTP secret is not valid base32.');
  let bits = 0, value = 0;
  const bytes: number[] = [];
  for (const char of chars) {
    value = (value << 5) | BASE32.indexOf(char);
    bits += 5;
    if (bits >= 8) { bytes.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(bytes);
}

/** RFC 6238 TOTP (SHA1, 6 digits, 30 seconds). */
export function totp(secret: Buffer, now = Date.now()): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 1000 / PERIOD)));
  const hmac = createHmac('sha1', secret).update(counter).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  return String((hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

/** Waits out the end of a window so a code is not rejected in transit; FACTS logins never retry an OTP. */
export async function freshTotp(secret: Buffer, minRemainingMs = 5_000): Promise<string> {
  const remaining = PERIOD * 1000 - (Date.now() % (PERIOD * 1000));
  if (remaining < minRemainingMs) await new Promise(resolve => setTimeout(resolve, remaining + 50));
  return totp(secret);
}

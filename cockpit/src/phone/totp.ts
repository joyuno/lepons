import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * RFC 6238 TOTP, the code an Authenticator app shows: HMAC-SHA1 over the
 * 30-second step count, cut to six digits. The parameters are the ones every
 * app assumes when an otpauth URI leaves them out, so nothing here is
 * configurable -- a different choice would only make some apps disagree.
 */
const STEP_SECONDS = 30;

const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += alphabet[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[\s=]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = alphabet.indexOf(char);
    if (index < 0) throw new Error("not base32");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** 160 bits, the HMAC-SHA1 key length RFC 4226 recommends. */
export function newTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function totpAt(secret: string, step: number, digits = 6): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac("sha1", base32Decode(secret)).update(counter).digest();
  const offset = mac[mac.length - 1]! & 15;
  const code = (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits;
  return String(code).padStart(digits, "0");
}

export function stepOf(nowMs: number): number {
  return Math.floor(nowMs / 1000 / STEP_SECONDS);
}

/**
 * The step a code matched, allowing one step either side for a phone clock
 * that is a little off; undefined when it matches none. The caller keeps the
 * last step used, so the same code cannot be replayed within its window.
 */
export function matchTotp(secret: string, code: string, nowMs: number): number | undefined {
  if (!/^\d{6}$/.test(code)) return undefined;
  const now = stepOf(nowMs);
  // Constant time, and all three compared whichever matches, so timing
  // says nothing about how close a guess came.
  let matched: number | undefined;
  for (const step of [now - 1, now, now + 1]) {
    if (timingSafeEqual(Buffer.from(totpAt(secret, step)), Buffer.from(code)) && matched === undefined) matched = step;
  }
  return matched;
}

/** What the Authenticator app scans. */
export function otpauthUri(secret: string, account: string): string {
  const label = encodeURIComponent(`Lepons:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=Lepons&algorithm=SHA1&digits=6&period=${STEP_SECONDS}`;
}

import { randomBytes, timingSafeEqual } from "node:crypto";

/**
 * The tunnel puts this endpoint on the node's loopback, which is not a private
 * channel: anyone logged into that node can reach it. The token is therefore
 * the only thing separating "the agent we opened this for" from "any process
 * on that machine".
 */
export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Extracts the credential from `Authorization: Bearer <token>`. */
export function bearerFrom(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const match = /^Bearer[ ]+(\S+)$/.exec(header.trim());
  return match?.[1];
}

/**
 * Compares in constant time.
 *
 * A plain `===` leaks the length of the shared prefix through timing, which
 * over a loopback socket is a comfortable signal to measure.
 */
export function tokenMatches(provided: string | undefined, expected: string): boolean {
  if (provided === undefined) return false;
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) {
    // Still compare, so a wrong length costs the same as a wrong byte.
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

export function authorize(header: string | undefined, expected: string): boolean {
  return tokenMatches(bearerFrom(header), expected);
}

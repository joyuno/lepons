import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt) as (password: string, salt: Buffer, length: number) => Promise<Buffer>;

/** `scrypt$<salt>$<hash>`, both base64url; the password itself is never kept. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, 32);
  return `scrypt$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

export async function passwordMatches(password: string, stored: string): Promise<boolean> {
  const [kind, salt, hash] = stored.split("$");
  if (kind !== "scrypt" || salt === undefined || hash === undefined) return false;
  const expected = Buffer.from(hash, "base64url");
  const actual = await scryptAsync(password, Buffer.from(salt, "base64url"), expected.length);
  return timingSafeEqual(actual, expected);
}

const MAX_FAILURES = 5;
const LOCKOUT_MS = 15 * 60_000;
/**
 * A day from sign-in, with no idle limit -- the user's call, once a day: the API
 * is reachable only from the paired phone app and behind password + TOTP, and
 * signing in again on the subway was the cost they would not pay. The
 * desktop's "끊기" still ends every phone's sign-in at once.
 */
export const SESSION_MS = 24 * 60 * 60_000;

const digest = (token: string) => createHash("sha256").update(token).digest("hex");

/**
 * Who is signed in from a phone, and how many wrong tries there have been.
 *
 * One lockout for everyone rather than per device: there is one operator.
 * Sessions are keyed by the cookie's sha256 -- only that is kept, so nothing
 * held here or on disk can be replayed as a cookie. `saved`/`save` carry them
 * across a restart: an update restarts Lepons, and signing the phone out each
 * time made the 10 h sign-in mean little. The clock is passed in so the
 * expiries can be tested without waiting for them.
 */
export class PhoneAuth {
  #failures = 0;
  #lockedUntil = 0;
  #lastStep = -1;
  readonly #sessions: Map<string, { created: number }>;
  readonly #save: (sessions: Record<string, number>) => void;

  constructor(saved: Record<string, number> = {}, save: (sessions: Record<string, number>) => void = () => {}) {
    this.#sessions = new Map(Object.entries(saved).map(([key, created]) => [key, { created }]));
    this.#save = save;
  }

  #changed(): void {
    this.#save(Object.fromEntries([...this.#sessions].map(([key, { created }]) => [key, created])));
  }

  locked(now: number): boolean {
    return now < this.#lockedUntil;
  }

  /** A wrong password or code. The fifth in a row locks sign-in for 15 minutes. */
  failed(now: number): void {
    this.#failures += 1;
    if (this.#failures >= MAX_FAILURES) {
      this.#failures = 0;
      this.#lockedUntil = now + LOCKOUT_MS;
    }
  }

  /**
   * Whether a matched TOTP step is new. A code seen once is spent, so one
   * read over a shoulder cannot be typed in again inside its 90 seconds.
   */
  freshStep(step: number): boolean {
    return step > this.#lastStep;
  }

  /** Signs a phone in; the returned token goes in the cookie and nowhere else. */
  open(now: number, step: number): string {
    this.#failures = 0;
    this.#lastStep = step;
    const token = randomBytes(32).toString("base64url");
    this.#sessions.set(digest(token), { created: now });
    this.#changed();
    return token;
  }

  /** True for a sign-in younger than SESSION_MS. */
  check(token: string | undefined, now: number): boolean {
    if (!token) return false;
    const key = digest(token);
    const session = this.#sessions.get(key);
    if (!session) return false;
    if (now - session.created >= SESSION_MS) {
      this.#sessions.delete(key);
      return false;
    }
    return true;
  }

  close(token: string | undefined): void {
    if (token && this.#sessions.delete(digest(token))) this.#changed();
  }

  closeAll(): void {
    this.#sessions.clear();
    this.#changed();
  }

  /** Live sessions, dropping the expired ones on the way. */
  count(now: number): number {
    for (const [key, session] of this.#sessions) {
      if (now - session.created >= SESSION_MS) this.#sessions.delete(key);
    }
    return this.#sessions.size;
  }

  /** For the tests: what the server holds. */
  storedKeys(): string[] {
    return [...this.#sessions.keys()];
  }
}

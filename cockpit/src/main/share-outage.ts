/** A share that was up and went down, while Lepons puts it back. */
export interface Outage {
  since: number;
  attempts: number;
  reason?: string;
  /** Whether the operator has been told, which happens once per outage. */
  told: boolean;
}

// Retrying these only repeats the refusal -- and a failed login every
// minute is what gets an address banned by fail2ban.
const hopeless = new Set(["auth_failed", "host_key_unknown", "host_key_changed", "forward_denied"]);

/** Past a network hiccup: worth a popup, not before. */
export const tellAfterMs = 90_000;

/**
 * Counts one failed try at putting a share back: whether to try again, and
 * whether this is the moment to tell the operator -- once it has lasted
 * past a hiccup, or at once when waiting cannot fix it. Only while
 * `visible`, meaning a session on that machine is connected: a machine that
 * is simply off is retried quietly, and the telling waits for it.
 */
export function failedTry(
  outage: Outage,
  reason: string | undefined,
  now: number,
  visible: boolean,
): { retry: boolean; tell: boolean } {
  outage.attempts += 1;
  if (reason) outage.reason = reason;
  const retry = reason === undefined || !hopeless.has(reason);
  const tell = visible && !outage.told && (!retry || now - outage.since >= tellAfterMs);
  if (tell) outage.told = true;
  return { retry, tell };
}

/**
 * Which of the named tmux sessions are older than a share's current tunnel,
 * from `tmux list-sessions -F '#{session_name} #{session_created}'` followed
 * by an `@now <epoch>` line. A tmux session lives exactly as long as the
 * agent it was started with, so its age is the agent's -- and one older than
 * the tunnel had its lepons server go away under it. Both times come from
 * the machine's clock and the tunnel's age from this one's, so the two
 * clocks never have to agree.
 */
export function olderThanTunnel(listing: string, names: string[], tunnelAgeSeconds: number): string[] {
  const created = new Map<string, number>();
  for (const line of listing.split("\n")) {
    const [name, value, extra] = line.trim().split(/\s+/);
    if (name && value && extra === undefined && /^\d+$/.test(value)) created.set(name, Number(value));
  }
  const now = created.get("@now");
  if (now === undefined) return [];
  // A few seconds of slack: a session made in the same breath as the tunnel
  // is not older than it.
  return names.filter((name) => {
    const born = created.get(name);
    return born !== undefined && now - born > tunnelAgeSeconds + 5;
  });
}

/**
 * Joins a call to the one already running for the same key instead of
 * starting a second. Opening a share twice at once opened two endpoints and
 * two tunnels, and only one of them was ever closed.
 */
export function joinRunning<T>(running: Map<string, Promise<T>>, key: string, start: () => Promise<T>): Promise<T> {
  const current = running.get(key);
  if (current) return current;
  const attempt = start().finally(() => running.delete(key));
  running.set(key, attempt);
  return attempt;
}

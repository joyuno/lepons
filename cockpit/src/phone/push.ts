/**
 * The "waiting" push. Main calls newlyWaiting on every session snapshot
 * (the phoneSnapshot handler) and sends what it returns through Expo's push
 * service to the paired phone app. Content-free: the PC's name and the
 * opaque session id the tap opens -- never agent output, since the push
 * travels through Expo's, Google's or Apple's servers.
 */

/** Sessions that turned to waiting between two snapshots: the push's one trigger. */
export function newlyWaiting<T extends { key: string; mood: string }>(before: readonly T[], now: readonly T[]): T[] {
  const was = new Map(before.map((session) => [session.key, session.mood]));
  return now.filter((session) => session.mood === "waiting" && was.get(session.key) !== "waiting");
}

export const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";

/** An Expo push token as getExpoPushTokenAsync gives it: printable ASCII, no brackets inside, 200 at most. */
export const validPushToken = (value: unknown): value is string =>
  typeof value === "string" && value.length <= 200 && /^Expo(?:nent)?PushToken\[[\x21-\x5a\x5c\x5e-\x7e]+\]$/.test(value);

interface Pushed { key: string; mood: string; turn?: "starting" | "finished" }

/** Doing work: connecting reads as working on every surface, and is not. */
const busy = (session: Pushed) => session.mood === "working" && session.turn !== "starting";

/**
 * All work over: some session was working, none is now, and every one that was
 * is still there and finished (its record said so) or waiting. A session that
 * failed, was stopped or went away (closed, the PC locked) did not finish.
 */
export function allDone(before: readonly Pushed[], now: readonly Pushed[]): boolean {
  const was = before.filter(busy).map((session) => session.key);
  if (was.length === 0 || now.some(busy)) return false;
  const after = new Map(now.map((session) => [session.key, session]));
  return was.every((key) => after.get(key)?.turn === "finished" || after.get(key)?.mood === "waiting");
}

/**
 * What one new snapshot pushes. A session waiting for an answer is not "all
 * done": its waiting push says more, and the two would race for the one
 * lock-screen slot.
 */
export function snapshotPushes(before: readonly Pushed[], now: readonly Pushed[]): { done: boolean; waiting: boolean } {
  return {
    done: allDone(before, now) && !now.some((session) => session.mood === "waiting"),
    waiting: newlyWaiting(before, now).length > 0,
  };
}

/** A push that waited longer than this (phone off) is stale: Expo drops it. */
const TTL_S = 3600;

/**
 * One Lepons notification on the lock screen: each push replaces the last
 * (collapseId on iOS, tag on Android -- Expo's message fields for it).
 */
const one = { collapseId: "lepons", tag: "lepons" } as const;

/** A waiting push: one session's id opens it; none (several waiting) opens the sessions tab. */
export function waitingPush(to: string, body: string, session?: string) {
  return {
    to, title: "Lepons", body, data: session === undefined ? { open: "sessions" } : { session },
    channelId: "waiting", sound: "default", priority: "high", interruptionLevel: "time-sensitive", ttl: TTL_S, ...one,
  };
}

/** "All done": quiet -- passive on iOS, the silent "done" channel on Android. */
export function donePush(to: string, body: string) {
  return { to, title: "Lepons", body, data: { open: "sessions" }, channelId: "done", interruptionLevel: "passive", ttl: TTL_S, ...one };
}

export const COALESCE_MS = 60_000;
/** While someone is looking, how often to see whether they left with a question unanswered. */
export const LOOK_AGAIN_MS = 15_000;
export interface Waiting { pc: string | undefined; session: string }

/**
 * Waiting pushes, coalesced: the first turn goes out at once; a turn within
 * 60 s of the last push is held, and one push for whatever is still waiting
 * goes out when the 60 s are up. Nothing while the person is looking; if they
 * leave with it unanswered, it goes then: a turn is the only trigger there is,
 * and an app closed a moment after the question must not lose it.
 * Returns what main calls on each turn to waiting.
 */
export function pushGate(deps: {
  now(): number;
  later(run: () => void, ms: number): void;
  looking(): boolean;
  /** Every session waiting right now. */
  waiting(): Waiting[];
  send(waiting: Waiting[]): void;
}): () => void {
  let sentAt = -Infinity;
  let held = false;
  const flush = () => {
    held = false;
    const list = deps.waiting();
    if (list.length === 0) return;
    if (deps.looking()) {
      held = true;
      deps.later(flush, LOOK_AGAIN_MS);
      return;
    }
    sentAt = deps.now();
    deps.send(list);
  };
  return () => {
    if (held) return;
    const wait = sentAt + COALESCE_MS - deps.now();
    if (wait <= 0) flush();
    else {
      held = true;
      deps.later(flush, wait);
    }
  };
}

/** Expo's reply naming the token gone for good (one ticket, or an array of them). */
export const pushTokenGone = (reply: unknown): boolean =>
  [(reply as { data?: unknown } | null)?.data].flat().some((ticket) => (ticket as { details?: { error?: unknown } } | null)?.details?.error === "DeviceNotRegistered");

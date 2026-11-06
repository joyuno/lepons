/**
 * produck, the pet in the window's corner: one duck for every session, showing
 * the one that most needs the operator. Whether a session is busy is read from
 * its output -- an agent working redraws its spinner many times a second -- so
 * it works the same for every agent, on this PC or another. What a quiet means
 * is asked of the session's record once (workflow/turn.ts), where it keeps one.
 */

import type { TurnEnd } from "../shared/status.ts";

export type PetMood = "idle" | "working" | "waiting" | "connecting" | "done" | "error" | "sleeping" | "delegate";

/** Output with gaps shorter than this is one burst. */
const BURST_GAP_MS = 1500;
/** A burst this long is work, not the echo of a keystroke or a redraw. */
const WORK_MS = 2500;
/** Quiet this long after work: the agent is done, or asking; its record is asked which. */
const QUIET_MS = 3000;
const DONE_MS = 2500;
const ERROR_MS = 10_000;
const DELEGATE_MS = 3000;
const SLEEP_MS = 10 * 60_000;
/**
 * Codex's own word that it wants an approval. It keeps redrawing its title while
 * it does, so it never goes quiet, and the request is not in its record
 * (measured: Codex 0.166, 1 chunk a second, for as long as the prompt stands).
 */
const BLOCKED = "\x1b]7501;state=blocked";

export interface Activity {
  burstStart: number;
  lastOutput: number;
  working: boolean;
  /** When the work began. */
  workSince: number;
  /** Turned to the operator, who has not answered yet. */
  waiting: boolean;
  /** Its last turn ended finished, and no work has begun since. */
  finished: boolean;
  /** The output the record was last asked about. */
  asked?: number;
  doneAt?: number;
  /** The numbered menu on its screen now, as words: the same one turns to the operator once. */
  menu?: string;
  /** Main is sure its AI has left its terminal (session/agent-life.ts). */
  agentGone?: boolean;
}

export function newActivity(): Activity {
  return { burstStart: 0, lastOutput: 0, working: false, workSince: 0, waiting: false, finished: false };
}

/** Output arrived. True when it says this session has just turned to the operator. */
export function onOutput(activity: Activity, now: number, chunk = ""): boolean {
  if (now - activity.lastOutput > BURST_GAP_MS) activity.burstStart = now;
  activity.lastOutput = now;
  if (!activity.working && now - activity.burstStart >= WORK_MS) {
    activity.working = true;
    activity.workSince = activity.burstStart;
    activity.finished = false;
  }
  if (!chunk.includes(BLOCKED)) return false;
  activity.waiting = true;
  activity.finished = false;
  activity.doneAt = now;
  return true;
}

/**
 * What the screen shows, once its output has paused: the labels of the numbered
 * menu on it, or none. A menu is the agent asking, at once and however short the
 * work before it was, which the rhythm below cannot tell. True when one has just come up.
 */
export function onMenu(activity: Activity, menu: string | undefined, now: number): boolean {
  const fresh = menu !== undefined && menu !== activity.menu;
  activity.menu = menu;
  if (!fresh) return false;
  activity.working = false;
  activity.waiting = true;
  activity.finished = false;
  activity.doneAt = now;
  return true;
}

/** The clock moved on. True when work has just gone quiet: ask its record, once. */
export function onTick(activity: Activity, now: number): boolean {
  if (!activity.working || activity.asked === activity.lastOutput || now - activity.lastOutput < QUIET_MS) return false;
  activity.asked = activity.lastOutput;
  return true;
}

/**
 * The record's answer about the quiet that fell at `asked` (activity.lastOutput
 * then), dropped if output has come since: that quiet is over. True when this
 * session has just finished or turned to the operator.
 */
export function onTurnEnd(activity: Activity, end: TurnEnd, asked: number, now: number): boolean {
  // ponytail: "busy" is only asked again after more output; a process that hangs silently stays working.
  if (asked !== activity.lastOutput || !activity.working || end === "busy") return false;
  activity.working = false;
  if (end === "stopped" || end === "quiet") return false;
  activity.finished = end === "finished";
  // Waiting, and with it every alert, is a menu on the screen (onMenu) or Codex's own word (onOutput):
  // the owner's call. A question in plain words, a silent tool or a guess from rhythm is not one.
  if (activity.finished) activity.waiting = false;
  activity.doneAt = now;
  return true;
}

export interface PetSession {
  key: string;
  state: "connecting" | "ready" | "closed";
  activity: Activity;
  /** When it closed for a reason other than being asked to. */
  failedAt?: number;
}

/** Which session the duck stands for, and how. Most urgent first. */
export function petMood(sessions: PetSession[], now: number, delegatedAt = -Infinity): { mood: PetMood; key?: string } {
  const pick = (mood: PetMood, test: (s: PetSession) => boolean) => {
    const found = sessions.find(test);
    return found ? { mood, key: found.key } : undefined;
  };
  return (
    (now - delegatedAt < DELEGATE_MS ? { mood: "delegate" as const } : undefined) ??
    // A turn that ended well: one that turned to the operator goes straight to waiting.
    pick("done", (s) => s.activity.finished && s.activity.doneAt !== undefined && now - s.activity.doneAt < DONE_MS) ??
    pick("waiting", (s) => s.state === "ready" && s.activity.waiting) ??
    pick("error", (s) => s.failedAt !== undefined && now - s.failedAt < ERROR_MS) ??
    pick("working", (s) => s.state === "ready" && s.activity.working) ??
    pick("connecting", (s) => s.state === "connecting") ??
    pick("idle", (s) => s.state === "ready" && now - s.activity.lastOutput < SLEEP_MS) ??
    { mood: "sleeping" }
  );
}

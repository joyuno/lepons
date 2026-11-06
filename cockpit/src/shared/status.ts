import type { SessionCloseReason, SessionState } from "../session/state.ts";

/*
 * The one place a session or PC state becomes a word and a colour: the rail,
 * pane heads, the workflow board and the phone all read it from here.
 */

/** A session's word: working (green, breathing), waiting (amber), done (green), failed (red), idle (grey), or shellOnly (a hollow grey ring): its terminal is up and its AI has gone. */
export type SessionStatus = "working" | "waiting" | "done" | "failed" | "idle" | "shellOnly";

const calm: SessionCloseReason[] = ["closed_by_user", "idle_closed"];

/**
 * How a quiet session's turn ended, read from its record (workflow/turn.ts):
 * finished, asking the operator (waiting), stopped by them, still on it (busy),
 * no work behind the quiet at all (quiet), or the record cannot say (unknown,
 * which is output rhythm's guess: the operator's turn).
 */
export type TurnEnd = "finished" | "waiting" | "stopped" | "busy" | "quiet" | "unknown";

/**
 * A session's status from its state and activity (renderer/pet.ts). Waiting is
 * "turned to the operator, not looked at yet"; any other quiet ready session is
 * done, whether it finished work or never had any: turnMark tells those apart.
 * `agentGone` comes from main (session/agent-life.ts), and only when it is sure.
 */
export function sessionStatus(state: SessionState | undefined, activity: { working: boolean; waiting: boolean; agentGone?: boolean }): SessionStatus {
  if (!state) return "idle";
  if (state.kind === "connecting") return "working";
  if (state.kind === "closed") return calm.includes(state.reason) ? "idle" : "failed";
  if (activity.agentGone) return "shellOnly";
  if (activity.waiting) return "waiting";
  return activity.working ? "working" : "done";
}

/** What the "all done" push needs beyond the status word: connecting is no work, and only a finished turn counts as finished. */
export function turnMark(state: SessionState | undefined, activity: { finished: boolean }): "starting" | "finished" | undefined {
  if (state?.kind === "connecting") return "starting";
  return state?.kind === "ready" && activity.finished ? "finished" : undefined;
}

/** A PC's word: live (green), connecting (amber, breathing), failed (red), off (grey). */
export type PcState = "live" | "connecting" | "failed" | "off";

/** A PC's state from its sessions' states and whether its share is down. */
export function pcState(states: SessionState[], outage: boolean): PcState {
  const ready = states.some((s) => s.kind === "ready");
  if (states.some((s) => s.kind === "connecting") || (outage && ready)) return "connecting";
  if (ready) return "live";
  if (outage || states.some((s) => sessionStatus(s, { working: false, waiting: false }) === "failed")) return "failed";
  return "off";
}

/** Why a PC failed: its first failed session's reason, else its share's last one. */
export function pcFailReason(states: SessionState[], outage: { reason?: string } | undefined): string | undefined {
  const failed = states.find((s) => sessionStatus(s, { working: false, waiting: false }) === "failed");
  return failed?.kind === "closed" ? failed.reason : outage?.reason;
}

/** Sessions whose turn just ended: working at the last look, waiting, done or idle now. */
export function turnsEnded(before: ReadonlyMap<string, string>, now: Iterable<{ key: string; mood: SessionStatus }>): string[] {
  return [...now].filter((s) => before.get(s.key) === "working" && (s.mood === "waiting" || s.mood === "done" || s.mood === "idle")).map((s) => s.key);
}

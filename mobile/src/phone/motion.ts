import type { Mood, PcState } from "./types.ts";

/**
 * The phone's motion rules that can break, as plain functions so they run under
 * node --test. The curve and durations are named in src/motion.tsx.
 */
/** One full round of each endless motion. */
export const period = { working: 2400, typing: 1200, spin: 1000 } as const;

/** Buttons and cards under a finger. */
export const PRESS_SCALE = 0.97;
/** How far the tab badge overshoots. */
export const POP_PEAK = 1.3;

/** Palette keys, so this file stays free of colours. */
export type LampTone = "go" | "live" | "dim" | "stop" | "idle" | "muted";
export interface LampLook {
  tone: LampTone;
  /** Only an outline: the terminal is up, the AI in it has gone. */
  hollow?: boolean;
  /** Dims to `opacity` once a period. Only a working session breathes. */
  pulse?: { period: number; opacity: number };
}

/** Working is green with a very faint breath; everything else holds still. */
export function lampLook(state: Mood | PcState | "shellOnly"): LampLook {
  switch (state) {
    case "working": return { tone: "go", pulse: { period: period.working, opacity: 0.7 } };
    case "waiting": return { tone: "live" };
    case "live": return { tone: "go" };
    case "connecting": return { tone: "live" };
    case "done": return { tone: "dim" };
    case "failed": return { tone: "stop" };
    case "shellOnly": return { tone: "muted", hollow: true };
    default: return { tone: "idle" };
  }
}

/**
 * Up and back within one timing, 0 to 1 to 0. Animated.sequence can't run in a
 * native loop (it hops back to JS each round), so a pulse is one timing with this curve.
 */
export const thereAndBack = (t: number): number => (1 - Math.cos(2 * Math.PI * t)) / 2;

/** A typing dot's opacity over one round: each lights up a little after the one before. */
export function typingStops(dot: number): { inputRange: number[]; outputRange: number[] } {
  const start = 0.05 + dot * 0.2;
  return { inputRange: [0, start, start + 0.25, start + 0.5, 1], outputRange: [0.3, 0.3, 1, 0.3, 0.3] };
}

/** Distance a full-size fill sits from its resting place, to show `fraction` of it. Anything unusable shows empty. */
export function levelOffset(fraction: number, length: number): number {
  const shown = Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0;
  return (1 - shown) * length;
}

/**
 * Whether a chat row fades in: only one newer than the newest already shown. The
 * first load and "show older" stay put (`seen` undefined, older times).
 */
export const isFresh = (at: number, seen: number | undefined): boolean => seen !== undefined && at > seen;

/** The tab badge pops when more sessions wait, not when the count falls. */
export const badgePops = (before: number, after: number): boolean => after > before;

/**
 * For a list that changed order: how far below its new place each row that moved must start (negative: above), to seem
 * to come from where it was. Places come from the rows' heights, since a list reports no place a row merely moved to.
 * A row new to the list has no old place and stays out of it.
 */
export function rowShifts(before: readonly string[], after: readonly string[], height: (id: string) => number | undefined): Map<string, number> {
  const places = (order: readonly string[]) => {
    const at = new Map<string, number>();
    let y = 0;
    for (const id of order) {
      at.set(id, y);
      y += height(id) ?? 0;
    }
    return at;
  };
  const was = places(before);
  const now = places(after);
  const shifts = new Map<string, number>();
  for (const [id, y] of now) {
    const old = was.get(id);
    if (old !== undefined && old !== y) shifts.set(id, old - y);
  }
  return shifts;
}

/**
 * How things move in this app: one curve and three durations (index.html has
 * the same values as --ease and --t-fast/mid/slow). What a rebuilt element
 * cannot get from a CSS transition is played from here. Under reduced motion
 * nothing plays. No DOM until a function that needs it is called: the tests read this.
 */
import type { Direction } from "./workspace.ts";

export const EASE = "cubic-bezier(0.2, 0, 0, 1)";
export const FAST = 120;
export const MID = 220;

export const stillWanted = (): boolean => matchMedia("(prefers-reduced-motion: reduce)").matches;

export function play(target: Element, frames: Keyframe[], ms: number): Animation | undefined {
  return stillWanted() ? undefined : target.animate(frames, { duration: ms, easing: EASE });
}

export interface Box { left: number; top: number; width: number; height: number }

/** The pane a render added and the one it took away; null when that is not one change to show, or no pane stayed to show it. */
export function paneChange(was: string[], now: string[]): { added?: string; gone?: string } | null {
  const added = now.filter((id) => !was.includes(id));
  const gone = was.filter((id) => !now.includes(id));
  if (added.length > 1 || gone.length > 1 || added.length + gone.length === 0) return null;
  if (now.length === added.length) return null;
  return { ...(added[0] ? { added: added[0] } : {}), ...(gone[0] ? { gone: gone[0] } : {}) };
}

/**
 * Where a new pane opens from: no thickness across its split, at the edge the
 * sibling after it started at, or else the far edge of the one before it.
 */
export function openingBox(to: Box, direction: Direction, next?: Box, previous?: Box): Box {
  if (direction === "row") {
    const left = next ? next.left : previous ? previous.left + previous.width : to.left + to.width / 2;
    return { ...to, left, width: 0 };
  }
  const top = next ? next.top : previous ? previous.top + previous.height : to.top + to.height / 2;
  return { ...to, top, height: 0 };
}

/**
 * The line between panes while they move: it runs out from `point` along its
 * length (or back into it, when `growing` is false) as it crosses from `from`
 * to `to`, across the split. `start` and `length` are its span along itself.
 */
export function dividerMove(direction: Direction, from: number, to: number, start: number, length: number, point: number, growing: boolean): { box: Box; frames: Keyframe[] } {
  const at = Math.min(length, Math.max(0, point - start));
  const row = direction === "row";
  const box = row ? { left: to - 1, top: start, width: 2, height: length } : { left: start, top: to - 1, width: length, height: 2 };
  const shut = row ? `inset(${at}px 0px ${length - at}px 0px)` : `inset(0px ${length - at}px 0px ${at}px)`;
  const open = "inset(0px 0px 0px 0px)";
  const away = `translate${row ? "X" : "Y"}(${from - to}px)`;
  const here = `translate${row ? "X" : "Y"}(0px)`;
  return { box, frames: [{ transform: away, clipPath: growing ? shut : open }, { transform: here, clipPath: growing ? open : shut }] };
}

/** How far each row moved, for a list whose order changed; a list only pushed along (a tree opened above) stays as it is. */
export function placeChanges(was: Map<string, number>, now: Map<string, number>): Array<[string, number]> {
  if ([...was.keys()].join() === [...now.keys()].join()) return [];
  return [...now].flatMap(([key, top]): Array<[string, number]> => {
    const from = was.get(key);
    return from === undefined || Math.abs(from - top) < 1 ? [] : [[key, from - top]];
  });
}

/** Which of a battery's cells change: none for one seen for the first time. */
export function cellChanges(was: number | undefined, now: number): { gained: number[]; lost: number[] } {
  const range = (from: number, to: number) => Array.from({ length: Math.max(0, to - from) }, (_, i) => from + i);
  return was === undefined ? { gained: [], lost: [] } : { gained: range(was, now), lost: range(now, was) };
}

import type { WorkflowItem } from "./types.ts";

/** Same row, nothing to draw: a new answer from the PC builds new objects for every row. `fresh` only counts as a row mounts. */
export function sameRow(a: { item: object; labels: readonly string[] }, b: { item: object; labels: readonly string[] }): boolean {
  const before = a.item as Record<string, unknown>;
  const after = b.item as Record<string, unknown>;
  const fields = Object.keys(before);
  return fields.length === Object.keys(after).length && fields.every((field) => before[field] === after[field])
    && a.labels.length === b.labels.length && a.labels.every((label, i) => label === b.labels[i]);
}

/**
 * Where the drawn rows start: the same row until the reader asks for older ones. A window that slid with
 * each new row took the top row away, and everything under it moved up under a reader's eyes. The PC's
 * own window (80 events) bounds what this can grow to. If it drops the row, it dropped everything older
 * too, so all that is left stays drawn: a jump to the newest page took the rows from under the reader.
 */
export function firstDrawn(keys: readonly string[], anchor: string | undefined, page: number): number {
  if (anchor === undefined) return Math.max(0, keys.length - page);
  return Math.max(0, keys.indexOf(anchor));
}

const NEAR_BOTTOM = 60;

/**
 * Whether the chat still follows the newest line. Only the reader moving up leaves the bottom: a keyboard,
 * a taller answer bar or a batch of new rows changes the numbers without moving the page.
 */
export function stillAtBottom(was: boolean, lastY: number, now: { y: number; viewport: number; content: number }): boolean {
  if (now.y + now.viewport >= now.content - NEAR_BOTTOM) return true;
  return was && now.y >= lastY;
}

/** `v` is the PC's name for this very list: absent from a PC older than it. */
export type Flow = { title?: string; events: WorkflowItem[]; v?: string } | null;

/** Chats kept in memory; the app only ever holds these until it is closed. */
const KEPT = 8;
/** A chat this long is asked for again: 26-67 KB is usual, up to 4.8 MB in theory (recent-chat.ts). */
const MAX_CHARS = 1_000_000;

/** The last answer per session, as text too, so one that has not changed draws nothing when the chat opens again. */
export function chatMemory() {
  const kept = new Map<string, { json: string; value: Flow }>();
  return {
    get: (id: string) => kept.get(id),
    set(id: string, json: string, value: Flow) {
      kept.delete(id);
      if (json.length <= MAX_CHARS) kept.set(id, { json, value });
      for (const oldest of kept.keys()) {
        if (kept.size <= KEPT) break;
        kept.delete(oldest);
      }
    },
    clear: () => kept.clear(),
  };
}

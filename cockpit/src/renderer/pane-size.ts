/**
 * How far the panes can be split: until a pane would hold less than a
 * usable terminal, and never past MAX_PANES however large the screen.
 */

export const MAX_PANES = 8;
/** Tabs in one pane; a full pane of the project splits instead. */
export const MAX_TABS = 6;
export const MIN_COLS = 50;
export const MIN_ROWS = 15;

// What of a pane is not terminal, in px, after index.html: borders and the
// slot's padding across, plus xterm's 14px scrollbar; the 24px head and the
// 22px tab row too down. A split around two panes adds its padding, gaps and handle.
const LEAF_ACROSS = 28;
const LEAF_DOWN = 58;
const SPLIT_ALONG = 30;
const SPLIT_ACROSS = 12;

/** Whether a pane of this outer size shows MIN_COLS × MIN_ROWS cells. */
export function paneFits(widthPx: number, heightPx: number, cellW: number, cellH: number): boolean {
  return (widthPx - LEAF_ACROSS) / cellW >= MIN_COLS && (heightPx - LEAF_DOWN) / cellH >= MIN_ROWS;
}

/**
 * Whether this area, split into `parts` equal panes ("row": side by side),
 * still fits each one. Two for a fresh split; more when a pane joins a split
 * that already runs that way. `sharing`: how many panes the area is divided
 * among the other way, for one measured before a pane leaves it.
 */
export function canSplit(widthPx: number, heightPx: number, cellW: number, cellH: number, direction: "row" | "column", parts = 2, sharing = 1): boolean {
  const among = (size: number, count: number) => (size - SPLIT_ALONG * (count - 1)) / count;
  return direction === "row"
    ? paneFits(among(widthPx, parts), among(heightPx, sharing) - SPLIT_ACROSS, cellW, cellH)
    : paneFits(among(widthPx, sharing) - SPLIT_ACROSS, among(heightPx, parts), cellW, cellH);
}

/** Which way to try a new pane first: along the area's longer side ("column" stacks). */
export function splitOrder(widthPx: number, heightPx: number): ["row", "column"] | ["column", "row"] {
  return heightPx > widthPx ? ["column", "row"] : ["row", "column"];
}

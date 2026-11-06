/** A tracking mode without drag reports could not follow a drag handed to the program. */
export function reportsDrags(tracking: string): boolean {
  return tracking === "drag" || tracking === "any";
}

/**
 * xterm can only select what is on its screen. While a program tracks the mouse
 * (tmux, Claude Code's fullscreen view) the text beyond that screen is the
 * program's, so a drag that goes looking for it -- past the top or bottom, or
 * by the wheel -- has to be handed to the program, which can scroll and select it.
 */
export function dragLeavesScreen(tracking: string, y: number, top: number, bottom: number): boolean {
  return reportsDrags(tracking) && (y < top || y >= bottom);
}

/**
 * Where a handed-over drag is reported, held above the last row. That row is
 * tmux's status line: a drag there neither scrolls, nor copies when it ends
 * there. The row above is where tmux keeps scrolling down.
 *
 * ponytail: assumes tmux's default one-line status at the bottom. With `status
 * off` the edge stops scrolling down (the wheel still does); with
 * `status-position top`, releasing above the screen would not copy. Ask tmux
 * for its layout if an operator's configuration ever needs it.
 */
export function reportedY(y: number, top: number, bottom: number, rows: number): number {
  return Math.min(y, bottom - (bottom - top) / rows - 1);
}

/**
 * Beside the press, on its row: tmux ignores a first drag that stays in the
 * pressed cell, and takes the selection's start from the press regardless. More
 * than one cell away, as a mouse event's coordinates are cut to whole pixels.
 */
export function firstDragX(x: number, left: number, right: number, cols: number): number {
  const away = (1.5 * (right - left)) / cols;
  return x < left + (right - left) / 2 ? x + away : x - away;
}

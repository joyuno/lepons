/**
 * The scrollbar of a remote pane whose scrollback lives in tmux (main's tmuxScroll): where its thumb sits for a view,
 * and which view a thumb dragged to a place asks for. `position` is how many lines above the bottom the view is.
 */
export interface TmuxView {
  history: number;
  position: number;
  height: number;
  /** In copy mode (scrolled up, searching), where what is typed goes to tmux, not the agent. */
  inMode?: boolean;
}

/** The thumb on a track `track` px tall; none when there is nothing above the screen to scroll to. */
export function thumbOf(view: TmuxView, track: number, min = 24): { top: number; height: number } | undefined {
  if (view.history <= 0 || track <= 0) return undefined;
  const height = Math.min(track, Math.max(min, track * view.height / (view.history + view.height)));
  const position = Math.max(0, Math.min(view.position, view.history));
  return { top: (track - height) * (1 - position / view.history), height };
}

/** The view a thumb of height `height` with its top at `top` stands for. */
export function positionAt(top: number, view: TmuxView, track: number, height: number): number {
  const room = track - height;
  if (room <= 0 || view.history <= 0) return 0;
  return Math.round(view.history * (1 - Math.max(0, Math.min(top, room)) / room));
}

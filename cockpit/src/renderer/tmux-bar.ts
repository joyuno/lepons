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

/**
 * A line the chat types into a pane, in order: out of tmux's copy mode first when `leave` is given (a remote pane left
 * scrolled up, or holding a drag's selection, takes keys as copy-mode commands: the line was lost there, with no sign),
 * then `type` (chat-view's typeLine), which calls `entered` with how its Enter went. How the line went. `typing` is
 * asked just before the first key: false, the line was taken back while it waited, and nothing is typed. With no
 * `leave` it is asked at once, before this returns (chat-view's sendLine counts on it: a local line is never queued).
 */
export async function chatLine(leave: (() => Promise<boolean>) | undefined, type: (entered: (result: SendResult) => void) => boolean, typing: () => boolean = () => true): Promise<SendResult> {
  if (leave && !(await leave())) return "notSent";
  if (!typing()) return "notSent";
  return new Promise<SendResult>((done) => {
    if (!type(done)) done("notSent");
  });
}

/** A chat line's end: sent with its Enter; nothing typed; or typed into the prompt with its Enter held back (a menu came up). */
export type SendResult = "sent" | "notSent" | "typed";

/**
 * The chat's stop: the CLI's own interrupt key, Esc for both chat AIs -- Claude Code's "esc to interrupt", and Codex
 * 0.172's `tui.keymap.chat.interrupt_turn` default (codex-rs/tui/src/keymap.rs at rust-v0.172.0:
 * `default_bindings![plain(KeyCode::Esc)]`). Out of tmux's copy mode first, as a line is (there Esc only leaves it),
 * and never over a question on screen, read before and again after: its Esc would answer the menu. Only while the
 * CLI's own working line is on screen, read again right before the key ("idle": none, nothing typed): an Esc to a
 * CLI at rest is not a stop (Claude's clear, Codex's backtrack).
 */
export async function chatStop(leave: (() => Promise<boolean>) | undefined, io: { asking(): boolean; working(): boolean; press(key: string): void }): Promise<"stopped" | "asking" | "idle" | "notSent"> {
  if (io.asking()) return "asking";
  if (leave && !(await leave())) return "notSent";
  if (io.asking()) return "asking";
  if (!io.working()) return "idle";
  io.press("\x1b");
  return "stopped";
}

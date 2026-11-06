import { createHash } from "node:crypto";

import { posixQuote } from "./state.ts";

/**
 * A tmux session name that is stable for one (node, repository) pair.
 *
 * Stability is the whole point: reconnecting has to land on the same session,
 * so the name may not depend on anything that varies between runs. The readable
 * prefix is for an operator running `tmux ls` on the node; the digest keeps two
 * repositories with the same basename apart. tmux treats `.` and `:` as session
 * addressing syntax, so neither may survive into the name.
 */
/**
 * The scope a session lives under: one per (node, repository, executor).
 *
 * The executor is part of it because the operator picks it per session, so
 * one repository on one machine can hold a Claude session and a Codex session
 * at the same time. Opening and stopping both go through here so the two can
 * never name the session differently -- a stop aimed at a name nothing was
 * created under is a stop that silently does nothing.
 */
export function tmuxScope(key: string, agent: string): string {
  return `${key}::${agent}`;
}

/** Ends that session on the node. Nothing else closes a tmux-wrapped agent. */
export function tmuxKillCommand(key: string, agent: string): string {
  return `tmux kill-session -t ${posixQuote(tmuxSessionName(tmuxScope(key, agent)))}`;
}

export function tmuxSessionName(scope: string): string {
  const digest = createHash("sha256").update(scope).digest("hex").slice(0, 8);
  const readable = (scope.split(/[\\/]/).filter(Boolean).at(-1) ?? "shell")
    .replace(/[^A-Za-z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 24);
  return `lepons-${readable || "shell"}-${digest}`;
}

/**
 * One pass over this node's tmux sessions before attaching, killing two kinds:
 *
 * - The session about to be attached to, if it has sat idle (no keystroke or
 *   output, per tmux's own activity clock) past the resume window. Otherwise
 *   `new-session -A` below would resume it however long ago it was left, and
 *   the agent's conversation would carry every earlier sitting's turns until
 *   it compacts far sooner than one sitting explains. 2 hours is the same
 *   "stepped away" line the lock-screen handling draws; a long silent build
 *   is reset with it, which an explicit restart is for.
 * - Any other `lepons-` session idle past 24 hours: a forgotten `/exit`
 *   otherwise leaves an agent running there forever, since nothing else ever
 *   closes a tmux-wrapped session.
 *
 * Only `lepons-` sessions are touched, so other tmux work on a shared server
 * is left alone. Piggybacked on this connect rather than a timer: it runs
 * once, right before the attach. It was two separate list-and-filter passes,
 * which doubled the line typed into every remote shell.
 */
export function sessionSweep(currentSession: string, resumeWindowSeconds: number): string {
  return (
    "tmux ls -F '#{session_name} #{session_activity}' 2>/dev/null | " +
    `awk -v now="$(date +%s)" -v cur=${posixQuote(currentSession)} -v w=${resumeWindowSeconds} ` +
    "'$1 ~ /^lepons-/ && now - $2 > ($1 == cur ? w : 86400) {print $1}' | " +
    'while read -r s; do tmux kill-session -t "$s"; done'
  );
}

/** 2h, matching the "operator stepped away" grace period used elsewhere. */
export const RESUME_WINDOW_SECONDS = 2 * 60 * 60;

/**
 * Wraps the session so the work outlives the connection.
 *
 * `new-session -A` attaches when the session already exists and creates it
 * otherwise, which makes reconnecting genuinely resume rather than restart --
 * unless `sessionSweep` above has just killed it for sitting idle too
 * long, in which case this creates fresh. When it attaches, tmux ignores the
 * start directory and the command, and that is correct: the session is
 * already where the operator left it.
 */
export function tmuxCommand(
  sessionName: string,
  cwd: string | undefined,
  command: string | undefined,
): string {
  // The options come first, and `start-server` before them, so there is a
  // server to set them on when this is the first session on the node. Order
  // matters for history: a pane takes the limit in force when it is created,
  // so setting it after new-session would leave this very pane at the default.
  //
  // Mouse mode is what makes the wheel scroll at all. tmux runs in the outer
  // terminal's alternate screen and owns the scrollback, so the terminal's own
  // buffer stays empty however large it is -- without this the operator simply
  // cannot look back at what the agent said. The cost is that tmux takes the
  // mouse, so selecting text to copy needs Shift held; accepted deliberately,
  // scrolling being the thing that was entirely missing.
  //
  // set-clipboard passes an agent's OSC 52 copy (Claude Code's "c to copy")
  // out to the cockpit. A drag selection copies the screen tmux drew, which
  // hard-wraps a long URL and keeps stale cells beside it -- a login URL
  // copied that way does not work. A drag scrolled past the screen is tmux's
  // to copy and reaches the clipboard the same way. -q: an old tmux without it
  // must not stop the attach.
  //
  // window-size latest: with a second client still attached (another PC, a
  // dropped connection), tmux before 3.1 sizes the window to the smallest
  // one. The agent then draws narrower than this terminal, and the cells to
  // its right keep old output that a drag selection copies along with a URL.
  const parts = [
    "tmux",
    "start-server",
    "\\;",
    "set",
    "-g",
    "mouse",
    "on",
    "\\;",
    "set",
    "-g",
    "history-limit",
    "20000",
    "\\;",
    "set",
    "-gq",
    "set-clipboard",
    "on",
    "\\;",
    "set",
    "-gq",
    "window-size",
    "latest",
    "\\;",
    "new-session",
    "-A",
    "-s",
    posixQuote(sessionName),
  ];
  if (cwd) parts.push("-c", posixQuote(cwd));
  if (command) parts.push(posixQuote(command));
  return `${sessionSweep(sessionName, RESUME_WINDOW_SECONDS)}; ${parts.join(" ")}`;
}

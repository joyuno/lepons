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
  selection = "#264f78",
): string {
  // Everything set here is Lepons' alone where tmux lets it be: a shared
  // server's other sessions keep their own mouse, prefix and status line.
  // Session options go after new-session, the session existing only then; tmux
  // runs the rest of the line once the client has attached, every attach, so a
  // session made before this keeps up too. -q throughout: an option an older
  // tmux lacks must not stop the line, and one failing before new-session
  // would stop the attach.
  //
  // Server options cannot be scoped and so reach every session on the server,
  // set before new-session so the attaching client starts with them:
  // - set-clipboard on: passes an agent's OSC 52 copy (Claude Code's "c to
  //   copy") out to the cockpit, and tmux's own copy of a drag the same way --
  //   the screen xterm sees hard-wraps a long URL, tmux's copy joins it.
  // - escape-time 10: tmux holds a bare Esc 500ms by default to see if a key
  //   follows, so Esc in an agent lagged; 10ms still joins an Alt key over SSH.
  // - focus-events on: the agent hears the pane gaining and losing focus.
  // - hyperlinks for this client's TERM: tmux keeps an agent's OSC 8 link but
  //   passes it out only to a terminal it knows takes one, and its defaults do
  //   not say so of xterm. Without it Claude Code's link arrives as bare text,
  //   broken over indented lines Ctrl+click cannot join. A fixed index rather
  //   than -a: the line runs every attach and would append it every time.
  //
  // history-limit is a session option, but a pane takes the limit in force
  // when it is created and new-session creates this pane: set after it, the
  // agent's own pane would keep the default. So it stays global (-g), the one
  // session option that leaks: other panes made on this server later get the
  // longer history too, which costs them memory and nothing else.
  //
  // `-u`: the client is UTF-8 whatever the remote locale says, so Korean is
  // drawn rather than replaced by underscores. COLORTERM: tmux 3.6+ reads it
  // off this client alone and draws 24-bit colour to it rather than rounding
  // to 256. default-terminal is a server option, and a tmux-256color TERM
  // breaks programs on a host without its terminfo (macOS's system ncurses):
  // left as the operator has it, as are their own terminal-features.
  const session = posixQuote(`=${sessionName}`);
  const parts = [
    "COLORTERM=truecolor tmux -u start-server",
    "set -sq set-clipboard on",
    "set -sq escape-time 10",
    "set -sq focus-events on",
    "set -sq 'terminal-features[89]' 'xterm-256color:hyperlinks'",
    "set -g history-limit 20000",
    ["new-session -A -s", posixQuote(sessionName), ...(cwd ? ["-c", posixQuote(cwd)] : []), ...(command ? [posixQuote(command)] : [])].join(" "),
    // Mouse mode is what makes the wheel scroll at all: tmux owns the
    // scrollback and the terminal's own buffer stays empty. The prefix (Ctrl+B)
    // is the agent's (Claude Code pages up with it); tmux's keys are not used
    // here. The status line stays (on, for sessions 1.10.12 turned it off in):
    // without it tmux scrolls the whole screen, and the lines it pushes up
    // filled xterm's own scrollback, a second scrollbar beside tmux's.
    `set -q -t ${session} mouse on`,
    `set -q -t ${session} prefix None`,
    `set -q -t ${session} prefix2 None`,
    `set -q -t ${session} status on`,
    // window-size latest: with a second client still attached (another PC, a
    // dropped connection), tmux before 3.1 sizes the window to the smallest
    // one. The agent then draws narrower than this terminal, and the cells to
    // its right keep old output that a drag selection copies along with a
    // URL. A window option: the session's current window, the agent's.
    `set -wq -t ${posixQuote(`=${sessionName}:`)} window-size latest`,
    // A drag past the screen is tmux's (renderer watchDrag): its selection is
    // drawn in the terminal's own selection colour, and stays after the
    // release (copied then, through OSC 52) for Ctrl+C to let go, as the
    // terminal's own does. Key bindings are server-wide, so the release keeps
    // tmux's default for every session not Lepons', and on a tmux before 3.2
    // (no copy-pipe-no-clear; a version like "3.6a" is no number to compare, hence the match).
    `set -wq -t ${posixQuote(`=${sessionName}:`)} mode-style ${posixQuote(`bg=${selection}`)}`,
    ...["copy-mode", "copy-mode-vi"].map((table) =>
      `bind -T ${table} MouseDragEnd1Pane if -F ${posixQuote("#{&&:#{m:lepons-*,#{session_name}},#{m/r:^(3[.][2-9]|[4-9]|[1-9][0-9]),#{version}}}")} ${posixQuote("send -X copy-pipe-no-clear")} ${posixQuote("send -X copy-pipe-and-cancel")}`),
  ];
  return `${sessionSweep(sessionName, RESUME_WINDOW_SECONDS)}; ${parts.join(" \\; ")}`;
}

/**
 * Where a tmux pane's view is: lines of history above the screen, how far up it is scrolled (0 at the bottom), screen
 * rows, and whether the pane is in a mode (copy mode: scrolled up, mid-drag or searching), where keys are not the agent's.
 */
export interface TmuxScroll {
  history: number;
  position: number;
  height: number;
  inMode: boolean;
}

// A non-login shell over SSH may not have tmux on its PATH (Homebrew's on a Mac): where it usually is, after the rest.
const TMUX = "PATH=$PATH:/opt/homebrew/bin:/usr/local/bin tmux";

/**
 * Text as a copy-mode search finds it literally: tmux 3.1+ searches by regular expression (ERE). `;` goes in brackets
 * because tmux reads an argument ending in it as the end of a command.
 */
export function tmuxSearchPattern(text: string): string {
  return text.replace(/[\\^$.|?*+()[\]{}]/g, "\\$&").replace(/;/g, "[;]");
}

/**
 * Reads where session `name`'s view is, after moving it to `to` lines above the bottom when given: copy mode's
 * goto-line sets that offset itself (tmux clamps it to the history), so a move is the same whatever came before it;
 * 0 leaves copy mode. With `find`, the view goes to the next match of its text up (older) or down instead, in copy
 * mode, from wherever the cursor is. One line of output, read by parseTmuxScroll.
 */
export function tmuxScrollCommand(name: string, to?: number, find?: { text: string; up: boolean }): string {
  // The session by exact name, its current window's active pane.
  const target = posixQuote(`=${name}:`);
  const steps: string[] = [];
  if (find) steps.push(`${TMUX} copy-mode -t ${target} 2>/dev/null; ${TMUX} send -X -t ${target} search-${find.up ? "backward" : "forward"} ${posixQuote(tmuxSearchPattern(find.text))} 2>/dev/null`);
  else if (to !== undefined && to <= 0) steps.push(`${TMUX} send -X -t ${target} cancel 2>/dev/null`);
  else if (to !== undefined) steps.push(`${TMUX} copy-mode -e -t ${target} 2>/dev/null; ${TMUX} send -X -t ${target} goto-line ${Math.round(to)} 2>/dev/null`);
  steps.push(`${TMUX} display -p -t ${target} 'LPS #{history_size} #{scroll_position} #{pane_height} #{pane_in_mode}' 2>/dev/null`);
  return steps.join("; ");
}

/** The view from tmuxScrollCommand's output; undefined when tmux said nothing usable. Out of copy mode the position is empty: 0. */
export function parseTmuxScroll(output: string): TmuxScroll | undefined {
  const match = /^LPS (\d+) (\d*) (\d+)(?: (\d+))?\s*$/m.exec(output);
  if (!match) return undefined;
  return { history: Number(match[1]), position: Number(match[2] || 0), height: Number(match[3]), inMode: Number(match[4] ?? 0) > 0 };
}

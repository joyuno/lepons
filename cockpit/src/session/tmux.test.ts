import { test } from "node:test";
import assert from "node:assert/strict";

import { RESUME_WINDOW_SECONDS, sessionSweep, tmuxCommand, parseTmuxScroll, tmuxKillCommand, tmuxScope, tmuxScrollCommand, tmuxSearchPattern, tmuxSessionName } from "./tmux.ts";

// Turning a session off has to end the one on screen. The scope carries the
// executor because a machine registered as Claude can be running Codex right
// now, and those are two different tmux sessions living side by side -- kill
// by the node's configured agent and the operator watches the wrong session
// die while the one they asked to stop keeps working.
test("stopping targets the executor the session actually launched", () => {
  const claude = tmuxKillCommand("node::/srv/api", "claude");
  const codex = tmuxKillCommand("node::/srv/api", "codex");

  assert.notEqual(claude, codex, "one repository, two executors, two sessions");
  assert.match(claude, /^tmux kill-session -t /);
  assert.ok(claude.includes(tmuxSessionName(tmuxScope("node::/srv/api", "claude"))));
  assert.ok(codex.includes(tmuxSessionName(tmuxScope("node::/srv/api", "codex"))));
});

// The name opened and the name killed are built from one function, so they
// cannot drift into "stop does nothing because it aimed at a session that
// was never created under that name".
test("the session opened and the session killed share one scope", () => {
  const scope = tmuxScope("node::/srv/api", "codex");
  const opened = tmuxCommand(tmuxSessionName(scope), "/srv/api", "codex-cmd");

  assert.ok(opened.includes(tmuxSessionName(scope)));
  assert.ok(tmuxKillCommand("node::/srv/api", "codex").includes(tmuxSessionName(scope)));
});

// Reconnecting must land on the same tmux session, so the name may not vary
// between runs. If it did, every reconnect would silently start fresh work
// while the previous session kept running unseen on the node.
test("the session name is stable for the same scope", () => {
  assert.equal(tmuxSessionName("/srv/api"), tmuxSessionName("/srv/api"));
});

test("different repositories get different sessions even with the same basename", () => {
  assert.notEqual(tmuxSessionName("/srv/one/api"), tmuxSessionName("/srv/two/api"));
});

// tmux reads "." and ":" as session addressing, so a name carrying them would
// be interpreted rather than matched.
test("the session name carries no tmux addressing characters", () => {
  const name = tmuxSessionName("/srv/my repo.v2:beta");
  assert.doesNotMatch(name, /[.:]/);
  assert.match(name, /^lepons-[A-Za-z0-9_-]+$/);
});

test("the readable part comes from the last path segment", () => {
  assert.match(tmuxSessionName("/srv/lepons/api"), /^lepons-api-[0-9a-f]{8}$/);
});

test("a scope with no usable segment still produces a valid name", () => {
  assert.match(tmuxSessionName("/"), /^lepons-shell-[0-9a-f]{8}$/);
});

// Server options and the history limit, then the session, then the options
// that are the session's own. Kept as constants so the three cases below stay
// about what they are each testing.
const SETUP = "COLORTERM=truecolor tmux -u start-server \\; set -sq set-clipboard on \\; set -sq escape-time 10 \\; set -sq focus-events on \\; set -g history-limit 20000 \\;";
const OWN = (name: string) =>
  ` \\; set -q -t '=${name}' mouse on \\; set -q -t '=${name}' prefix None \\; set -q -t '=${name}' prefix2 None` +
  ` \\; set -q -t '=${name}' status on \\; set -wq -t '=${name}:' window-size latest`;

const SWEEP = (name: string) => sessionSweep(name, RESUME_WINDOW_SECONDS);

test("attaches when present and creates otherwise", () => {
  assert.equal(
    tmuxCommand("lepons-api-0123abcd", "/srv/api", "claude"),
    `${SWEEP("lepons-api-0123abcd")}; ${SETUP} new-session -A -s 'lepons-api-0123abcd' -c '/srv/api' 'claude'${OWN("lepons-api-0123abcd")}`,
  );
});

test("quotes a working directory containing spaces", () => {
  assert.equal(
    tmuxCommand("s", "/srv/my repo", "claude"),
    `${SWEEP("s")}; ${SETUP} new-session -A -s 's' -c '/srv/my repo' 'claude'${OWN("s")}`,
  );
});

test("omits the directory and command when they are not set", () => {
  assert.equal(
    tmuxCommand("s", undefined, undefined),
    `${SWEEP("s")}; ${SETUP} new-session -A -s 's'${OWN("s")}`,
  );
});

// Another tmux user's sessions on a shared server keep their mouse, Ctrl+B
// prefix and status line: every option that tmux lets be scoped is set on this
// session only (after it exists), and only server options and the history
// limit are global.
test("options reach only this session where tmux allows it", () => {
  const line = tmuxCommand("s", "/srv/api", "claude");
  const globals = [...line.matchAll(/set -(s|g)q? (\S+)/g)].map((match) => match[2]).sort();
  assert.deepEqual(globals, ["escape-time", "focus-events", "history-limit", "set-clipboard"]);
  const create = line.indexOf("new-session");
  for (const option of ["mouse on", "prefix None", "prefix2 None", "status on", "window-size latest"]) {
    assert.ok(line.indexOf(option) > create, `${option} is set on the session, once it exists`);
  }
  assert.ok(line.indexOf("history-limit") < create, "a pane takes the history limit in force when it is created");
});

// A forgotten `/exit` must not leak the node's resources forever, a stale
// session must not be resumed days later, and tmux work that is not this
// cockpit's must never be touched -- one pass decides all three.
test("the sweep only names lepons- sessions: the one attaching past the resume window, others past 24h", () => {
  const line = sessionSweep("lepons-api-0123abcd", RESUME_WINDOW_SECONDS);
  assert.match(line, /\^lepons-/, "only lepons- sessions are candidates");
  assert.match(line, /cur='lepons-api-0123abcd'/, "the attaching session is passed in");
  assert.match(line, new RegExp(`w=${RESUME_WINDOW_SECONDS}`), "the resume window is threaded through");
  assert.match(line, /\(\$1 == cur \? w : 86400\)/, "its own window for the attaching session, 24h for the rest");
  assert.match(line, /tmux kill-session -t "\$s"/);
  assert.equal(line.split("tmux ls").length - 1, 1, "one pass over the sessions, not two");
});

test("the resume window is 2 hours, matching the operator-stepped-away grace period", () => {
  assert.equal(RESUME_WINDOW_SECONDS, 2 * 60 * 60);
});

// tmux owns the scrollback (it runs in the outer terminal's alternate screen),
// so without mouse mode the wheel does nothing and the agent's earlier output
// is unreachable. The limit has to be set before the pane exists to apply to
// it, which is why it lands ahead of new-session.
test("the session can be scrolled back through", () => {
  const line = tmuxCommand("s", "/srv/api", "claude");
  const history = line.indexOf("set -g history-limit 20000");
  const create = line.indexOf("new-session");

  assert.ok(line.includes("set -q -t '=s' mouse on"), "mouse mode is what makes the wheel scroll");
  assert.ok(history < create, "a pane takes the history limit in force when it is created");
  assert.ok(line.includes("tmux -u start-server"), "the options need a server to be set on");
});

test("a remote pane's scroll: read, moved up into copy mode, back out at the bottom", () => {
  assert.match(tmuxScrollCommand("lepons-1a2b"), /^PATH=.* tmux display -p -t '=lepons-1a2b:' 'LPS #\{history_size\} #\{scroll_position\} #\{pane_height\} #\{pane_in_mode\}'/);
  assert.match(tmuxScrollCommand("s", 30), /copy-mode -e -t '=s:'.*send -X -t '=s:' goto-line 30 .*display/);
  assert.match(tmuxScrollCommand("s", 0), /send -X -t '=s:' cancel.*display/);
  assert.doesNotMatch(tmuxScrollCommand("s", 0), /copy-mode/);
  assert.deepEqual(parseTmuxScroll("motd\nLPS 1200 40 38 1\n"), { history: 1200, position: 40, height: 38, inMode: true });
  assert.deepEqual(parseTmuxScroll("LPS 1200  38 0"), { history: 1200, position: 0, height: 38, inMode: false }, "out of copy mode");
  assert.deepEqual(parseTmuxScroll("LPS 1200  38"), { history: 1200, position: 0, height: 38, inMode: false }, "a reply without the mode");
  assert.equal(parseTmuxScroll("no server running"), undefined);
});

// Searching a remote pane is tmux's search, in copy mode: what the operator
// typed is found as text, not read as a pattern, and a `;` at its end must not
// be taken by tmux as the end of the command.
test("a remote pane's search: copy mode, the text searched literally, the view read back", () => {
  const up = tmuxScrollCommand("s", undefined, { text: "a.b (c)", up: true });
  assert.match(up, /copy-mode -t '=s:' .*send -X -t '=s:' search-backward 'a\\\.b \\\(c\\\)' .*display/);
  assert.doesNotMatch(up, /copy-mode -e/, "a match on the bottom screen must not end the search");
  assert.match(tmuxScrollCommand("s", undefined, { text: "x", up: false }), /search-forward 'x'/);
  assert.equal(tmuxSearchPattern("1+1=2?"), "1\\+1=2\\?");
  assert.equal(tmuxSearchPattern("a\\b"), "a\\\\b");
  assert.equal(tmuxSearchPattern("end;"), "end[;]");
  assert.match("x 1+1=2? y", new RegExp(tmuxSearchPattern("1+1=2?")), "the escaped text finds itself");
});

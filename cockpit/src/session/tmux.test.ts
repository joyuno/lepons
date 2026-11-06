import { test } from "node:test";
import assert from "node:assert/strict";

import { RESUME_WINDOW_SECONDS, sessionSweep, tmuxCommand, tmuxKillCommand, tmuxScope, tmuxSessionName } from "./tmux.ts";

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

// Options, then the session. Kept as one constant so the three cases below
// stay about what they are each testing.
const SETUP = "tmux start-server \\; set -g mouse on \\; set -g history-limit 20000 \\; set -gq set-clipboard on \\; set -gq window-size latest \\;";

const SWEEP = (name: string) => sessionSweep(name, RESUME_WINDOW_SECONDS);

test("attaches when present and creates otherwise", () => {
  assert.equal(
    tmuxCommand("lepons-api-0123abcd", "/srv/api", "claude"),
    `${SWEEP("lepons-api-0123abcd")}; ${SETUP} new-session -A -s 'lepons-api-0123abcd' -c '/srv/api' 'claude'`,
  );
});

test("quotes a working directory containing spaces", () => {
  assert.equal(
    tmuxCommand("s", "/srv/my repo", "claude"),
    `${SWEEP("s")}; ${SETUP} new-session -A -s 's' -c '/srv/my repo' 'claude'`,
  );
});

test("omits the directory and command when they are not set", () => {
  assert.equal(
    tmuxCommand("s", undefined, undefined),
    `${SWEEP("s")}; ${SETUP} new-session -A -s 's'`,
  );
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
// it, which is why both land ahead of new-session.
test("the session can be scrolled back through", () => {
  const line = tmuxCommand("s", "/srv/api", "claude");
  const mouse = line.indexOf("set -g mouse on");
  const history = line.indexOf("set -g history-limit 20000");
  const create = line.indexOf("new-session");

  assert.ok(mouse !== -1, "mouse mode is what makes the wheel scroll");
  assert.ok(history < create, "a pane takes the history limit in force when it is created");
  assert.ok(line.includes("tmux start-server"), "the options need a server to be set on");
});

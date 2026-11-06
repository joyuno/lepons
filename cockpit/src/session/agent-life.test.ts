import assert from "node:assert/strict";
import { test } from "node:test";

import { confirmGone, shellsAlone, spacedLooks, tmuxGone } from "./agent-life.ts";

const shells = [{ key: "a", pid: 10 }, { key: "b", pid: 20 }];

test("a shell with no child has lost its AI; one with any child has not", async () => {
  assert.deepEqual(await shellsAlone(shells, async () => "20\r\n", "win32"), ["a"]);
  assert.deepEqual(await shellsAlone(shells, async () => "", "win32"), ["a", "b"]);
  assert.deepEqual(await shellsAlone(shells, async () => "    1\n   10\n   20\n", "linux"), []);
});

test("a process list that cannot be read says nothing", async () => {
  assert.deepEqual(await shellsAlone(shells, async () => { throw new Error("no powershell"); }, "win32"), []);
});

test("only sessions with a process here are asked about, and nothing is run for none", async () => {
  let ran = false;
  const run = async () => { ran = true; return ""; };
  assert.deepEqual(await shellsAlone([{ key: "c", tmux: "lepons-c" }], run, "win32"), []);
  assert.equal(ran, false);
});

test("Windows is asked about exactly these shells", async () => {
  let asked: string[] = [];
  await shellsAlone(shells, async (_file, args) => { asked = args; return ""; }, "win32");
  assert.ok(asked.at(-1)!.includes("ParentProcessId=10 OR ParentProcessId=20"));
});

// As real tmux 3.8 printed it, with a login shell's noise above.
const live = "welcome to the box\nlepons-api-claude-bfbe0f34 0\nlepons-web-codex-11111111 1\nother 0\n@tmux 0\n";
const tmuxProbes = [
  { key: "api", tmux: "lepons-api-claude-bfbe0f34" },
  { key: "web", tmux: "lepons-web-codex-11111111" },
  { key: "docs", tmux: "lepons-docs-claude-22222222" },
];

test("a session with no living pane is gone, a dead pane kept by remain-on-exit too", () => {
  assert.deepEqual(tmuxGone(live, tmuxProbes), ["web", "docs"]);
});

test("no tmux server running means every session is gone", () => {
  assert.deepEqual(tmuxGone("no server running on /tmp/tmux-1000/default\n@tmux 1\n", tmuxProbes), ["api", "web", "docs"]);
  assert.deepEqual(tmuxGone("error connecting to /tmp/tmux-1000/default (No such file or directory)\r\n@tmux 1\r\n", tmuxProbes), ["api", "web", "docs"]);
});

test("a failure that is not tmux saying so tells nothing", () => {
  assert.deepEqual(tmuxGone("bash: tmux: command not found\n@tmux 127\n", tmuxProbes), []);
  assert.deepEqual(tmuxGone("error connecting to /tmp/tmux-1000/default (Permission denied)\n@tmux 1\n", tmuxProbes), []);
  assert.deepEqual(tmuxGone("", tmuxProbes), [], "the shell never got as far as the marker");
  assert.deepEqual(tmuxGone("lepons-api-claude-bfbe0f34 0\n", tmuxProbes), [], "cut off before the marker");
  assert.deepEqual(tmuxGone("tmux: error while loading shared libraries: libevent-2.1.so.7: cannot open shared object file: No such file or directory\n@tmux 127\n", tmuxProbes), [], "a tmux that cannot start, with its server still up");
  assert.deepEqual(tmuxGone("bash: /opt/bin/tmux: No such file or directory\n@tmux 127\n", tmuxProbes), [], "a tmux that moved");
});

test("an rc file's title with no newline does not hide the first pane", () => {
  const alive = "\x1b]0;box\x07lepons-api-claude-bfbe0f34 0\nlepons-web-codex-11111111 0\nlepons-docs-claude-22222222 0\n@tmux 0\n";
  assert.deepEqual(tmuxGone(alive, tmuxProbes), []);
});

test("a newly gone session is read twice, and a gap between two AIs does not count", async () => {
  const reads = [["a"], []];
  let waited = 0;
  const gone = await confirmGone(async () => reads.shift()!, new Set(), async () => { waited++; });
  assert.equal(waited, 1);
  assert.deepEqual([...gone], []);
});

test("gone in both reads is gone; one that turned up only in the second waits its turn", async () => {
  const reads = [["a"], ["a", "b"]];
  assert.deepEqual([...await confirmGone(async () => reads.shift()!, new Set(), async () => {})], ["a"]);
});

test("looks: one soon, then at most one per gap however many want it", async () => {
  const at: number[] = [];
  const want = spacedLooks(async () => { at.push(Date.now()); }, 60);
  const start = Date.now();
  want();
  want();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(at.length, 1);
  assert.ok(at[0]! - start < 55, "the first has nothing to wait for: well inside the gap, whatever else the machine is doing");
  want();
  want();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(at.length, 1, "still inside the gap");
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(at.length, 2);
  assert.ok(at[1]! - at[0]! >= 55);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(at.length, 2, "nothing wants one: nothing runs");
});

test("looks: wanted during a look, it still happens after the gap; a failed look stops nothing", async () => {
  let looks = 0;
  let finish: () => void = () => {};
  const want = spacedLooks(() => {
    looks++;
    return new Promise((resolve, reject) => { finish = looks === 1 ? () => reject(new Error("no")) : () => resolve(); });
  }, 10);
  want();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(looks, 1);
  want();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(looks, 1, "one at a time");
  finish();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(looks, 2);
  finish();
});

test("nothing new is one read: what is known stays or clears at once", async () => {
  let reads = 0;
  const gone = await confirmGone(async () => { reads++; return ["a"]; }, new Set(["a", "b"]), async () => assert.fail("no second read"));
  assert.equal(reads, 1);
  assert.deepEqual([...gone], ["a"]);
});

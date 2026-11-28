import { test, mock } from "node:test";
import assert from "node:assert/strict";

import { spawn, type ChildProcess } from "node:child_process";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { findGitBash } from "./allow-ssh.ts";
import { remoteWatchScript, TranscriptWatchers, watchRemoteRecord, type WatchFn } from "./transcript-watch.ts";
import { generateHostKey, startFakeNode } from "../ssh/fake-node.ts";
import { NodeSession } from "../ssh/session.ts";

test("a burst of change events yields exactly one notification", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  let fireEvent: (() => void) | undefined;
  const watch: WatchFn = (_dir, onEvent) => {
    fireEvent = onEvent;
    return { close: () => {} };
  };
  const changes: Array<[string, string]> = [];
  const watchers = new TranscriptWatchers(watch, (nodeId, repoId) => changes.push([nodeId, repoId]));

  watchers.start([{ nodeId: "local", repoId: "repo-a", dir: "/x" }]);
  for (let i = 0; i < 5; i++) fireEvent?.();
  mock.timers.tick(250);

  assert.deepEqual(changes, [["local", "repo-a"]]);
  mock.timers.reset();
});

test("writes that never pause are still told by the longest wait after the burst began", () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  let fireEvent: (() => void) | undefined;
  const watch: WatchFn = (_dir, onEvent) => {
    fireEvent = onEvent;
    return { close: () => {} };
  };
  const told: number[] = [];
  const watchers = new TranscriptWatchers(watch, () => told.push(Date.now()), 100, 300);
  watchers.start([{ nodeId: "local", repoId: "repo-a", dir: "/x" }]);
  // An event every 50 ms for a second: a debounce alone would wait for the end.
  for (let t = 0; t < 1000; t += 50) {
    fireEvent?.();
    mock.timers.tick(50);
  }
  mock.timers.tick(100);
  assert.ok(told.length >= 3, `told ${told.length} times`);
  assert.ok(told[0]! <= 300, `first told at ${told[0]} ms`);
  mock.timers.reset();
});

test("stopping closes every watcher", () => {
  const closed: string[] = [];
  const watch: WatchFn = (dir) => ({ close: () => closed.push(dir) });
  const watchers = new TranscriptWatchers(watch, () => {});

  watchers.start([
    { nodeId: "local", repoId: "repo-a", dir: "/a" },
    { nodeId: "local", repoId: "repo-b", dir: "/b" },
  ]);
  watchers.stop();

  assert.deepEqual(closed.sort(), ["/a", "/b"]);
});

test("starting twice does not double-watch", () => {
  let watchCalls = 0;
  const watch: WatchFn = () => {
    watchCalls++;
    return { close: () => {} };
  };
  const watchers = new TranscriptWatchers(watch, () => {});

  watchers.start([{ nodeId: "local", repoId: "repo-a", dir: "/a" }]);
  watchers.start([{ nodeId: "local", repoId: "repo-a", dir: "/a" }]);

  assert.equal(watchCalls, 1);
});

// A directory that disappears mid-watch must not crash the process; the
// watcher just has nothing left to report.
test("a watch error does not throw or notify", () => {
  const watch: WatchFn = (_dir, _onEvent, onError) => {
    onError(new Error("ENOENT"));
    return { close: () => {} };
  };
  const changes: Array<[string, string]> = [];
  const watchers = new TranscriptWatchers(watch, (nodeId, repoId) => changes.push([nodeId, repoId]));

  assert.doesNotThrow(() => watchers.start([{ nodeId: "local", repoId: "repo-a", dir: "/a" }]));
  assert.deepEqual(changes, []);
});

// Recursive watching is what lets a subagent's nested transcript be seen at
// all; a platform that rejects it must still end up watched, not skipped.
test("a platform that rejects recursive watching falls back to a plain watch", () => {
  const attempts: boolean[] = [];
  const closed: string[] = [];
  const watch: WatchFn = (dir, _onEvent, _onError, options) => {
    attempts.push(Boolean(options?.recursive));
    if (options?.recursive) throw new Error("ERR_FEATURE_UNAVAILABLE_ON_PLATFORM");
    return { close: () => closed.push(dir) };
  };
  const watchers = new TranscriptWatchers(watch, () => {});

  assert.doesNotThrow(() => watchers.start([{ nodeId: "local", repoId: "repo-a", dir: "/a" }]));
  assert.deepEqual(attempts, [true, false]);

  watchers.stop();
  assert.deepEqual(closed, ["/a"]);
});

// The loop as another PC runs it, in a real sh: what is timed is a write there reaching `tell`.
const shell = process.platform === "win32" ? findGitBash() : "sh";
test("a record on another PC is told within a moment of its write, and read every second while the loop is not heard", { skip: !shell }, async (t) => {
  const dir = (await mkdtemp(join(tmpdir(), "remote-watch-"))).replaceAll("\\", "/");
  const runs: ChildProcess[] = [];
  t.after(async () => {
    for (const run of runs) run.kill();
    await rm(dir, { recursive: true, force: true });
  });
  await writeFile(`${dir}/a.jsonl`, "{}\n");
  let told = 0;
  const follow = (script: string, data: (chunk: string) => void, ended: () => void) => {
    const run = spawn(shell!, ["-c", script]);
    runs.push(run);
    run.stdout.setEncoding("utf8").on("data", data);
    run.on("exit", ended);
    return () => void run.kill();
  };
  const stop = watchRemoteRecord(`'${dir}'`, follow, () => told++);
  const settle = async (ms: number) => new Promise((done) => setTimeout(done, ms));
  await settle(1500);
  const quiet = told;
  await settle(1200);
  assert.equal(told, quiet, "a loop heard, and nothing written: no reads");
  const wrote = performance.now();
  await appendFile(`${dir}/a.jsonl`, "{}\n");
  while (told === quiet && performance.now() - wrote < 3000) await settle(10);
  const took = performance.now() - wrote;
  assert.ok(told > quiet && took < 1000, `told ${Math.round(took)} ms after the write`);
  stop();
  assert.equal(runs.length, 1, "one loop, kept running");

  // A burst of writes, with a gap asked for: the first told at once, the rest once, after the gap.
  let gapped = 0;
  let feed: ((chunk: string) => void) | undefined;
  const off2 = watchRemoteRecord("x", (_script, data) => ((feed = data), () => {}), () => gapped++, 60_000, 200);
  const base = gapped;
  for (let i = 0; i < 5; i++) feed!("x\n");
  assert.equal(gapped, base + 1);
  await settle(300);
  assert.equal(gapped, base + 2, "the burst's last is told once the gap is over");
  off2();

  // No terminal up: a read each second instead, and the loop tried again each time.
  let tries = 0;
  let fallback = 0;
  const off = watchRemoteRecord("x", () => (tries++, undefined), () => fallback++, 50);
  await settle(180);
  off();
  assert.ok(fallback >= 3 && tries >= 3);
});

// Over a real SSH connection to a node whose sshd only closes a hung-up command's pipe, and a shell ignoring SIGPIPE.
test("no watch loop is left on another PC once the chat lets go of it or the connection drops", { skip: !shell, timeout: 60_000 }, async (t) => {
  const home = (await mkdtemp(join(tmpdir(), "remote-loop-"))).replaceAll("\\", "/");
  const node = await startFakeNode(generateHostKey(), { home, shell: shell! });
  node.faults.keepHungUp = true;
  t.after(async () => {
    await node.close();
    await rm(home, { recursive: true, force: true });
  });
  const settle = async (ms: number) => new Promise((done) => setTimeout(done, ms));
  const until = async (done: () => boolean, ms: number) => {
    const end = performance.now() + ms;
    while (!done() && performance.now() < end) await settle(20);
    return done();
  };
  const session = new NodeSession(node.options);
  await session.open();
  await until(() => node.running() === 0, 2000);
  const loop = `trap '' PIPE; ${remoteWatchScript(`'${home}'`)}`;

  // Let go (the chat closed, the pane with it): ended there at once, not at its next write.
  let heard = "";
  const stop = session.follow(loop, (chunk) => (heard += chunk), () => {})!;
  assert.ok(await until(() => heard.includes("x"), 10_000), "the loop runs");
  assert.equal(node.running(), 1);
  stop();
  // Bounds are for a loaded PC (each round of the loop starts processes): the condition is what is waited on.
  assert.ok(await until(() => node.running() === 0, 10_000), "killed by its stop");

  // The connection dropped, so no signal: it ends by itself at its next write (a "." each 4 rounds, a second when idle).
  heard = "";
  session.follow(loop, (chunk) => (heard += chunk), () => {});
  assert.ok(await until(() => heard.includes("x"), 10_000));
  session.close();
  assert.ok(await until(() => node.running() === 0, 20_000), "ended by its own failed write");
});

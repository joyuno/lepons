import { test, mock } from "node:test";
import assert from "node:assert/strict";

import { TranscriptWatchers, type WatchFn } from "./transcript-watch.ts";

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

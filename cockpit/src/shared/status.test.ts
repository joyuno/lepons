import { test } from "node:test";
import assert from "node:assert/strict";

import { pcFailReason, pcState, sessionStatus, turnMark, turnsEnded } from "./status.ts";
import type { SessionState } from "../session/state.ts";

const closed = (reason: string): SessionState => ({ kind: "closed", reason } as SessionState);
const quiet = { working: false, waiting: false };

test("a session nobody opened is idle", () => {
  assert.equal(sessionStatus(undefined, quiet), "idle");
});

test("connecting counts as working", () => {
  assert.equal(sessionStatus({ kind: "connecting" }, quiet), "working");
});

test("a session the operator or the idle timer closed is idle, any other close failed", () => {
  for (const reason of ["closed_by_user", "idle_closed"]) assert.equal(sessionStatus(closed(reason), quiet), "idle", reason);
  for (const reason of ["unreachable", "auth_failed", "agent_missing", "connection_lost"]) assert.equal(sessionStatus(closed(reason), quiet), "failed", reason);
});

test("a ready session is waiting, working or done by its output rhythm", () => {
  const ready: SessionState = { kind: "ready" };
  assert.equal(sessionStatus(ready, { working: false, waiting: true }), "waiting");
  assert.equal(sessionStatus(ready, { working: true, waiting: false }), "working");
  assert.equal(sessionStatus(ready, { working: true, waiting: true }), "waiting");
  assert.equal(sessionStatus(ready, quiet), "done");
});

test("a ready session whose AI has gone says so, over anything its output left behind", () => {
  const ready: SessionState = { kind: "ready" };
  for (const rhythm of [quiet, { working: true, waiting: false }, { working: false, waiting: true }]) {
    assert.equal(sessionStatus(ready, { ...rhythm, agentGone: true }), "shellOnly");
    assert.notEqual(sessionStatus(ready, { ...rhythm, agentGone: false }), "shellOnly");
  }
  assert.equal(sessionStatus(undefined, { ...quiet, agentGone: true }), "idle");
  assert.equal(sessionStatus({ kind: "connecting" }, { ...quiet, agentGone: true }), "working");
  assert.equal(sessionStatus({ kind: "closed", reason: "closed_by_user" }, { ...quiet, agentGone: true }), "idle");
});

test("only connecting and a finished turn are marked for the all-done push", () => {
  const finished = { finished: true };
  assert.equal(turnMark({ kind: "connecting" }, finished), "starting");
  assert.equal(turnMark({ kind: "ready" }, finished), "finished");
  assert.equal(turnMark({ kind: "ready" }, { finished: false }), undefined);
  assert.equal(turnMark(closed("unreachable"), finished), undefined);
  assert.equal(turnMark(undefined, finished), undefined);
});

test("a PC is off until something happened there", () => {
  assert.equal(pcState([], false), "off");
  assert.equal(pcState([closed("closed_by_user")], false), "off");
});

test("a PC is live with a session up and connecting while one is on its way", () => {
  assert.equal(pcState([{ kind: "ready" }], false), "live");
  assert.equal(pcState([{ kind: "ready" }, { kind: "connecting" }], false), "connecting");
  assert.equal(pcState([{ kind: "ready" }], true), "connecting");
});

test("a PC failed when its sessions failed or its share is down with nothing up", () => {
  assert.equal(pcState([closed("unreachable")], false), "failed");
  assert.equal(pcState([closed("auth_failed"), closed("closed_by_user")], false), "failed");
  assert.equal(pcState([], true), "failed");
  assert.equal(pcState([closed("unreachable"), { kind: "ready" }], false), "live");
});

test("a failed PC says why: a failed session first, else its share", () => {
  assert.equal(pcFailReason([closed("closed_by_user"), closed("auth_failed")], { reason: "refused" }), "auth_failed");
  assert.equal(pcFailReason([closed("closed_by_user")], { reason: "refused" }), "refused");
  assert.equal(pcFailReason([{ kind: "ready" }], undefined), undefined);
});

test("a turn ends when a working session goes waiting, done or idle", () => {
  const before = new Map([["a", "working"], ["b", "working"], ["c", "working"], ["d", "working"], ["e", "waiting"], ["f", "done"]]);
  const now = [
    { key: "a", mood: "waiting" }, { key: "b", mood: "done" }, { key: "c", mood: "idle" }, { key: "d", mood: "working" },
    { key: "e", mood: "done" }, { key: "f", mood: "working" }, { key: "g", mood: "done" },
  ] as const;
  assert.deepEqual(turnsEnded(before, now), ["a", "b", "c"]);
  assert.deepEqual(turnsEnded(new Map(), now), [], "nothing seen before, nothing ended");
});

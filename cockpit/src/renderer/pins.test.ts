import { test } from "node:test";
import assert from "node:assert/strict";

import { livePins, looksOffline, pinKey, savedPins } from "./pins.ts";
import type { NodeConfig } from "../shared/ipc.ts";
import type { SessionState } from "../session/state.ts";

const ssh = (destination: string, repoIds: string[]): NodeConfig => ({
  id: destination,
  kind: "ssh",
  destination,
  useTmux: false,
  label: destination,
  agent: "claude",
  home: "/home/who",
  repos: repoIds.map((id) => ({ id, path: `/home/who/${id}`, label: id })),
});

const nodes = [ssh("A", ["r1", "r2"]), ssh("B", ["r3"])];

test("a pin names a PC and a folder", () => {
  assert.equal(pinKey("a@h", "r1"), "a@h\0r1");
});

test("saved pins survive only as a list of strings", () => {
  assert.deepEqual(savedPins(null), []);
  assert.deepEqual(savedPins("not json"), []);
  assert.deepEqual(savedPins('{"a":1}'), []);
  assert.deepEqual(savedPins('["x\\u0000y", 3, "z\\u0000w"]'), ["x\0y", "z\0w"]);
});

test("a pin goes with its PC or its folder", () => {
  assert.deepEqual(
    livePins([pinKey("B", "r3"), pinKey("A", "r2"), pinKey("C", "r9"), pinKey("A", "gone")], nodes),
    [pinKey("B", "r3"), pinKey("A", "r2")],
  );
});

test("a pin listed twice is kept once", () => {
  const k = pinKey("A", "r1");
  assert.deepEqual(livePins([k, k], nodes), [k]);
});

test("a PC looks offline when its sessions could not reach it", () => {
  const closed = (reason: string): SessionState => ({ kind: "closed", reason } as SessionState);
  assert.equal(looksOffline([]), false);
  for (const reason of ["unreachable", "connect_timeout", "connection_lost", "refused", "no_route", "dns_failed"]) {
    assert.equal(looksOffline([closed(reason)]), true, reason);
  }
  for (const reason of ["closed_by_user", "idle_closed", "auth_failed"]) {
    assert.equal(looksOffline([closed(reason)]), false, reason);
  }
  assert.equal(looksOffline([closed("unreachable"), { kind: "ready" }]), false);
  assert.equal(looksOffline([closed("unreachable"), { kind: "connecting" }]), false);
});

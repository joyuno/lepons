import { strict as assert } from "node:assert";
import { test } from "node:test";

import { openOnce } from "./open-once.ts";

/** An open that ends when told, and counts how many were started. */
function opens() {
  const started: string[] = [];
  const ends: Array<(value: string) => void> = [];
  const open = (name: string) => () => {
    started.push(name);
    return new Promise<string>((done) => ends.push(done));
  };
  return { started, ends, open };
}

test("two opens of one session at once start one, and both get its session", async () => {
  const once = openOnce<string>();
  const { started, ends, open } = opens();
  const first = once("pc::repo::bot:x", open("scheduler"), true);
  const second = once("pc::repo::bot:x", open("phone"), true);
  assert.deepEqual(started, ["scheduler"], "the second never starts, so it never closes the first's");
  ends[0]!("ready");
  assert.deepEqual(await Promise.all([first, second]), ["ready", "ready"]);
  // Once it has ended, the next open is a new one.
  void once("pc::repo::bot:x", open("later"), true);
  assert.deepEqual(started, ["scheduler", "later"]);
});

test("other sessions open side by side; a restart waits for the open under way, then starts anew", async () => {
  const once = openOnce<string>();
  const { started, ends, open } = opens();
  const a = once("a", open("a"), true);
  void once("b", open("b"), true);
  assert.deepEqual(started, ["a", "b"]);
  const restart = once("a", open("a-restart"), false);
  assert.deepEqual(started, ["a", "b"], "not while the first is still opening");
  const joined = once("a", open("a-again"), true);
  ends[0]!("first");
  assert.equal(await a, "first");
  await new Promise((done) => setTimeout(done, 0));
  assert.deepEqual(started, ["a", "b", "a-restart"], "a plain open meanwhile joins the restart");
  ends[2]!("restarted");
  assert.deepEqual(await Promise.all([restart, joined]), ["restarted", "restarted"]);
});

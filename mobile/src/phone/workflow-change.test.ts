import assert from "node:assert/strict";
import { test } from "node:test";

import { PhoneAuth } from "../../../cockpit/src/phone/auth.ts";
import { createPhoneApi, sessionId, type PhoneDeps } from "../../../cockpit/src/phone/server.ts";
import type { WorkflowItem } from "./types.ts";
import { olderOf, withChange, withOlder, workflowChangeOf, workflowOf } from "./validate.ts";

const KEY = "local::a";
const ID = sessionId(KEY);

test("a phone that keeps what it was sent ends up with what the whole list would give it", async () => {
  let events: WorkflowItem[] = Array.from({ length: 79 }, (_, i): WorkflowItem => ({ kind: "note", at: i + 1, text: `n${i}` }));
  const auth = new PhoneAuth();
  const token = auth.open(Date.now(), 0);
  const api = createPhoneApi({
    sessions: () => [{ key: KEY }],
    workflow: async () => ({ ok: true, workflow: { title: "t", events } }),
    signedIn: () => {},
  } as unknown as PhoneDeps, auth);
  const ask = async (path: string) => (await api.call({ method: "GET", path, token })).body;

  let held = { events: [] as WorkflowItem[], title: undefined as string | undefined, v: "" };
  const step = async (next: WorkflowItem[]) => {
    events = next;
    const after = held.events.at(-1)?.at;
    const change = workflowChangeOf(await ask(`/api/workflow?s=${ID}&v=${held.v}${after === undefined ? "" : `&after=${after}`}`));
    assert.ok(change);
    held = withChange(held, change) as typeof held;
    assert.equal("after" in held, false, "what is held says nothing of how it got there");
    const whole = workflowOf(await ask(`/api/workflow?s=${ID}`))!;
    assert.deepEqual(held.events, whole.events);
    assert.equal(held.title, whole.title);
    return change;
  };

  try {
    assert.equal("after" in (await step(events)), false, "the first answer is the whole list");
    assert.deepEqual(await step(events), { same: true });

    const small = await step([...events, { kind: "prompt", at: 100, text: "p" }, { kind: "note", at: 100, text: "same time" }, { kind: "note", at: 101, text: "m" }]);
    assert.ok("after" in small && small.events.length === 4 && small.after === 79, "only the last it held and what is new, past the window too");

    // The newest prompt goes (cancelled before its first word) and another stands in its place.
    assert.ok("after" in await step([...events.slice(0, -1), { kind: "prompt", at: 102, text: "again" }]));

    const older = await step(events.map((event, i) => (i === 40 ? { kind: "note", at: event.at, text: "rewritten" } : event)));
    assert.equal("after" in older, false, "an older row changed: the whole list");
  } finally {
    api.close();
  }
});

test("an older PC, which knows nothing of &v=, still reads as a whole list", () => {
  const events: WorkflowItem[] = [{ kind: "prompt", at: 1, text: "p" }];
  assert.deepEqual(workflowChangeOf({ ok: true, title: "t", events }), { title: "t", events });
  assert.equal(workflowChangeOf({ ok: false, reason: "no_transcript" }), null);
  assert.equal(workflowChangeOf("nonsense"), undefined);
  assert.equal(workflowChangeOf({ v: "abc" }), undefined);
});

test("older events the reader asked for stay while the newest keep coming", () => {
  const note = (at: number): WorkflowItem => ({ kind: "note", at, text: `n${at}` });
  const range = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => note(from + i));
  const newest = { events: range(100, 150), v: "a" };

  // A PC older than &before= sends its newest again: nothing before, nothing more.
  assert.deepEqual(olderOf({ ok: true, events: range(100, 150) }, 100), { events: [], more: false });
  const older = olderOf({ ok: true, events: range(50, 100), more: true }, 100)!;
  const held = withOlder(newest, older);
  assert.equal(held.older, "loaded");
  assert.equal(held.events.length, 100);

  // A new event, then the whole newest list again: the older ones are kept either way.
  const grown = withChange(held, { events: [note(149), note(150)], v: "b", after: 149 });
  assert.deepEqual(grown.events.map((e) => e.at), range(50, 151).map((e) => e.at));
  const whole = withChange(grown as typeof held, { events: range(101, 151), v: "c" });
  assert.deepEqual(whole.events.map((e) => e.at), range(50, 151).map((e) => e.at));

  // Without any asked for, only as many newest as the PC says (50 over SSH), or 80 from a PC that does not say.
  assert.deepEqual(withChange(newest, { events: [note(150)], v: "b", after: 150, keep: 50 }).events.map((e) => e.at), range(101, 151).map((e) => e.at));
  assert.equal(withChange(newest, { events: [note(150)], v: "b", after: 150 }).events.length, 51);
  assert.equal(withOlder(newest, { events: range(90, 100), more: false }).older, "done");
  // Marked "loaded" before asking: a poll answered meanwhile cuts nothing off the front.
  const asking = { ...newest, older: "loaded" as const };
  assert.deepEqual(withChange(asking, { events: range(101, 160), v: "d" }).events.map((e) => e.at), range(100, 160).map((e) => e.at));

  // A newest list that does not reach back to what is held (a new conversation): from it alone.
  const fresh = withChange(held, { events: [note(500), note(501)], v: "e" });
  assert.deepEqual([fresh.events.map((e) => e.at), "older" in fresh], [[500, 501], false]);
});

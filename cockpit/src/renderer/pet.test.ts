import { test } from "node:test";
import assert from "node:assert/strict";

import { newActivity, onMenu, onOutput, onTick, onTurnEnd, petMood, type PetSession } from "./pet.ts";

/** Output every 100ms from `from` to `to`, as an agent's spinner draws. */
function stream(activity: ReturnType<typeof newActivity>, from: number, to: number): void {
  for (let at = from; at <= to; at += 100) onOutput(activity, at);
}

test("a keystroke's echo is not work, so it never turns into a wait", () => {
  const activity = newActivity();
  stream(activity, 0, 300);
  assert.equal(activity.working, false);
  assert.equal(onTick(activity, 10_000), false);
  assert.equal(activity.waiting, false);
});

test("work that goes quiet asks its record once, and stays working until the answer", () => {
  const activity = newActivity();
  stream(activity, 0, 5000);
  assert.equal(activity.working, true);
  assert.equal(activity.workSince, 0);
  assert.equal(onTick(activity, 6000), false, "not quiet long enough yet");
  assert.equal(onTick(activity, 8100), true);
  assert.equal(activity.working, true);
  assert.equal(activity.waiting, false);
  assert.equal(onTick(activity, 9000), false, "asked once, not every tick");
  assert.equal(onTick(activity, 60_000), false);
});

/** A session whose work has just gone quiet, with the answer it is owed. */
function quietWith(end: Parameters<typeof onTurnEnd>[1]) {
  const activity = newActivity();
  stream(activity, 0, 5000);
  onTick(activity, 8100);
  return { activity, told: onTurnEnd(activity, end, activity.lastOutput, 8200) };
}

test("what the record says becomes the session's state", () => {
  const finished = quietWith("finished");
  assert.deepEqual([finished.told, finished.activity.working, finished.activity.waiting, finished.activity.finished], [true, false, false, true]);
  // Only a menu on the screen asks: not words in the record, not a guess from rhythm.
  const asking = quietWith("waiting");
  assert.deepEqual([asking.told, asking.activity.working, asking.activity.waiting, asking.activity.finished], [true, false, false, false]);
  const unknown = quietWith("unknown");
  assert.deepEqual([unknown.told, unknown.activity.working, unknown.activity.waiting, unknown.activity.finished], [true, false, false, false]);
  for (const silent of ["stopped", "quiet"] as const) {
    const { told, activity } = quietWith(silent);
    assert.deepEqual([told, activity.working, activity.waiting, activity.finished], [false, false, false, false], silent);
    assert.equal(activity.doneAt, undefined);
  }
});

test("still busy: no tell, and more output asks again", () => {
  const { told, activity } = quietWith("busy");
  assert.equal(told, false);
  assert.equal(activity.working, true);
  assert.equal(onTick(activity, 30_000), false, "not read again on a timer");
  onOutput(activity, 31_000);
  assert.equal(onTick(activity, 34_100), true);
  assert.equal(onTurnEnd(activity, "finished", activity.lastOutput, 34_200), true);
  assert.equal(activity.finished, true);
});

test("an answer about a quiet that has since ended is dropped", () => {
  const activity = newActivity();
  stream(activity, 0, 5000);
  onTick(activity, 8100);
  const asked = activity.lastOutput;
  onOutput(activity, 8300);
  assert.equal(onTurnEnd(activity, "finished", asked, 8400), false);
  assert.deepEqual([activity.working, activity.finished], [true, false]);
});

test("new work clears the last turn's finish", () => {
  const { activity } = quietWith("finished");
  stream(activity, 20_000, 23_000);
  assert.deepEqual([activity.working, activity.finished, activity.workSince], [true, false, 20_000]);
});

test("Codex's own word for an approval turns the session at once, and its redrawing does not undo it", () => {
  const activity = newActivity();
  stream(activity, 0, 5000);
  assert.equal(onOutput(activity, 5100, "\x1b]7501;state=working:app=codex\x1b\\"), false);
  assert.equal(onOutput(activity, 5200, "\x1b]7501;state=blocked:app=codex:kind=permission\x1b\\"), true);
  assert.equal(activity.waiting, true);
  assert.equal(onOutput(activity, 6200, "\x1b]0;title\x07"), false);
  assert.equal(activity.waiting, true);
});

test("the duck stands for the session that needs the operator first", () => {
  const busy = newActivity();
  stream(busy, 0, 5000);
  const asking = newActivity();
  asking.waiting = true;
  const sessions: PetSession[] = [
    { key: "a", state: "ready", activity: busy },
    { key: "b", state: "ready", activity: asking },
  ];
  assert.deepEqual(petMood(sessions, 5000), { mood: "waiting", key: "b" });
  asking.waiting = false;
  assert.deepEqual(petMood(sessions, 5000), { mood: "working", key: "a" });
});

test("only a turn that ended well is done; a menu is waiting from the start", () => {
  const ready = (activity: ReturnType<typeof newActivity>): PetSession[] => [{ key: "a", state: "ready", activity }];
  assert.equal(petMood(ready(quietWith("finished").activity), 8300).mood, "done");
  const menu = newActivity();
  onMenu(menu, "Yes|No", 8000);
  assert.equal(petMood(ready(menu), 8300).mood, "waiting");
  assert.equal(petMood(ready(quietWith("finished").activity), 8200 + 2500).mood, "idle");
});

test("with nothing open, or nothing for a long while, it sleeps", () => {
  assert.equal(petMood([], 0).mood, "sleeping");
  const old = newActivity();
  onOutput(old, 0);
  assert.equal(petMood([{ key: "a", state: "ready", activity: old }], 11 * 60_000).mood, "sleeping");
});

test("a menu on the screen turns to the operator at once, even after a moment's work, and only once", () => {
  const activity = newActivity();
  onOutput(activity, 1000, "hello");
  assert.equal(activity.working, false, "too short to count as work");
  assert.equal(onMenu(activity, undefined, 1500), false);
  assert.equal(onMenu(activity, "Yes|No", 1500), true);
  assert.deepEqual([activity.waiting, activity.working, activity.finished], [true, false, false]);
  activity.waiting = false; // the operator looked
  assert.equal(onMenu(activity, "Yes|No", 2000), false, "the same menu still up");
  assert.equal(activity.waiting, false);
  assert.equal(onMenu(activity, undefined, 2500), false, "answered");
  assert.equal(onMenu(activity, "Yes|No", 3000), true, "asked again");
  assert.equal(onMenu(activity, "Red|Blue", 3500), true, "another question");
});

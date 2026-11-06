import assert from "node:assert/strict";
import { test } from "node:test";

import { badgePops, isFresh, lampLook, levelOffset, rowShifts, thereAndBack, typingStops } from "./motion.ts";

test("every session state has its own colour; only working moves, a faint breath every 2.4 s", () => {
  const working = lampLook("working");
  assert.equal(working.tone, "go");
  assert.equal(working.pulse!.period, 2400);
  assert.ok(working.pulse!.opacity >= 0.6);
  assert.deepEqual(lampLook("waiting"), { tone: "live" });
  assert.deepEqual(lampLook("done"), { tone: "dim" });
  assert.deepEqual(lampLook("failed"), { tone: "stop" });
  assert.deepEqual(lampLook("idle"), { tone: "idle" });
  assert.deepEqual(lampLook("shellOnly"), { tone: "muted", hollow: true });
});

test("PC states hold still", () => {
  assert.deepEqual(lampLook("live"), { tone: "go" });
  assert.deepEqual(lampLook("connecting"), { tone: "live" });
  assert.deepEqual(lampLook("off"), { tone: "idle" });
});

test("thereAndBack starts and ends at rest, so a native loop has no seam", () => {
  assert.equal(thereAndBack(0), 0);
  assert.equal(thereAndBack(0.5), 1);
  assert.equal(thereAndBack(1), 0);
});

test("typing stops stay strictly increasing: Animated throws otherwise", () => {
  for (const dot of [0, 1, 2]) {
    const { inputRange, outputRange } = typingStops(dot);
    assert.equal(inputRange.length, outputRange.length);
    assert.equal(inputRange[0], 0);
    assert.equal(inputRange.at(-1), 1);
    for (let i = 1; i < inputRange.length; i++) assert.ok(inputRange[i]! > inputRange[i - 1]!, `dot ${dot} stop ${i}`);
  }
});

test("levelOffset slides the fill by what is not shown", () => {
  assert.equal(levelOffset(1, 136), 0);
  assert.equal(levelOffset(0.25, 100), 75);
  assert.equal(levelOffset(0, 136), 136);
  assert.equal(levelOffset(2, 136), 0);
  assert.equal(levelOffset(-1, 136), 136);
  assert.equal(levelOffset(Number.NaN, 136), 136);
});

test("only rows newer than what was shown fade in", () => {
  assert.equal(isFresh(100, undefined), false, "the first load stays put");
  assert.equal(isFresh(100, 100), false);
  assert.equal(isFresh(50, 100), false, "show older stays put");
  assert.equal(isFresh(101, 100), true);
});

test("the badge pops on a rise only", () => {
  assert.equal(badgePops(0, 1), true);
  assert.equal(badgePops(2, 3), true);
  assert.equal(badgePops(3, 3), false);
  assert.equal(badgePops(3, 2), false);
});

test("a row that changes place starts from where it was; a new or still one does not move", () => {
  const heights = new Map([["a", 60], ["b", 40], ["c", 40], ["d", 40]]);
  const height = (id: string) => heights.get(id);
  assert.equal(rowShifts(["a", "b", "c"], ["a", "b", "c"], height).size, 0);
  assert.deepEqual([...rowShifts(["a", "b", "c"], ["c", "a", "b"], height)], [["c", 100], ["a", -40], ["b", -40]]);
  assert.deepEqual([...rowShifts(["a", "b"], ["d", "a", "b"], height)], [["a", -40], ["b", -40]]);
  assert.equal(rowShifts([], ["a", "b"], height).size, 0, "the first draw stays put");
});

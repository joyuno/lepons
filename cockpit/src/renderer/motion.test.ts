import { test } from "node:test";
import assert from "node:assert/strict";

import { cellChanges, dividerMove, openingBox, paneChange, placeChanges } from "./motion.ts";

test("one pane opening or closing is a change to show; a restore or a lone first pane is not", () => {
  assert.deepEqual(paneChange(["a"], ["a", "b"]), { added: "b" });
  assert.deepEqual(paneChange(["a", "b"], ["a"]), { gone: "b" });
  assert.deepEqual(paneChange(["a", "b"], ["a", "c"]), { added: "c", gone: "b" });
  assert.equal(paneChange(["a"], ["a"]), null);
  assert.equal(paneChange([], ["a"]), null);
  assert.equal(paneChange(["a"], ["b"]), null, "no pane stayed");
  assert.equal(paneChange(["a"], ["a", "b", "c"]), null);
});

test("a new pane opens from the edge of the pane it was split from, on the right side of it", () => {
  const to = { left: 500, top: 6, width: 490, height: 700 };
  const old = { left: 0, top: 0, width: 1000, height: 712 };
  assert.deepEqual(openingBox(to, "row", undefined, old), { ...to, left: 1000, width: 0 }, "after it: from its far edge");
  assert.deepEqual(openingBox({ ...to, left: 6 }, "row", old), { ...to, left: 0, width: 0 }, "before it: from its near edge");
  assert.deepEqual(openingBox(to, "column", undefined, old), { ...to, top: 712, height: 0 });
  assert.deepEqual(openingBox(to, "row"), { ...to, left: 745, width: 0 }, "nothing to go by: its own middle");
});

test("the divider runs out from the drop point, kept within its length, and back into it on a close", () => {
  const grown = dividerMove("row", 1000, 500, 10, 200, 60, true);
  assert.deepEqual(grown.box, { left: 499, top: 10, width: 2, height: 200 });
  assert.deepEqual(grown.frames[0], { transform: "translateX(500px)", clipPath: "inset(50px 0px 150px 0px)" });
  assert.deepEqual(grown.frames[1], { transform: "translateX(0px)", clipPath: "inset(0px 0px 0px 0px)" });
  const across = dividerMove("column", 0, 100, 0, 300, 9999, false);
  assert.deepEqual(across.box, { left: 0, top: 99, width: 300, height: 2 });
  assert.equal(across.frames[1]!.clipPath, "inset(0px 0px 0px 300px)");
});

test("rows move when the order changed, never when they were only pushed along", () => {
  const rows = (...pairs: Array<[string, number]>) => new Map(pairs);
  assert.deepEqual(placeChanges(rows(["a", 0], ["b", 30]), rows(["a", 0], ["b", 200])), [], "a tree opened above b");
  assert.deepEqual(placeChanges(rows(["a", 0], ["b", 30]), rows(["b", 0], ["a", 30])), [["b", 30], ["a", -30]]);
  assert.deepEqual(placeChanges(rows(["a", 0], ["b", 30]), rows(["b", 30])), [], "a is gone, b stayed put");
  assert.deepEqual(placeChanges(rows(["a", 0], ["b", 30]), rows(["b", 0])), [["b", 30]], "a is gone, b moved up");
  assert.deepEqual(placeChanges(rows(), rows(["a", 0])), [], "the first paint");
});

test("a battery's cells change from where they were, and a new battery fills nothing", () => {
  assert.deepEqual(cellChanges(undefined, 3), { gained: [], lost: [] });
  assert.deepEqual(cellChanges(2, 4), { gained: [2, 3], lost: [] });
  assert.deepEqual(cellChanges(4, 3), { gained: [], lost: [3] });
  assert.deepEqual(cellChanges(3, 3), { gained: [], lost: [] });
});

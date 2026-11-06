import { test } from "node:test";
import assert from "node:assert/strict";

import { dragLeavesScreen, firstDragX, reportedY, reportsDrags } from "./term-drag.ts";

test("a drag leaves the screen only past its top or bottom", () => {
  assert.equal(dragLeavesScreen("drag", 99, 100, 500), true);
  assert.equal(dragLeavesScreen("drag", 100, 100, 500), false);
  assert.equal(dragLeavesScreen("any", 499, 100, 500), false);
  assert.equal(dragLeavesScreen("any", 500, 100, 500), true);
});

test("only a program that is told about drags can take one", () => {
  for (const mode of ["none", "x10", "vt200"]) {
    assert.equal(reportsDrags(mode), false);
    assert.equal(dragLeavesScreen(mode, 0, 100, 500), false);
  }
  assert.equal(reportsDrags("drag"), true);
  assert.equal(reportsDrags("any"), true);
});

test("a handed-over drag stays off the last row, tmux's status line", () => {
  // 20 rows of 20px: the last row starts at 480.
  assert.equal(reportedY(300, 100, 500, 20), 300);
  assert.equal(reportedY(478, 100, 500, 20), 478);
  assert.equal(Math.floor((reportedY(490, 100, 500, 20) - 100) / 20), 18);
  assert.equal(Math.floor((reportedY(900, 100, 500, 20) - 100) / 20), 18);
  assert.equal(reportedY(50, 100, 500, 20), 50);
});

test("the first drag lands in another cell, whatever whole pixel it is cut to, and stays on the screen", () => {
  const cellOf = (x: number) => Math.floor((x - 100) / 10);
  for (const x of [100, 105, 109, 490, 500, 890, 899]) {
    const moved = Math.trunc(firstDragX(x, 100, 900, 80));
    assert.notEqual(cellOf(moved), cellOf(x));
    assert.ok(moved >= 100 && moved < 900);
  }
});

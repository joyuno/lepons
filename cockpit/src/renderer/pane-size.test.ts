import { test } from "node:test";
import assert from "node:assert/strict";

import { canSplit, paneFits, splitOrder } from "./pane-size.ts";

// Cascadia Mono at 13px is about 8 × 17.
const W = 8;
const H = 17;

test("a 1080p window at 125% scaling (1536 CSS px) gets four panes", () => {
  // The terminal area beside the rail: about 1290 × 830.
  assert.equal(canSplit(1290, 830, W, H, "row"), true);
  assert.equal(canSplit(1290, 830, W, H, "column"), true);
  // Each half splits once more the other way, not again the same way.
  assert.equal(canSplit(630, 818, W, H, "column"), true);
  assert.equal(canSplit(630, 818, W, H, "row"), false);
  assert.equal(canSplit(630, 394, W, H, "column"), false);
});

test("only the split's own direction is measured", () => {
  // Wide and short: side by side is fine, stacked is not.
  assert.equal(canSplit(2400, 400, W, H, "row"), true);
  assert.equal(canSplit(2400, 400, W, H, "column"), false);
});

test("the edge is 50 columns by 15 rows", () => {
  assert.equal(paneFits(50 * W + 28, 15 * H + 58, W, H), true);
  assert.equal(paneFits(50 * W + 27, 15 * H + 58, W, H), false);
  assert.equal(paneFits(50 * W + 28, 15 * H + 57, W, H), false);
});

test("a bigger font needs a bigger pane", () => {
  assert.equal(canSplit(1290, 830, W * 2, H, "row"), false);
});

test("a 24-inch 1080p screen at 100% fits three panes side by side", () => {
  // The terminal area beside the rail: about 1675 wide.
  assert.equal(canSplit(1675, 1000, W, H, "row", 3), true);
  assert.equal(canSplit(1675, 1000, W, H, "row", 4), false);
});

test("a 24-inch 1080p screen stacks three panes, not four", () => {
  assert.equal(canSplit(1675, 1000, W, H, "column", 3), true);
  assert.equal(canSplit(1675, 1000, W, H, "column", 4), false);
});

// A tall monitor stacks panes; opening a session there used to try only a
// split to the right, too narrow on a portrait screen, so nothing opened.
test("a new pane goes along the longer side first, the other side second", () => {
  assert.deepEqual(splitOrder(800, 1700), ["column", "row"]);
  assert.deepEqual(splitOrder(1300, 800), ["row", "column"]);
  assert.deepEqual(splitOrder(900, 900), ["row", "column"]);
});

test("an area shared the other way counts only each pane's part of it", () => {
  // Two stacked in a short window: side by side fits once one has left, not while both are there.
  assert.equal(canSplit(1144, 576, W, H, "row"), true);
  assert.equal(canSplit(1144, 576, W, H, "row", 2, 2), false);
  // Three stacked, one leaving: the two left take half each.
  assert.equal(canSplit(1144, 900, W, H, "row", 2, 2), true);
  assert.equal(canSplit(800, 900, W, H, "column", 2, 2), false);
});

import { test } from "node:test";
import assert from "node:assert/strict";

import { positionAt, thumbOf } from "./tmux-bar.ts";

test("a tmux pane's thumb: at the bottom when not scrolled, at the top at the oldest line, none with no history", () => {
  const view = { history: 960, position: 0, height: 40 };
  const bottom = thumbOf(view, 400)!;
  assert.equal(bottom.height, 24, "a long history keeps the thumb grabbable");
  assert.equal(bottom.top, 376);
  assert.equal(thumbOf({ ...view, position: 960 }, 400)!.top, 0);
  assert.equal(thumbOf({ ...view, position: 480 }, 400)!.top, 188);
  assert.equal(thumbOf({ history: 0, position: 0, height: 40 }, 400), undefined);
  assert.equal(thumbOf({ history: 40, position: 0, height: 40 }, 400)!.height, 200, "half history, half screen");
});

test("dragging the thumb asks for the view it stands at, clamped to the track", () => {
  const view = { history: 960, position: 0, height: 40 };
  assert.equal(positionAt(376, view, 400, 24), 0);
  assert.equal(positionAt(0, view, 400, 24), 960);
  assert.equal(positionAt(188, view, 400, 24), 480);
  assert.equal(positionAt(-50, view, 400, 24), 960);
  assert.equal(positionAt(999, view, 400, 24), 0);
});

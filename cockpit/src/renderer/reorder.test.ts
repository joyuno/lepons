import { test } from "node:test";
import assert from "node:assert/strict";

import { between, moved } from "./reorder.ts";

test("moves an id before or after another", () => {
  assert.deepEqual(moved(["a", "b", "c"], "c", "a", false), ["c", "a", "b"]);
  assert.deepEqual(moved(["a", "b", "c"], "a", "c", true), ["b", "c", "a"]);
  assert.deepEqual(moved(["a", "b", "c"], "a", "b", false), ["a", "b", "c"]);
});

test("picks the run between two ids, either way round", () => {
  assert.deepEqual(between(["a", "b", "c", "d"], "b", "d"), ["b", "c", "d"]);
  assert.deepEqual(between(["a", "b", "c", "d"], "c", "a"), ["a", "b", "c"]);
  assert.deepEqual(between(["a", "b"], "b", "b"), ["b"]);
  assert.deepEqual(between(["a", "b"], "gone", "b"), ["b"]);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { navigate } from "./file-history.ts";

test("folder history goes back and forward and drops the forward branch after opening another folder", () => {
  let h = { paths: [""], index: 0 };
  h = navigate(h, { open: "src" });
  h = navigate(h, { open: "src/ui" });
  h = navigate(h, "back");
  assert.equal(h.paths[h.index], "src");
  h = navigate(h, "forward");
  assert.equal(h.paths[h.index], "src/ui");
  h = navigate(navigate(h, "back"), { open: "src/api" });
  assert.deepEqual(h, { paths: ["", "src", "src/api"], index: 2 });
  assert.deepEqual(navigate(h, "forward"), h);
  assert.deepEqual(navigate(navigate(navigate(h, "back"), "back"), "back"), { paths: ["", "src", "src/api"], index: 0 });
});

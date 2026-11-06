import { test } from "node:test";
import assert from "node:assert/strict";
import { previewOrShare } from "./native-preview.ts";

test("sharing is tried when preview is unavailable or throws", async () => {
  for (const preview of [async () => false, async () => { throw new Error("viewer"); }]) {
    let shared = 0;
    assert.equal(await previewOrShare(preview, async () => { shared++; return true; }), true);
    assert.equal(shared, 1);
  }
  assert.equal(await previewOrShare(async () => true, async () => { throw new Error("not called"); }), true);
  assert.equal(await previewOrShare(async () => false, async () => false), false);
  assert.equal(await previewOrShare(async () => false, async () => { throw new Error("share"); }), false);
});

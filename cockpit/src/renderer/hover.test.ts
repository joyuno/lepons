import { test } from "node:test";
import assert from "node:assert/strict";

// The tip element and the document listeners are built on first use, not at
// import time. That is the only thing about this module a DOM-less runner can
// check, and it is worth checking: moving any of it back to module scope
// breaks every other renderer test that transitively imports hover.ts.
test("hover.ts imports without a document", async () => {
  await assert.doesNotReject(import("./hover.ts"));
});

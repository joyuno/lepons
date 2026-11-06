import { test } from "node:test";
import assert from "node:assert/strict";

import { dialogRequest, replyIndex } from "./app-dialog.ts";

test("a question keeps its buttons and its default and cancel answers", () => {
  assert.deepEqual(
    dialogRequest("r1", { type: "question", message: "m", detail: "d", buttons: ["삭제", "취소"], defaultId: 1, cancelId: 1 }, "확인"),
    { requestId: "r1", type: "question", message: "m", detail: "d", buttons: ["삭제", "취소"], defaultId: 1, cancelId: 1 },
  );
});

test("a notice with no buttons gets one OK button, as the native box did", () => {
  assert.deepEqual(dialogRequest("r2", { message: "m" }, "확인"), {
    requestId: "r2",
    type: "none",
    message: "m",
    buttons: ["확인"],
    defaultId: 0,
    cancelId: 0,
  });
});

test("an id past the buttons falls back to the first button", () => {
  const request = dialogRequest("r3", { message: "m", buttons: ["a", "b"], defaultId: 5, cancelId: -1 }, "확인");
  assert.equal(request.defaultId, 0);
  assert.equal(request.cancelId, 0);
});

test("only a button index is taken from the page; anything else is cancel", () => {
  const request = dialogRequest("r4", { message: "m", buttons: ["a", "b", "c"], cancelId: 2 }, "확인");
  assert.equal(replyIndex(request, 1), 1);
  assert.equal(replyIndex(request, 0), 0);
  for (const bad of [3, -1, 1.5, "0", undefined, null]) assert.equal(replyIndex(request, bad), 2, String(bad));
});

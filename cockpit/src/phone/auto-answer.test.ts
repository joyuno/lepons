import assert from "node:assert/strict";
import { test } from "node:test";

import { autoAnswerWait, autoChoice, autoMinutes } from "./auto-answer.ts";

test("a question is answered only with the one option the agent marked as its pick", () => {
  assert.equal(autoChoice([{ n: 1, label: "Postgres" }, { n: 2, label: "SQLite (Recommended)" }, { n: 3, label: "Type something.", freeText: true }])?.n, 2);
  assert.equal(autoChoice([{ n: 1, label: "탭 두 개" }, { n: 2, label: "탭 하나 (추천)" }])?.n, 2);
  assert.equal(autoChoice([{ n: 1, label: "Postgres" }, { n: 2, label: "SQLite" }]), undefined, "no mark, no answer");
  assert.equal(autoChoice([{ n: 1, label: "Update now" }, { n: 2, label: "Skip" }]), undefined);
  assert.equal(autoChoice([{ n: 1, label: "Overwrite (not recommended)" }, { n: 2, label: "Keep" }]), undefined);
  assert.equal(autoChoice([{ n: 1, label: "A (Recommended)" }, { n: 2, label: "B (Recommended)" }]), undefined, "two marks: unclear");
  assert.equal(autoChoice([{ n: 1, label: "Type something.", freeText: true }]), undefined);
});

test("a multi-select question is never answered by itself: a digit only ticks a box there", () => {
  assert.equal(autoChoice([{ n: 1, label: "Red (Recommended)", checked: false }, { n: 2, label: "Blue", checked: false }]), undefined);
});

test("an approval is never answered by itself", () => {
  assert.equal(autoChoice([{ n: 1, label: "Yes" }, { n: 2, label: "Yes, and don't ask again" }, { n: 3, label: "No (Recommended)" }]), undefined);
});

test("off until the box is ticked; then the wait picked, or 10 minutes", () => {
  assert.equal(autoAnswerWait(null, "30"), 0, "never ticked");
  assert.equal(autoAnswerWait("0", "30"), 0);
  assert.equal(autoAnswerWait("1", "30"), 30);
  assert.equal(autoAnswerWait("1", null), 10);
  assert.equal(autoMinutes("7"), 10, "only a wait the setting offers");
});

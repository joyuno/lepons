import { strict as assert } from "node:assert";
import { test } from "node:test";

import { ALWAYS, ONCE, REFUSE, approveDelegation, instructionsPreview } from "./delegate-approval.ts";

test("a trusted machine runs without a question; an untrusted one only on a yes", async () => {
  let asked = 0;
  let remembered = 0;
  const ask = (response: number) => async () => { asked++; return response; };
  const remember = () => { remembered++; };
  assert.equal(await approveDelegation(true, ask(REFUSE), remember), "allowed");
  assert.equal(asked, 0);
  assert.equal(await approveDelegation(false, ask(REFUSE), remember), "refused");
  assert.equal(await approveDelegation(false, ask(ONCE), remember), "allowed");
  assert.equal(remembered, 0, "once is not remembered");
  assert.equal(await approveDelegation(false, ask(ALWAYS), remember), "allowed");
  assert.equal(remembered, 1);
  // A closed window answers its cancel button, or some other index: a no.
  assert.equal(await approveDelegation(false, ask(7), remember), "refused");
  assert.equal(await approveDelegation(false, () => Promise.reject(new Error("gone")), remember), "refused");
});

test("no window to ask in, or no answer in time, is a refusal", async () => {
  assert.equal(await approveDelegation(false, undefined, () => {}), "unanswered");
  let answer: (response: number) => void = () => {};
  let remembered = false;
  const pending = new Promise<number>((resolve) => { answer = resolve; });
  assert.equal(await approveDelegation(false, () => pending, () => { remembered = true; }, 20), "unanswered");
  // "Always" pressed after the wait still holds for the next task.
  answer(ALWAYS);
  await pending;
  await new Promise((done) => setImmediate(done));
  assert.equal(remembered, true);
});

test("the question shows the start of long instructions", () => {
  assert.equal(instructionsPreview("  fix the build \n"), "fix the build");
  assert.equal(instructionsPreview("x".repeat(301)), `${"x".repeat(300)}…`);
});

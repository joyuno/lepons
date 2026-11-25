import assert from "node:assert/strict";
import { test } from "node:test";

import type { WorkflowItem } from "../shared/ipc.ts";
import { lastAnswer } from "./last-answer.ts";

const prompt = (at: number, text: string): WorkflowItem => ({ kind: "prompt", at, text });
const note = (at: number, text: string): WorkflowItem => ({ kind: "note", at, text });
const sub = (at: number, result?: string): WorkflowItem => ({ kind: "subagent", at, description: "d", instructions: "i", ...(result === undefined ? {} : { result, resultAt: at + 1 }) });

test("a finished turn gives its last note cut to two sentences", () => {
  const events = [prompt(1, "go"), note(2, "하나입니다. 둘입니다. 셋입니다.")];
  assert.equal(lastAnswer({ events }), "하나입니다. 둘입니다.");
});

test("no answer while a subagent still runs, or when work came after the note", () => {
  assert.equal(lastAnswer({ events: [prompt(1, "go"), sub(2), note(3, "끝.")] }), undefined);
  assert.equal(lastAnswer({ events: [prompt(1, "go"), note(2, "중간."), { kind: "action", at: 3, text: "Bash", labels: ["Bash"] }] }), undefined);
  assert.equal(lastAnswer({ events: [prompt(1, "go"), sub(2, "ok"), note(3, "끝.")] }), "끝.");
});

test("a note written before `since` is an older turn's and gives no answer", () => {
  const events = [prompt(1, "go"), note(50, "옛 답.")];
  assert.equal(lastAnswer({ events }, 100), undefined);
  assert.equal(lastAnswer({ events }, 50), "옛 답.");
});

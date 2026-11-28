import { strict as assert } from "node:assert";
import { test } from "node:test";

import type { ApprovalAsk, ApprovalRequest } from "../shared/approval.ts";
import { approvalLine } from "./approval.ts";

const request = (name: string): ApprovalRequest => ({
  kind: "schedule", source: "pc", machine: "pc", folder: "/w", agent: "Claude Code", executor: "claude",
  name, when: "0 9 * * *", instructions: "x", canBot: false,
});
const allow = (ask: ApprovalAsk) => {
  const { name, when, instructions } = ask as Extract<ApprovalAsk, { kind: "schedule" }>;
  return { answer: "allowed", as: "schedule", name, when, instructions };
};
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("requests are shown one at a time, in order", async () => {
  const shown: ApprovalAsk[] = [];
  const line = approvalLine((ask) => { shown.push(ask); return true; });
  const first = line.ask(request("a"));
  const second = line.ask(request("b"));
  assert.deepEqual(shown.map((ask) => ask.name), ["a"]);
  line.reply(shown[0]!.requestId, allow(shown[0]!));
  assert.equal((await first).answer, "allowed");
  assert.deepEqual(shown.map((ask) => ask.name), ["a", "b"]);
  assert.notEqual(shown[0]!.requestId, shown[1]!.requestId);
  line.reply(shown[1]!.requestId, { answer: "refused" });
  assert.deepEqual(await second, { answer: "refused" });
});

test("silence for the wait is unanswered; an edit restarts the wait", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const shown: ApprovalAsk[] = [];
  const line = approvalLine((ask) => { shown.push(ask); return true; }, 1000);
  let answer: unknown;
  void line.ask(request("a")).then((reply) => { answer = reply; });
  t.mock.timers.tick(900);
  line.editing(shown[0]!.requestId);
  t.mock.timers.tick(900);
  await tick();
  assert.equal(answer, undefined, "the edit gave it the whole wait again");
  t.mock.timers.tick(100);
  await tick();
  assert.deepEqual(answer, { answer: "unanswered" });
  // An answer after the wait counts for nothing.
  line.reply(shown[0]!.requestId, allow(shown[0]!));
  assert.deepEqual(answer, { answer: "unanswered" });
});

test("a request ends unanswered at the ceiling from when it was asked, edits or not", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const shown: ApprovalAsk[] = [];
  const line = approvalLine((ask) => { shown.push(ask); return true; }, 1000, 3000);
  const answers: unknown[] = [undefined, undefined];
  void line.ask(request("a")).then((reply) => { answers[0] = reply; });
  void line.ask(request("b")).then((reply) => { answers[1] = reply; });
  for (let at = 0; at < 2700; at += 900) {
    t.mock.timers.tick(900);
    line.editing(shown[0]!.requestId);
  }
  await tick();
  assert.deepEqual(answers, [undefined, undefined]);
  t.mock.timers.tick(300);
  await tick();
  // Both were asked at once: the one waiting in line reaches the ceiling too.
  assert.deepEqual(answers, [{ answer: "unanswered" }, { answer: "unanswered" }]);
  assert.ok(shown[0]!.until > 0);
});

test("no window answers unanswered and the next request still shows", async () => {
  const shown: string[] = [];
  let open = false;
  const line = approvalLine((ask) => { shown.push(ask.name); return open; });
  assert.deepEqual(await line.ask(request("a")), { answer: "unanswered" });
  open = true;
  const second = line.ask(request("b"));
  assert.deepEqual(shown, ["a", "b"]);
  line.gone();
  assert.deepEqual(await second, { answer: "unanswered" });
});

test("a window that goes away answers every waiting request unanswered", async () => {
  const shown: string[] = [];
  const line = approvalLine((ask) => { shown.push(ask.name); return true; });
  const all = [line.ask(request("a")), line.ask(request("b")), line.ask(request("c"))];
  line.gone();
  assert.deepEqual(await Promise.all(all), [{ answer: "unanswered" }, { answer: "unanswered" }, { answer: "unanswered" }]);
  assert.deepEqual(shown, ["a"], "nothing queued was shown to a window that is gone");
});

test("a reply for another request changes nothing", async () => {
  const shown: ApprovalAsk[] = [];
  const line = approvalLine((ask) => { shown.push(ask); return true; });
  let answer: unknown;
  void line.ask(request("a")).then((reply) => { answer = reply; });
  line.reply("someone-else", allow(shown[0]!));
  line.editing("someone-else");
  await tick();
  assert.equal(answer, undefined);
  line.reply(shown[0]!.requestId, allow(shown[0]!));
  await tick();
  assert.equal((answer as { answer: string } | undefined)?.answer, "allowed");
});

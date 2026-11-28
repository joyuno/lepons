import { strict as assert } from "node:assert";
import { test } from "node:test";

import { t } from "../i18n/i18n.ts";
import { describeWhen } from "../agent/schedule.ts";
import { changeNote, changesOf, replyOf, scheduleFromReply, type ApprovalRequest } from "./approval.ts";

const request: ApprovalRequest = {
  kind: "schedule", source: "laptop", machine: "laptop", folder: "C:/work", agent: "Claude Code", executor: "claude",
  name: "nightly", when: "40 20 * * *", instructions: "check the build", canBot: true,
};
const allow = (fields: Record<string, unknown> = {}) => ({ answer: "allowed", as: "schedule", name: request.name, when: request.when, instructions: request.instructions, ...fields });

test("a reply that is not an allow is a refusal", () => {
  for (const raw of [null, "x", { answer: "maybe" }, { answer: "unanswered" }, { answer: "allowed" }, { answer: "allowed", as: "schedule", name: "a" }]) {
    assert.deepEqual(replyOf(request, raw), { answer: "refused" });
  }
  assert.deepEqual(replyOf(request, allow({ name: 7 })), { answer: "allowed", as: "schedule", name: "7", when: request.when, instructions: request.instructions });
});

test("a bot reply is refused where the request cannot become a bot", () => {
  const bot = { answer: "allowed", as: "bot", name: "n", executor: "claude", role: "r", jobs: [{ when: "daily 09:00", instructions: "x" }] };
  assert.deepEqual(replyOf({ ...request, canBot: false }, bot), { answer: "refused" });
  assert.equal(replyOf(request, bot).answer, "allowed");
  assert.deepEqual(replyOf(request, { ...bot, jobs: "x" }), { answer: "refused" });
});

test("an unknown AI in a reply falls back to the request's", () => {
  const reply = replyOf(request, { answer: "allowed", as: "bot", name: "n", executor: "rm -rf", role: "r", jobs: [] });
  assert.equal(reply.answer === "allowed" && reply.as === "bot" && reply.executor, "claude");
});

test("the same time spelled differently is no change", () => {
  const reply = replyOf({ ...request, when: "0 9 * * *" }, allow({ when: "daily 09:00" }));
  assert.ok(reply.answer === "allowed");
  assert.deepEqual(changesOf({ ...request, when: "0 9 * * *" }, reply), []);
});

test("changes name each edited field, old and new", () => {
  const reply = replyOf(request, allow({ when: "daily 14:30", name: "evening" }));
  assert.ok(reply.answer === "allowed");
  assert.deepEqual(changesOf(request, reply), [
    { field: "name", from: "nightly", to: "evening" },
    { field: "when", from: describeWhen({ minute: 40, hour: 20 }), to: describeWhen({ minute: 30, hour: 14 }) },
  ]);
  const bot = replyOf(request, { answer: "allowed", as: "bot", name: "nightly", executor: "codex", role: "r", jobs: [{ when: "40 20 * * *", instructions: "check it all" }] });
  assert.ok(bot.answer === "allowed");
  assert.deepEqual(changesOf(request, bot).map((change) => change.field), ["agent", "instructions"]);
});

test("the note reads as the spec words it", () => {
  const reply = replyOf(request, allow({ when: "daily 14:30" }));
  assert.ok(reply.answer === "allowed");
  assert.equal(changeNote(changesOf(request, reply), t), "허용됨(사용자가 고침: 시각 매일 20:40→매일 14:30)");
  assert.equal(changeNote([], t), "");
});

test("scheduleFromReply re-checks edited values", () => {
  const bad = scheduleFromReply({ answer: "allowed", as: "schedule", name: "n", when: "25:99", instructions: "x" });
  assert.ok(!bad.ok && bad.error.startsWith("unsupported_schedule"));
  const empty = scheduleFromReply({ answer: "allowed", as: "schedule", name: "n", when: "daily 14:30", instructions: "  " });
  assert.ok(!empty.ok && empty.error.startsWith("no_instructions"));
  const good = scheduleFromReply({ answer: "allowed", as: "schedule", name: "n", when: "daily 14:30", instructions: "x" });
  assert.ok(good.ok && good.cron === "30 14 * * *");
});

const botRequest: ApprovalRequest = {
  kind: "bot", source: "laptop", machine: "laptop", folder: "C:/work", editing: false, name: "리뷰어", executor: "claude",
  role: "PR을 살핀다", jobs: [{ id: "j-1", when: "0 9 * * *", instructions: "어제 PR을 본다" }], notes: [], canSchedule: true,
};
const botAllow = (fields: Record<string, unknown> = {}) => ({
  answer: "allowed", as: "bot", name: botRequest.name, executor: "claude", role: botRequest.role,
  jobs: [{ id: "j-1", when: "daily 09:00", instructions: "어제 PR을 본다" }], ...fields,
});

test("bot changes list role, AI and jobs", () => {
  const same = replyOf(botRequest, botAllow());
  assert.ok(same.answer === "allowed");
  assert.deepEqual(changesOf(botRequest, same), [], "the same time spelled differently is no change");
  const edited = replyOf(botRequest, botAllow({
    role: "새 역할", executor: "codex",
    jobs: [{ id: "j-1", when: "daily 10:00", instructions: "어제 PR을 본다" }, { when: "daily 18:00", instructions: "정리" }],
  }));
  assert.ok(edited.answer === "allowed");
  assert.deepEqual(changesOf(botRequest, edited), [
    { field: "agent", from: "Claude Code", to: "Codex" },
    { field: "role", from: "PR을 살핀다", to: "새 역할" },
    {
      field: "jobs", from: `${describeWhen({ minute: 0, hour: 9 })}: 어제 PR을 본다`,
      to: `${describeWhen({ minute: 0, hour: 10 })}: 어제 PR을 본다; ${describeWhen({ minute: 0, hour: 18 })}: 정리`,
    },
  ]);
  assert.deepEqual(replyOf(botRequest, { answer: "allowed", as: "schedule", name: "n", when: "daily 09:00", instructions: "x" }), { answer: "refused" },
    "a bot request is not allowed as a schedule");
});

test("an edit keeps the bot's name", () => {
  const editing = replyOf({ ...botRequest, editing: true }, botAllow({ name: "다른 이름" }));
  assert.ok(editing.answer === "allowed");
  assert.equal(editing.name, "리뷰어");
  assert.deepEqual(changesOf({ ...botRequest, editing: true }, editing), []);
  const fresh = replyOf(botRequest, botAllow({ name: "다른 이름" }));
  assert.ok(fresh.answer === "allowed");
  assert.equal(fresh.name, "다른 이름", "a new bot's name can be edited");
});

test("a new bot's request may come back as schedules, and only one that can be made so", () => {
  const instead = replyOf(botRequest, botAllow({ as: "schedules" }));
  assert.equal(instead.answer === "allowed" && instead.as, "schedules");
  assert.ok(instead.answer === "allowed");
  assert.deepEqual(changesOf(botRequest, instead), [], "the same jobs and role: nothing changed");
  assert.deepEqual(replyOf({ ...botRequest, canSchedule: false }, botAllow({ as: "schedules" })), { answer: "refused" }, "an edited bot stays a bot");
  assert.deepEqual(replyOf(botRequest, botAllow({ as: "schedules", jobs: [] })), { answer: "refused" }, "no job: nothing to make");
  const scheduleRequest = { kind: "schedule", source: "s", machine: "m", folder: "f", agent: "Claude Code", executor: "claude", name: "n", when: "0 9 * * *", instructions: "x", canBot: true } as const;
  assert.deepEqual(replyOf(scheduleRequest, botAllow({ as: "schedules" })), { answer: "refused" }, "a schedule request is not made schedules");
});

import { test } from "node:test";
import assert from "node:assert/strict";

import { botLamp, botReply, botStatus, dayTime, inPcOrder, movedPc, nextBot, runTone, todayPoints, whenText, type TimeWords } from "./bots.ts";
import { botsOf, whenOf } from "./validate.ts";

const words: TimeWords = { today: "오늘", tomorrow: "내일", yesterday: "어제", hourly: "매시 {minute}분", daily: "매일 {time}", weekdays: ["일", "월", "화", "수", "목", "금", "토"] };
// A Wednesday, 13:30 local time.
const now = new Date(2026, 10, 25, 13, 30);
const local = (day: number, hour: number, minute = 0) => new Date(2026, 10, day, hour, minute).toISOString();

test("times read as today, tomorrow, yesterday, a weekday this week, else the date", () => {
  assert.equal(dayTime(local(25, 14), now, words), "오늘 14:00");
  assert.equal(dayTime(local(26, 9), now, words), "내일 09:00");
  assert.equal(dayTime(local(24, 9, 5), now, words), "어제 09:05");
  assert.equal(dayTime(local(30, 8, 30), now, words), "월 08:30");
  assert.equal(dayTime(local(23, 9), now, words), "11/23 09:00");
});

test("a job's time is worded as the PC words it", () => {
  assert.equal(whenText({ minute: 5 }, words), "매시 05분");
  assert.equal(whenText({ minute: 0, hour: 9 }, words), "매일 09:00");
  assert.equal(whenText({ minute: 30, hour: 8, days: [1, 3] }, words), "월, 수 08:30");
});

test("a bot's lamp and chip: paused and running first, then how its last run ended", () => {
  assert.equal(botLamp({ state: "running" }), "working");
  assert.equal(botLamp({ state: "missed" }), "waiting");
  assert.equal(botLamp({ state: "paused" }), "done");
  assert.deepEqual(botStatus({ state: "paused", last: { at: "x", status: "done" } }), { word: "paused", tone: "muted" });
  assert.deepEqual(botStatus({ state: "running", last: null }), { word: "running", tone: "go" });
  assert.deepEqual(botStatus({ state: "idle", last: null }), { word: "never", tone: "muted" });
  assert.deepEqual(botStatus({ state: "idle", last: { at: "t", status: "done" } }), { word: "done", at: "t", tone: "go" });
  assert.deepEqual(botStatus({ state: "missed", last: { at: "t", status: "missed" } }), { word: "missed", at: "t", tone: "live" });
  assert.equal(runTone("skipped"), "muted");
  assert.equal(runTone("failed"), "stop");
});

test("today's line: due times of today for bots not paused, in order; the next one is the soonest", () => {
  const bots = [
    { name: "정리봇", paused: false, next: local(25, 14), jobs: [{ id: "a", when: { minute: 0, hour: 14 }, text: "" }, { id: "b", when: { minute: 0, hour: 9 }, text: "" }] },
    { name: "주간", paused: true, next: local(25, 13, 45), jobs: [{ id: "c", when: { minute: 45, hour: 13 }, text: "" }] },
    // Mondays only: not today.
    { name: "월요일", paused: false, next: local(30, 8), jobs: [{ id: "d", when: { minute: 0, hour: 8, days: [1] }, text: "" }] },
    { name: "매시", paused: false, next: local(25, 14, 10), jobs: [{ id: "e", when: { minute: 10, days: [3] }, text: "" }] },
  ];
  const points = todayPoints(bots, now);
  assert.equal(points.length, 2 + 24);
  assert.deepEqual(points.slice(0, 2), [{ at: 10, name: "매시" }, { at: 70, name: "매시" }]);
  assert.ok(points.some((point) => point.at === 9 * 60 && point.name === "정리봇"));
  assert.ok(!points.some((point) => point.name === "주간" || point.name === "월요일"));
  assert.deepEqual(nextBot(bots), { at: local(25, 14), name: "정리봇" });
  assert.equal(nextBot([{ name: "x", paused: false, next: null }]), undefined);
});

test("the PC order saved on the phone: saved first, new PCs after, a move saves only the PCs there now", () => {
  const groups = ["a", "b", "c", "d"];
  assert.deepEqual(inPcOrder(groups, (g) => g, ["c", "gone", "a"]), ["c", "a", "b", "d"]);
  assert.deepEqual(inPcOrder(groups, (g) => g, []), groups);
  assert.deepEqual(movedPc(["c", "a", "b"], "a", -1), ["a", "c", "b"]);
  assert.deepEqual(movedPc(["c", "a", "b"], "b", 1), ["c", "a", "b"], "the last one stays last");
  assert.deepEqual(movedPc(["c", "a"], "gone", 1), ["c", "a"]);
});

test("demo: three made-up bots the app's reader keeps whole, one missed and one paused, and buttons that answer as the PC", async () => {
  const { createDemo } = await import("../demo.ts");
  const demo = createDemo(() => undefined);
  try {
    const body = (await demo.request("GET", "/api/bots")).body as { bots: unknown[] };
    const bots = botsOf(body)!;
    assert.deepEqual(bots, body.bots, "nothing the demo sends is dropped");
    assert.deepEqual(bots.map((bot) => bot.state), ["idle", "missed", "paused"]);
    const post = async (path: string, value: Record<string, unknown>) => botReply(await demo.request("POST", path, { body: value }));
    assert.equal(await post("/api/bots/run", { id: bots[2]!.id }), "paused");
    assert.equal(await post("/api/bots/run", { id: "nope" }), "gone");
    assert.equal(await post("/api/bots/missed", { id: bots[1]!.id, run: false }), "ok");
    assert.equal(await post("/api/bots/run", { id: bots[0]!.id }), "ok");
    assert.equal(await post("/api/bots/run", { id: bots[0]!.id }), "busy");
    const after = botsOf((await demo.request("GET", "/api/bots")).body)!;
    assert.deepEqual([after[0]!.state, after[1]!.missed], ["running", null]);
  } finally {
    demo.stop();
  }
});

test("a bot button's answer: done, busy, paused, a bot gone, else not reached", () => {
  assert.equal(botReply({ status: 200, body: { ok: true } }), "ok");
  assert.equal(botReply({ status: 409, body: { error: "busy" } }), "busy");
  assert.equal(botReply({ status: 409, body: { error: "paused" } }), "paused");
  assert.equal(botReply({ status: 404, body: { error: "bot" } }), "gone");
  // A PC without the route: not a deleted bot.
  assert.equal(botReply({ status: 404, body: { error: "not found" } }), "failed");
  assert.equal(botReply(undefined), "failed");
});

test("a bot that does not fit is dropped; a bad job or run only itself; no path outside its folder", () => {
  const good = {
    id: "b1", name: "정리봇", pc: "이 PC", pcId: "0123456789abcdef", folder: "work", executor: "Claude Code", fresh: true, paused: false, state: "idle",
    next: null, last: null, missed: null, sessionId: null,
    jobs: [{ id: "j1", when: { minute: 0, hour: 9 }, text: "a" }, { id: "j2", when: { minute: 60 }, text: "b" }],
    runs: [{ at: "2026-11-25T00:00:00.000Z", status: "done" }, { at: "2026-11-25T00:00:00.000Z", status: "sent" }, { at: "2026-11-25T00:00:00.000Z", status: "skipped", reason: "<b>" }],
    profilePath: "../x.md",
  };
  const [bot] = botsOf({ bots: [good, { ...good, state: "asleep" }, { ...good, pcId: "C:/node" }] })!;
  assert.equal(botsOf({ bots: [good, { ...good, state: "asleep" }] })!.length, 1);
  assert.deepEqual(bot!.jobs.map((job) => job.id), ["j1"]);
  assert.deepEqual(bot!.runs, [{ at: "2026-11-25T00:00:00.000Z", status: "done" }, { at: "2026-11-25T00:00:00.000Z", status: "skipped" }]);
  assert.equal("profilePath" in bot!, false);
  assert.equal(botsOf({ bots: [{ ...good, pcId: "C:/node" }] })!.length, 0);
  assert.equal(botsOf({ bots: [{ ...good, missed: { count: 0, at: "2026-11-25T00:00:00.000Z", jobId: "j1" } }] })!.length, 0, "a missed notice counts one at least");
  assert.deepEqual(botsOf({ bots: [{ ...good, missed: { count: 2, at: "2026-11-25T00:00:00.000Z", jobId: "j1" } }] })![0]!.missed, { count: 2, at: "2026-11-25T00:00:00.000Z", jobId: "j1" });
  assert.equal(whenOf({ minute: 0, hour: 9, days: [] }), undefined);
  assert.deepEqual(whenOf({ minute: 0, hour: 9, days: [7, 1] }), { minute: 0, hour: 9, days: [1] });
  assert.equal(botsOf("nope"), undefined);
});

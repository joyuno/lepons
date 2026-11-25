import { test } from "node:test";
import assert from "node:assert/strict";

import { fromCache, groupRows, jobActions, linkable, listRows, pageOf, rowKind, sameJobs, todayPoints } from "./automation.ts";
import type { BotRow, ScheduleRow } from "../shared/ipc.ts";
import type { OsJob } from "../agent/os-jobs.ts";

const bot = (name: string, more: Partial<BotRow> = {}): BotRow => ({
  id: `b-${name}`, name, nodeId: "mac", repoId: "r", folder: "/w", executor: "claude", role: "", fresh: true, jobs: [], ...more,
});
const job = (label: string, more: Partial<OsJob> = {}): OsJob => ({
  id: `launchd:/Users/me/Library/LaunchAgents/${label}.plist`, source: "launchd", label, command: "", enabled: true, ...more,
});

test("an OS job goes under the bot that links it; the rest stay loose", () => {
  const collect = job("com.rafeed.collect");
  const other = job("com.example.backup");
  const rafeed = bot("라피드 마케팅", { linked: [collect.id] });
  const groups = groupRows([rafeed, bot("정리")], [collect, other]);
  assert.deepEqual(groups.map((group) => [group.bot.name, group.jobs.map((each) => each.label)]), [["라피드 마케팅", ["com.rafeed.collect"]], ["정리", []]]);
  assert.deepEqual(groups.loose.map((each) => each.label), ["com.example.backup"]);
});

test("today's timeline: bot jobs on today's weekday and enabled calendar jobs, in time order; paused and off ones are left out", () => {
  // 2026-11-24 is a Tuesday (2).
  const now = new Date(2026, 10, 24, 12, 0);
  const points = todayPoints([
    bot("리포트", { jobs: [{ id: "a", when: { minute: 0, hour: 22 }, cron: "", instructions: "" }, { id: "b", when: { minute: 0, hour: 7, days: [1] }, cron: "", instructions: "" }] }),
    bot("멈춤", { paused: true, jobs: [{ id: "c", when: { minute: 0, hour: 9 }, cron: "", instructions: "" }] }),
  ], [
    job("collect", { schedule: { kind: "calendar", entries: [{ hour: 6, minute: 30 }, { hour: 15, minute: 30, weekday: 2 }, { hour: 8, minute: 0, weekday: 3 }] } }),
    job("off", { enabled: false, schedule: { kind: "calendar", entries: [{ hour: 1, minute: 0 }] } }),
    job("tick", { schedule: { kind: "interval", seconds: 300 } }),
  ], now);
  assert.deepEqual(points.map((point) => [point.at, point.label]), [[390, "collect"], [930, "collect"], [1320, "리포트"]]);
});

test("a job's buttons are only what its kind can do", () => {
  assert.deepEqual(jobActions(job("a", { logPath: "/tmp/a.log" })), ["log", "run", "pause", "edit"]);
  // No log path: no log; resident: no time to change; off: only back on.
  assert.deepEqual(jobActions(job("b", { resident: true })), ["run", "pause"]);
  assert.deepEqual(jobActions(job("c", { enabled: false, logPath: "/tmp/c.log" })), ["log", "resume", "edit"]);
  const cron = (spec: string): OsJob => ({ id: `cron:${spec} x`, source: "cron", label: "x", command: "x", enabled: true, schedule: { kind: "text", text: spec } });
  assert.deepEqual(jobActions(cron("*/5 * * * *")), ["run", "pause", "edit"]);
  assert.deepEqual(jobActions(cron("@reboot")), ["run", "pause"]);
  assert.deepEqual(jobActions({ ...job("d"), source: "systemd" }), ["log", "run", "pause"]);
  assert.deepEqual(jobActions({ ...job("e"), source: "lepons" }), []);
});

test("a bot may link its PC's own jobs that no other bot has; Lepons' are not offered", () => {
  const collect = job("com.rafeed.collect");
  const backup = job("com.example.backup");
  const own = { ...job("app.lepons.schedule.s1"), source: "lepons" as const };
  const other = bot("정리", { linked: [backup.id] });
  const me = bot("라피드 마케팅", { linked: [collect.id] });
  assert.deepEqual(linkable([me, other], [collect, backup, own], me.id)!.map((each) => each.label), ["com.rafeed.collect"]);
  assert.equal(linkable([me], undefined, me.id), undefined);
  // Saved links come back grouped under their bot.
  assert.deepEqual(groupRows([me, other], [collect, backup])[1]!.jobs.map((each) => each.label), ["com.example.backup"]);
});

test("one PC's list: OS jobs under their bots, then the loose ones, then Lepons' own schedules", () => {
  const collect = job("collect");
  const own: ScheduleRow = { id: "s1", nodeId: "mac", machine: "mac", state: "ok" };
  const rows = listRows([bot("마케팅", { linked: [collect.id] })], [job("backup"), collect], [own]);
  assert.deepEqual(rows.map((row) => ("job" in row ? `${row.job.label}${row.bot ? `@${row.bot}` : ""}` : `lepons:${row.schedule.id}`)), ["collect@마케팅", "backup", "lepons:s1"]);
});

test("pages of 15, the page clamped when the list shrinks", () => {
  const rows = Array.from({ length: 31 }, (_, each) => each);
  assert.deepEqual(pageOf(rows, 0).rows, rows.slice(0, 15));
  assert.deepEqual(pageOf(rows, 2), { rows: [30], page: 2, pages: 3 });
  assert.deepEqual(pageOf(rows.slice(0, 15), 2), { rows: rows.slice(0, 15), page: 0, pages: 1 });
  assert.deepEqual(pageOf([], 1), { rows: [], page: 0, pages: 1 });
  assert.equal(pageOf(rows, -1).page, 0);
});

test("a row's filter chip: an OS job by where it comes from, Lepons' own as the person's", () => {
  const folders = [{ label: "w", path: "/Users/me/w" }];
  assert.equal(rowKind({ job: job("com.apple.x") }, folders), "os");
  assert.equal(rowKind({ job: job("x", { command: "/Users/me/w/run.sh" }) }, folders), "project");
  assert.equal(rowKind({ job: job("x", { command: "/Users/me/bin/run.sh" }) }, folders), "mine");
  assert.equal(rowKind({ schedule: { id: "s", nodeId: "mac", machine: "mac", state: "ok" } }, folders), "mine");
});

test("two reads show the same only with the same jobs, order and fields", () => {
  const a = job("a", { schedule: { kind: "calendar", entries: [{ hour: 9, minute: 0 }] } });
  const b = job("b");
  assert.equal(sameJobs([a, b], [{ ...a }, { ...b }]), true);
  assert.equal(sameJobs([a, b], [b, a]), false);
  assert.equal(sameJobs([a, b], [a]), false);
  assert.equal(sameJobs([a], [{ ...a, enabled: false }]), false);
  assert.equal(sameJobs([a], [{ ...a, schedule: { kind: "calendar", entries: [{ hour: 10, minute: 0 }] } }]), false);
  assert.equal(sameJobs([], []), true);
});

test("the cache fills only the listed PCs not read yet, marked as cached", () => {
  const cache = { mac: { at: "2026-11-25T01:00:00.000Z", jobs: [job("a")] }, gone: { at: "x", jobs: [] }, pc: { at: "y", jobs: [job("b")] } };
  const pcs = [{ nodeId: "mac", label: "맥" }, { nodeId: "pc", label: "PC" }, { nodeId: "new", label: "새 PC" }];
  assert.deepEqual(fromCache(cache, pcs, new Set(["pc"])), [{ nodeId: "mac", pc: "맥", jobs: [job("a")], readAt: "2026-11-25T01:00:00.000Z", cached: true }]);
  assert.deepEqual(fromCache({ mac: { at: "z", jobs: "bad" as never } }, pcs, new Set()), []);
});

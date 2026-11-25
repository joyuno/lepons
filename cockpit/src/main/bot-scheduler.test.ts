import { test } from "node:test";
import assert from "node:assert/strict";

import { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Bot } from "../agent/bots.ts";
import { scratchDir } from "../scratch-dir.ts";
import type { Session, SessionState } from "../session/state.ts";
import { sessionKey, type NodeConfig } from "../shared/ipc.ts";
import { BotStore } from "./stores.ts";
import { BotScheduler, missedRunOf, nextAction, nextRunOf, type BotSessionView } from "./bot-scheduler.ts";

const MIN = 60_000;
const bot: Bot = {
  id: "b1", name: "리뷰어", nodeId: "n1", repoId: "r1", folder: "/work/app", executor: "claude", role: "PR을 살핀다", fresh: false,
  jobs: [{ id: "j1", when: { minute: 0, hour: 9 }, cron: "0 9 * * *", instructions: "어제 PR을 본다" }],
};
const job = bot.jobs[0]!;
const now = 1_000_000_000_000;
const idle: BotSessionView = { open: true, reachable: true, mood: "idle", asks: 0, agentUp: true };
const act = (view: Partial<BotSessionView>, waitingSince = now, b = bot) => nextAction(b, job, { ...idle, ...view }, waitingSince, now, "머리말");

test("an unreachable PC skips the run", () => {
  assert.deepEqual(act({ reachable: false, open: false }), { kind: "skip", reason: "unreachable" });
});

test("a session that is not open is opened first", () => {
  assert.deepEqual(act({ open: false }), { kind: "open" });
});

test("a pending question makes it wait", () => {
  assert.deepEqual(act({ asks: 1 }), { kind: "wait" });
});

test("someone typing 5 minutes ago makes it wait", () => {
  assert.deepEqual(act({ lastInputAt: now - 5 * MIN }), { kind: "wait" });
});

test("a session still working after 30 minutes skips as busy", () => {
  assert.deepEqual(act({ mood: "working" }, now - 31 * MIN), { kind: "skip", reason: "busy" });
  assert.deepEqual(act({ mood: "working" }, now - 29 * MIN), { kind: "wait" });
});

test("an idle session gets the preamble and the job, clearing first when fresh", () => {
  const action = act({}, now, { ...bot, fresh: true });
  assert.equal(action.kind, "send");
  if (action.kind !== "send") return;
  assert.equal(action.clear, true);
  assert.ok(action.text.startsWith("머리말"));
  assert.ok(action.text.endsWith("어제 PR을 본다"));
  const keep = act({});
  assert.ok(keep.kind === "send" && !keep.clear);
});

test("an AI not yet seen up since its launch is waited for, never typed at, and skipped as busy after 30 minutes", () => {
  assert.deepEqual(act({ agentUp: false }), { kind: "wait" });
  assert.deepEqual(act({ agentUp: false }, now - 31 * MIN), { kind: "skip", reason: "busy" });
  assert.deepEqual(act({ agentUp: false, agentGone: true }), { kind: "restart" }, "known gone is reopened at once");
});

test("the next run is the next 09:00, and none when paused", () => {
  const next = nextRunOf(bot, new Date(2026, 10, 24, 10, 0));
  assert.equal(next && new Date(next).getHours(), 9);
  assert.equal(next && new Date(next).getDate(), 25);
  assert.equal(nextRunOf({ ...bot, paused: true }, new Date()), undefined);
});

test("the store keeps the newest 50 runs, updates one, and reads the old plain list", () => {
  const path = join(scratchDir("lepons-botruns-"), "bots.json");
  writeFileSync(path, JSON.stringify([bot]));
  const store = new BotStore(path);
  assert.equal(store.get("b1")?.name, "리뷰어");
  for (let i = 0; i < 55; i++) store.addRun("b1", { jobId: "j1", startedAt: `t${i}`, status: "sent" });
  store.updateRun("b1", "t54", { status: "done", endedAt: "e" });
  const again = new BotStore(path).runs("b1");
  assert.equal(again.length, 50);
  assert.equal(again[0]!.startedAt, "t5");
  assert.equal(again.at(-1)!.status, "done");
});

// --- the scheduler itself, with every dependency faked ---

const key = sessionKey("n1", "r1", false, "리뷰어");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function rig(options: { bots?: Bot[]; ready?: boolean; openFails?: string[]; answer?: (bot: Bot, before: unknown, startedAt: number) => Promise<string | undefined>; snapshotMs?: number; repos?: string[]; plainSsh?: boolean; before?: (store: BotStore) => void; writeFails?: (data: string) => boolean; at?: number } = {}) {
  const store = new BotStore(join(scratchDir("lepons-botsched-"), "bots.json"));
  for (const each of options.bots ?? [bot]) store.set(each);
  options.before?.(store);
  const agentGone = new Set<string>();
  const agentUp = new Set<string>([key]);
  const sessions = new Map<string, Session>();
  const writes: string[] = [];
  const snapshots: Array<(event: unknown, list: unknown) => void> = [];
  const lastInputAt = new Map<string, number>();
  const told: string[] = [];
  const opened: string[] = [];
  const resumes: boolean[] = [];
  const order: string[] = [];
  const restarted: string[] = [];
  const session = Object.assign(new EventEmitter(), { state: { kind: "ready" }, write: (data: string) => {
    if (options.writeFails?.(data)) throw new Error("gone");
    writes.push(data);
    order.push(`write:${data}`);
  } }) as unknown as Session;
  if (options.ready ?? true) sessions.set(key, session);
  // Noon by default: far from the 09:00 job, so a test that jumps hours never crosses it by the time of day it runs.
  let clock = options.at ?? new Date().setHours(12, 0, 0, 0);
  const scheduler = new BotScheduler({
    bots: store, nodes: () => [{ id: "n1", ...(options.plainSsh ? { kind: "ssh", useTmux: false } : {}), repos: (options.repos ?? ["r1"]).map((id) => ({ id })) } as unknown as NodeConfig], sessions, lastInputAt, agentGone, agentUp: (each) => agentUp.has(each),
    ipcMain: { on: (_channel: string, listener: never) => void snapshots.push(listener) } as never,
    open: async (_node, each, resume) => {
      opened.push(each.id);
      resumes.push(resume);
      if (options.openFails?.includes(each.id)) throw new Error("boom");
      sessions.set(sessionKey("n1", "r1", false, each.name), session);
      return { kind: "ready" } as SessionState;
    },
    restart: async (_node, each) => { restarted.push(each.id); return { kind: "ready" } as SessionState; },
    notify: (each, body) => void told.push(`${each.id}:${body}`),
    snapshot: async () => { order.push("snapshot"); await sleep(options.snapshotMs ?? 0); return [{ id: "f", mark: "1" }]; },
    answer: options.answer,
    clock: () => clock,
    timing: { settleMs: 20, enterMs: 5 },
  });
  scheduler.start();
  const snap = (mood: string, asks?: string, forKey = key) => snapshots.forEach((listener) => listener({}, [{ key: forKey, mood, ...(asks ? { asks } : {}) }]));
  return { store, sessions, session, writes, scheduler, snap, lastInputAt, agentGone, agentUp, told, opened, resumes, order, restarted, advance: (ms: number) => (clock += ms), now: () => clock };
}

test("an idle session with no output still gets the text, then Enter", async () => {
  const r = rig();
  r.snap("idle");
  await r.scheduler.runNow("b1");
  await sleep(150);
  assert.equal(r.writes.length, 2);
  assert.ok(r.writes[0]!.includes("어제 PR을 본다"));
  assert.equal(r.writes[1], "\r");
  r.scheduler.stop();
});

test("a fresh bot types the clear command, then the text, and nothing is listening afterwards", async () => {
  const r = rig({ bots: [{ ...bot, fresh: true }] });
  r.snap("idle");
  await r.scheduler.runNow("b1");
  await sleep(200);
  assert.equal(r.writes[0], "/clear");
  assert.equal(r.writes[1], "\r");
  assert.ok(r.writes[2]!.includes("어제 PR을 본다"));
  assert.equal(r.writes[3], "\r");
  assert.equal((r.sessions.get(key) as unknown as EventEmitter).listenerCount("data"), 0);
  r.scheduler.stop();
});

test("a person typing during the clear settle stops the text", async () => {
  const r = rig({ bots: [{ ...bot, fresh: true }] });
  r.snap("idle");
  await r.scheduler.runNow("b1");
  await sleep(5);
  r.lastInputAt.set(key, r.now());
  await sleep(150);
  assert.ok(!r.writes.some((each) => each.includes("어제 PR을 본다")));
  assert.equal(r.store.runs("b1").at(-1)?.status, "skipped");
  assert.equal(r.store.runs("b1").at(-1)?.reason, "busy");
  r.scheduler.stop();
});

test("an agent with no known clear command is reopened fresh instead of typed at", async () => {
  const r = rig({ bots: [{ ...bot, fresh: true, executor: "agy" }] });
  r.snap("idle");
  await r.scheduler.runNow("b1");
  await sleep(20);
  assert.deepEqual(r.restarted, ["b1"]);
  assert.equal(r.writes.length, 0);
  await r.scheduler.tick();
  await sleep(100);
  assert.ok(r.writes.some((each) => each.includes("어제 PR을 본다")));
  assert.ok(!r.writes.includes("/clear"));
  r.scheduler.stop();
});

test("a bot's session is opened without resume: it never continues a person's conversation", async () => {
  const r = rig({ ready: false });
  await r.scheduler.runNow("b1");
  await sleep(20);
  assert.deepEqual(r.resumes, [false]);
  r.scheduler.stop();
});

test("the record files are listed right before the text is typed", async () => {
  const r = rig();
  r.snap("idle");
  await r.scheduler.runNow("b1");
  await sleep(100);
  assert.equal(r.order[0], "snapshot");
  assert.ok(r.order[1]!.includes("어제 PR을 본다"));
  r.scheduler.stop();
});

test("a fresh bot clears, settles, lists the record files, and only then types the text", async () => {
  const r = rig({ bots: [{ ...bot, fresh: true }] });
  r.snap("idle");
  await r.scheduler.runNow("b1");
  await sleep(200);
  assert.equal(r.order[0], "write:/clear");
  assert.equal(r.order[1], "write:\r");
  assert.equal(r.order[2], "snapshot", "after the clear and its settle, so the clear's own file changes are not counted");
  assert.ok(r.order[3]!.includes("어제 PR을 본다"));
  r.scheduler.stop();
});

test("a run abandoned while the files are being listed types nothing", async () => {
  const r = rig({ snapshotMs: 80 });
  r.snap("idle");
  await r.scheduler.runNow("b1");
  await sleep(30);
  r.lastInputAt.set(key, r.now());
  await sleep(150);
  assert.ok(!r.writes.some((each) => each.includes("어제 PR을 본다")));
  assert.equal(r.store.runs("b1").at(-1)?.reason, "busy");
  r.scheduler.stop();
});

test("opening happens on one tick and the send on a later one", async () => {
  const r = rig({ ready: false });
  await r.scheduler.runNow("b1");
  await sleep(20);
  assert.deepEqual(r.opened, ["b1"]);
  assert.equal(r.writes.length, 0);
  r.snap("idle");
  await r.scheduler.tick();
  await sleep(100);
  assert.ok(r.writes.some((each) => each.includes("어제 PR을 본다")));
  r.scheduler.stop();
});

test("working and then idle ends the run as done and tells the phone", async () => {
  const r = rig();
  r.snap("idle");
  await r.scheduler.runNow("b1");
  await sleep(100);
  assert.equal(r.store.runs("b1").at(-1)?.status, "sent");
  r.snap("working");
  r.snap("idle");
  const run = r.store.runs("b1").at(-1)!;
  assert.equal(run.status, "done");
  assert.ok(run.endedAt);
  assert.deepEqual(r.told, ["b1:done"]);
  r.scheduler.stop();
});

test("busy says a run waits for its session, then runs, then is over", async () => {
  const r = rig({ ready: false });
  assert.equal(r.scheduler.busy("b1"), undefined);
  await r.scheduler.runNow("b1");
  await sleep(20);
  assert.equal(r.scheduler.busy("b1"), "waiting");
  r.snap("idle");
  await r.scheduler.tick();
  await sleep(100);
  assert.equal(r.scheduler.busy("b1"), "running");
  r.snap("working");
  r.snap("idle");
  assert.equal(r.scheduler.busy("b1"), undefined);
  r.scheduler.stop();
});

test("a run that ends keeps the session's last answer with the run", async () => {
  const seen: unknown[] = [];
  const r = rig({ answer: async (each, before, startedAt) => { seen.push(before, startedAt); return `${each.name}의 답.`; } });
  r.snap("idle");
  await r.scheduler.runNow("b1");
  await sleep(100);
  r.snap("working");
  r.snap("idle");
  await sleep(20);
  assert.equal(r.store.runs("b1").at(-1)?.answer, "리뷰어의 답.");
  assert.deepEqual(seen[0], [{ id: "f", mark: "1" }], "the list taken before the text was typed");
  assert.equal(seen[1], Date.parse(r.store.runs("b1").at(-1)!.startedAt));
  r.scheduler.stop();
});

test("a second run now is refused while one is active", async () => {
  const r = rig();
  r.snap("working");
  await r.scheduler.runNow("b1");
  await assert.rejects(r.scheduler.runNow("b1"), /busy/);
  r.scheduler.stop();
});

test("an unknown session mood waits instead of typing", async () => {
  const r = rig();
  await r.scheduler.runNow("b1");
  await sleep(100);
  assert.equal(r.writes.length, 0);
  r.scheduler.stop();
});

test("a regenerated job id does not fire at once", async () => {
  const r = rig();
  r.snap("idle");
  const minute = new Date(r.now()).getMinutes();
  r.store.set({ ...bot, jobs: [{ ...job, id: "new-id", when: { minute } }] });
  await r.scheduler.tick();
  assert.equal(r.store.runs("b1").length, 0);
  assert.equal(r.writes.length, 0);
  r.scheduler.stop();
});

test("a job due while the bot is on a run is recorded as skipped for busy", async () => {
  const r = rig();
  r.snap("working");
  const minute = (new Date(r.now()).getMinutes() + 1) % 60;
  r.store.set({ ...bot, jobs: [{ ...job, when: { minute } }] });
  await r.scheduler.tick();
  await r.scheduler.runNow("b1");
  r.advance(60_000);
  await r.scheduler.tick();
  const last = r.store.runs("b1").at(-1)!;
  assert.equal(last.status, "skipped");
  assert.equal(last.reason, "busy");
  assert.ok(r.told.includes("b1:skipped"));
  r.scheduler.stop();
});

test("an open that throws ends that run as skipped and the other bots still tick", async () => {
  const other: Bot = { ...bot, id: "b2", name: "정리하는봇", jobs: [{ ...job, id: "j2" }] };
  const r = rig({ bots: [bot, other], ready: false, openFails: ["b1"] });
  await r.scheduler.runNow("b1");
  await r.scheduler.runNow("b2");
  await sleep(50);
  assert.equal(r.store.runs("b1").at(-1)?.status, "skipped");
  assert.deepEqual([...r.opened].sort(), ["b1", "b2"]);
  r.scheduler.stop();
});

test("a run that waits 30 minutes for a free session is skipped as busy", async () => {
  const r = rig();
  r.snap("working");
  await r.scheduler.runNow("b1");
  r.advance(31 * MIN);
  await r.scheduler.tick();
  assert.equal(r.store.runs("b1").at(-1)?.reason, "busy");
  r.scheduler.stop();
});

test("a sent run whose end is never seen is closed as skipped for timeout", async () => {
  const r = rig();
  r.snap("idle");
  await r.scheduler.runNow("b1");
  await sleep(100);
  r.advance(4 * 60 * MIN);
  await r.scheduler.tick();
  const last = r.store.runs("b1").at(-1)!;
  assert.equal(last.status, "skipped");
  assert.equal(last.reason, "timeout");
  r.scheduler.stop();
});

test("an AI that has quit is reopened fresh, and nothing is typed into the shell it left", async () => {
  const r = rig();
  r.agentGone.add(key);
  r.snap("done");
  await r.scheduler.runNow("b1");
  await sleep(50);
  assert.deepEqual(r.restarted, ["b1"]);
  assert.deepEqual(r.writes, []);
  // Gone again after the reopen: skipped, still nothing typed.
  await r.scheduler.tick();
  await sleep(50);
  assert.deepEqual(r.writes, []);
  assert.equal(r.store.runs("b1").at(-1)?.reason, "unreachable");
  r.scheduler.stop();
});

test("an AI that quits during the clear settle gets no text", async () => {
  const r = rig({ bots: [{ ...bot, fresh: true }] });
  r.snap("idle");
  await r.scheduler.runNow("b1");
  await sleep(5);
  r.agentGone.add(key);
  await sleep(150);
  assert.ok(!r.writes.some((each) => each.includes("어제 PR을 본다")));
  assert.equal(r.store.runs("b1").at(-1)?.reason, "unreachable");
  r.scheduler.stop();
});

test("a reopened AI is not typed at until a look has seen it up", async () => {
  const r = rig({ ready: false });
  r.agentUp.clear();
  await r.scheduler.runNow("b1");
  await sleep(20);
  assert.deepEqual(r.opened, ["b1"]);
  r.snap("idle");
  await r.scheduler.tick();
  await sleep(50);
  assert.equal(r.writes.length, 0, "the grace window reads as not gone, which is not up");
  r.agentUp.add(key);
  await r.scheduler.tick();
  await sleep(100);
  assert.ok(r.writes.some((each) => each.includes("어제 PR을 본다")));
  r.scheduler.stop();
});

test("a bot whose folder was removed is skipped, never opened elsewhere", async () => {
  const r = rig({ ready: false, repos: [] });
  await r.scheduler.runNow("b1");
  await sleep(20);
  assert.deepEqual(r.opened, []);
  assert.deepEqual(r.restarted, []);
  assert.equal(r.store.runs("b1").at(-1)?.reason, "no_folder");
  r.scheduler.stop();
});

test("a bot on an SSH PC without tmux is skipped as unreachable, never opened", async () => {
  const r = rig({ ready: false, plainSsh: true });
  await r.scheduler.runNow("b1");
  await sleep(20);
  assert.deepEqual(r.opened, []);
  assert.equal(r.store.runs("b1").at(-1)?.reason, "unreachable");
  r.scheduler.stop();
});

test("pausing cancels a waiting run, without a push", async () => {
  const r = rig();
  r.snap("working");
  await r.scheduler.runNow("b1");
  r.store.set({ ...bot, paused: true });
  await r.scheduler.tick();
  const last = r.store.runs("b1").at(-1)!;
  assert.equal(last.status, "skipped");
  assert.equal(last.reason, "paused");
  assert.deepEqual(r.told, []);
  r.scheduler.stop();
});

test("pausing during the clear settle stops the text", async () => {
  const r = rig({ bots: [{ ...bot, fresh: true }] });
  r.snap("idle");
  await r.scheduler.runNow("b1");
  await sleep(5);
  r.store.set({ ...bot, fresh: true, paused: true });
  await sleep(150);
  assert.ok(!r.writes.some((each) => each.includes("어제 PR을 본다")));
  assert.equal(r.store.runs("b1").at(-1)?.reason, "paused");
  r.scheduler.stop();
});

test("after the AI was changed the next run reopens fresh, then types into the new one", async () => {
  const r = rig({ bots: [{ ...bot, executor: "codex", retired: "claude" }] });
  r.snap("idle");
  await r.scheduler.runNow("b1");
  await sleep(20);
  assert.deepEqual(r.restarted, ["b1"]);
  assert.equal(r.writes.length, 0);
  assert.equal(r.store.get("b1")?.retired, undefined, "done once");
  await r.scheduler.tick();
  await sleep(100);
  assert.ok(r.writes.some((each) => each.includes("어제 PR을 본다")));
  assert.deepEqual(r.restarted, ["b1"]);
  r.scheduler.stop();
});

test("a run left as sent when Lepons closed is ended as interrupted at start", () => {
  const r = rig({ before: (store) => store.addRun("b1", { jobId: "j1", startedAt: "t0", status: "sent" }) });
  const last = r.store.runs("b1").at(-1)!;
  assert.equal(last.status, "skipped");
  assert.equal(last.reason, "interrupted");
  assert.ok(last.endedAt);
  r.scheduler.stop();
});

test("a session gone during the clear settle ends the run as unreachable", async () => {
  const r = rig({ bots: [{ ...bot, fresh: true }] });
  r.snap("idle");
  await r.scheduler.runNow("b1");
  await sleep(5);
  (r.session as unknown as { state: SessionState }).state = { kind: "closed", reason: "dropped" } as unknown as SessionState;
  await sleep(150);
  assert.ok(!r.writes.some((each) => each.includes("어제 PR을 본다")));
  assert.equal(r.store.runs("b1").at(-1)?.reason, "unreachable");
  r.scheduler.stop();
});

test("an Enter that cannot be written ends the run as unreachable", async () => {
  const r = rig({ writeFails: (data) => data === "\r" });
  r.snap("idle");
  await r.scheduler.runNow("b1");
  await sleep(150);
  const last = r.store.runs("b1").at(-1)!;
  assert.equal(last.status, "skipped");
  assert.equal(last.reason, "unreachable");
  r.scheduler.stop();
});

// --- missed runs: a due time that passed while Lepons was off or the PC asleep ---

const at = (day: number, hour: number, minute = 0, second = 0) => new Date(2026, 10, day, hour, minute, second).getTime();

test("a 09:00 passed between an 08:50 heartbeat and a 10:00 start is one missed run at 09:00", () => {
  assert.deepEqual(missedRunOf(bot, at(24, 8, 50), at(24, 10)), { jobId: "j1", at: at(24, 9) });
});

test("three missed mornings are one, the latest", () => {
  assert.deepEqual(missedRunOf(bot, at(21, 8, 50), at(24, 10)), { jobId: "j1", at: at(24, 9) });
});

test("a paused bot, or a heartbeat after the due minute, has missed nothing", () => {
  assert.equal(missedRunOf({ ...bot, paused: true }, at(24, 8, 50), at(24, 10)), undefined);
  assert.equal(missedRunOf(bot, at(24, 9, 0, 30), at(24, 10)), undefined);
  assert.equal(missedRunOf(bot, at(24, 8, 50), at(24, 9, 0, 40)), undefined, "the current minute belongs to the tick");
});

test("a start after a day off records one missed run, tells the phone once, runs nothing, and settling clears it", async () => {
  const r = rig({ at: at(24, 12), bots: [bot, { ...bot, id: "b2", name: "쉬는봇", paused: true }], before: (store) => store.beat(at(23, 11)) });
  const missed = r.store.runs("b1");
  assert.equal(missed.length, 1);
  assert.equal(missed[0]!.status, "missed");
  assert.equal(missed[0]!.startedAt, new Date(at(24, 9)).toISOString());
  assert.deepEqual(r.told, ["b1:missed"]);
  assert.equal(r.store.runs("b2").length, 0);
  assert.equal(r.writes.length, 0);
  assert.equal(r.store.heartbeat(), r.now(), "the heartbeat moves on at start");
  await r.scheduler.settleMissed("b1", false);
  assert.equal(r.store.runs("b1")[0]!.handled, true);
  // Settled already (a second click): nothing runs, so a run can still be queued.
  await r.scheduler.settleMissed("b1", true);
  await r.scheduler.runNow("b1");
  r.scheduler.stop();
});

test("a job due within 30 s of a start, or in that very minute, runs, and one the last Lepons fired this minute does not run again", async () => {
  const r = rig({ at: at(24, 8, 59, 45), before: (store) => store.beat(at(24, 8, 59, 30)) });
  r.advance(30_000);
  await r.scheduler.tick();
  await assert.rejects(r.scheduler.runNow("b1"), /busy/, "the 09:00 job was taken up");
  assert.equal(r.store.runs("b1").length, 0, "and not counted as missed");
  r.scheduler.stop();

  // Started within the due minute itself: it runs at once.
  const late = rig({ at: at(24, 9, 0, 20), before: (store) => store.beat(at(24, 8, 59, 30)) });
  await assert.rejects(late.scheduler.runNow("b1"), /busy/);
  late.scheduler.stop();

  const again = rig({ at: at(24, 9, 0, 40), before: (store) => store.beat(at(24, 9, 0, 10)) });
  await again.scheduler.runNow("b1");
  again.scheduler.stop();
});

test("a tick long after the last one (asleep, or a late timer) records one missed run, then nothing more", async () => {
  const r = rig({ at: at(24, 12) });
  r.advance(22 * 60 * MIN);
  await r.scheduler.tick();
  assert.equal(r.store.runs("b1").length, 1);
  assert.equal(r.store.runs("b1")[0]!.startedAt, new Date(at(25, 9)).toISOString());
  r.advance(30_000);
  await r.scheduler.tick();
  assert.equal(r.store.runs("b1").length, 1);
  assert.deepEqual(r.told, ["b1:missed"]);
  r.scheduler.stop();
});

test("a store that cannot be written neither stops the start nor makes a tick reject, and the heartbeat is tried again", async () => {
  const held = () => { throw Object.assign(new Error("held"), { code: "EPERM" }); };
  let beats = 0;
  const r = rig({
    before: (store) => {
      store.addRun("b1", { jobId: "j1", startedAt: "t0", status: "sent" });
      store.updateRun = held;
      store.beat = () => { beats++; held(); };
    },
  });
  assert.equal(beats, 1, "the start's tick tried");
  r.advance(1000);
  await r.scheduler.tick();
  assert.equal(beats, 2, "and the next tick tries again, not a minute later");
  r.scheduler.stop();
});

test("jobs due in the same minute run one after another, in the bot's list order", async () => {
  const r = rig();
  r.snap("idle");
  const minute = (new Date(r.now()).getMinutes() + 1) % 60;
  // Listed second-made first: the list order is the priority, not the ids.
  r.store.set({ ...bot, jobs: [{ ...job, id: "j2", when: { minute }, instructions: "먼저 할 일" }, { ...job, id: "j1", when: { minute }, instructions: "다음 할 일" }] });
  await r.scheduler.tick();
  r.advance(60_000);
  await r.scheduler.tick();
  await sleep(100);
  const typed = () => r.writes.join("");
  assert.ok(typed().includes("먼저 할 일") && !typed().includes("다음 할 일"), "only the first runs at first");
  r.snap("working");
  r.snap("idle");
  await r.scheduler.tick();
  await sleep(100);
  assert.ok(typed().indexOf("다음 할 일") > typed().indexOf("먼저 할 일"), "the second runs once the first has ended");
  assert.deepEqual(r.store.runs("b1").map((run) => run.jobId), ["j2", "j1"]);
  assert.ok(!r.store.runs("b1").some((run) => run.status === "skipped"));
  r.scheduler.stop();
});

test("an edit that keeps the jobs keeps the queue; a queued job taken out is recorded as skipped for edited", async () => {
  const r = rig();
  r.snap("idle");
  const minute = (new Date(r.now()).getMinutes() + 1) % 60;
  const three = [
    { ...job, id: "j1", when: { minute }, instructions: "첫째" },
    { ...job, id: "j2", when: { minute }, instructions: "둘째" },
    { ...job, id: "j3", when: { minute }, instructions: "셋째" },
  ];
  r.store.set({ ...bot, jobs: three });
  await r.scheduler.tick();
  r.advance(60_000);
  await r.scheduler.tick();
  await sleep(100);
  assert.deepEqual(r.store.queue(), { b1: ["j2", "j3"] }, "what waits is on disk");
  // The role changes and j3 is taken out while j1 runs.
  r.store.set({ ...bot, role: "새 역할", jobs: three.slice(0, 2) });
  r.snap("working");
  r.snap("idle");
  await r.scheduler.tick();
  await sleep(100);
  assert.ok(r.writes.join("").includes("둘째"), "j2 still ran after the edit");
  r.snap("working");
  r.snap("idle");
  await r.scheduler.tick();
  const runs = r.store.runs("b1").map((run) => [run.jobId, run.status, run.reason]);
  assert.deepEqual(runs, [["j1", "done", undefined], ["j2", "done", undefined], ["j3", "skipped", "edited"]]);
  assert.deepEqual(r.store.queue(), {});
  r.scheduler.stop();
});

test("jobs that were queued when Lepons closed are recorded as interrupted at start, and the queue is cleared", () => {
  const r = rig({ before: (store) => store.setQueue("b1", ["j1", "j9"]) });
  const runs = r.store.runs("b1").map((run) => [run.jobId, run.status, run.reason]);
  assert.deepEqual(runs, [["j1", "skipped", "interrupted"], ["j9", "skipped", "interrupted"]]);
  assert.deepEqual(r.store.queue(), {});
  r.scheduler.stop();
});

test("a queued job runs as the bot has it when its turn comes: an edit to its text is what is typed", async () => {
  const r = rig();
  r.snap("idle");
  const minute = (new Date(r.now()).getMinutes() + 1) % 60;
  const two = [{ ...job, id: "j1", when: { minute }, instructions: "첫째" }, { ...job, id: "j2", when: { minute }, instructions: "옛 둘째" }];
  r.store.set({ ...bot, jobs: two });
  await r.scheduler.tick();
  r.advance(60_000);
  await r.scheduler.tick();
  await sleep(100);
  r.store.set({ ...bot, jobs: [two[0]!, { ...two[1]!, instructions: "새 둘째" }] });
  r.snap("working");
  r.snap("idle");
  await r.scheduler.tick();
  await sleep(100);
  assert.ok(r.writes.join("").includes("새 둘째"));
  assert.ok(!r.writes.join("").includes("옛 둘째"));
  r.scheduler.stop();
});

test("a queue that cannot be written leaves the run under way as it was", async () => {
  const r = rig();
  r.snap("idle");
  const minute = (new Date(r.now()).getMinutes() + 1) % 60;
  r.store.set({ ...bot, jobs: [{ ...job, id: "j1", when: { minute }, instructions: "첫째" }, { ...job, id: "j2", when: { minute }, instructions: "둘째" }] });
  r.store.setQueue = () => { throw new Error("disk full"); };
  await r.scheduler.tick();
  r.advance(60_000);
  await r.scheduler.tick();
  await sleep(100);
  const runs = r.store.runs("b1");
  assert.deepEqual(runs.map((run) => [run.jobId, run.status]), [["j1", "sent"]]);
  assert.ok(!runs.some((run) => run.reason === "error"));
  r.scheduler.stop();
});

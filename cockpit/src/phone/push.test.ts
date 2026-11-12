import { test } from "node:test";
import assert from "node:assert/strict";

import { onMenu, newActivity, onOutput, onTick, onTurnEnd } from "../renderer/pet.ts";
import type { SessionState } from "../session/state.ts";
import { sessionStatus, turnMark, type TurnEnd } from "../shared/status.ts";
import { allDone, COALESCE_MS, donePush, limitOnScreen, LOOK_AGAIN_MS, menuAsks, newlyStopped, newlyWaiting, pushGate, pushTitle, pushTokenGone, snapshotPushes, stopPush, validPushToken, waitingPush, type Waiting } from "./push.ts";

test("a push goes out on the turn to waiting, once, not while it stays waiting", () => {
  const a = (mood: string) => ({ key: "a", mood });
  assert.deepEqual(newlyWaiting([], [a("waiting")]), [a("waiting")]);
  assert.deepEqual(newlyWaiting([a("working")], [a("waiting")]), [a("waiting")]);
  assert.deepEqual(newlyWaiting([a("waiting")], [a("waiting")]), []);
  assert.deepEqual(newlyWaiting([a("waiting")], [a("idle")]), []);
});

test("only Expo push tokens are taken", () => {
  assert.equal(validPushToken("ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]"), true);
  assert.equal(validPushToken("ExpoPushToken[abc-123_X]"), true);
  for (const bad of [undefined, 1, "", "ExponentPushToken[]", "ExponentPushToken[a b]", "ExponentPushToken[a]]", "https://evil/[x]", "xExponentPushToken[a]", `ExponentPushToken[${"a".repeat(200)}]`]) {
    assert.equal(validPushToken(bad), false, String(bad));
  }
});

test("the waiting push carries the given text and the opaque id, nothing else", () => {
  assert.deepEqual(waitingPush("ExpoPushToken[a]", "PC1의 세션이 입력을 기다려요", "0123abcd"), {
    to: "ExpoPushToken[a]", title: "Lepons", body: "PC1의 세션이 입력을 기다려요", data: { session: "0123abcd" }, channelId: "waiting", sound: "default",
    priority: "high", interruptionLevel: "time-sensitive", ttl: 3600, collapseId: "lepons", tag: "lepons",
  });
  // Several: no session to name, the tap opens the list.
  assert.deepEqual(waitingPush("ExpoPushToken[a]", "세션 3개가 기다려요").data, { open: "sessions" });
});

test("DeviceNotRegistered is found in one ticket or an array", () => {
  const gone = { status: "error", details: { error: "DeviceNotRegistered" } };
  assert.equal(pushTokenGone({ data: gone }), true);
  assert.equal(pushTokenGone({ data: [{ status: "ok", id: "x" }, gone] }), true);
  assert.equal(pushTokenGone({ data: { status: "ok", id: "x" } }), false);
  assert.equal(pushTokenGone(undefined), false);
  assert.equal(pushTokenGone({ errors: [{ code: "X" }] }), false);
});

test("the all-done push is quiet and replaces the last Lepons notification", () => {
  assert.deepEqual(donePush("ExpoPushToken[a]", "모든 세션이 끝났어요"), {
    to: "ExpoPushToken[a]", title: "Lepons", body: "모든 세션이 끝났어요", data: { open: "sessions" },
    channelId: "done", interruptionLevel: "passive", ttl: 3600, collapseId: "lepons", tag: "lepons",
  });
  assert.equal("sound" in donePush("ExpoPushToken[a]", "x"), false);
});

test("all done: everything that was working is still there and finished", () => {
  // "finished" is a done session whose record said so.
  const m = (...moods: string[]) => moods.map((mood, i) => (mood === "finished" ? { key: `k${i}`, mood: "done", turn: "finished" as const } : { key: `k${i}`, mood }));
  assert.equal(allDone(m("working", "idle"), m("finished", "idle")), true);
  assert.equal(allDone(m("working", "working"), m("waiting", "finished")), true);
  assert.equal(allDone(m("working", "idle"), m("done", "idle")), false, "quiet without a finished turn: stopped, or no work");
  assert.equal(allDone(m("working", "working"), m("working", "finished")), false, "one still working");
  assert.equal(allDone(m("finished"), m("finished")), false, "nothing was working");
  assert.equal(allDone([], []), false);
  assert.equal(allDone(m("working", "idle"), m("failed", "idle")), false, "failed is not finished");
  assert.equal(allDone(m("working", "idle"), m("idle", "idle").slice(1)), false, "a session that went away is not finished");
  assert.equal(allDone(m("working"), []), false, "an empty list is not finished");
});

/** A gate on a pretend clock: timers run when the clock passes them. */
function gate(look = () => false) {
  let clock = 0;
  const timers: Array<{ at: number; run: () => void }> = [];
  const sent: Waiting[][] = [];
  let waiting: Waiting[] = [];
  const turn = pushGate({
    now: () => clock,
    later: (run, ms) => void timers.push({ at: clock + ms, run }),
    looking: look,
    waiting: () => waiting,
    send: (list) => void sent.push(list),
  });
  const advance = (ms: number) => {
    clock += ms;
    for (const timer of timers.filter((one) => one.at <= clock)) {
      timers.splice(timers.indexOf(timer), 1);
      timer.run();
    }
  };
  return { turn, advance, sent, timers, set: (list: Waiting[]) => void (waiting = list) };
}
const w = (session: string): Waiting => ({ session, title: "lepons · Claude Code", asks: "approve" });

test("coalescing: the first goes at once, the rest wait out the 60 s and go as one", () => {
  const g = gate();
  g.set([w("a")]);
  g.turn();
  assert.deepEqual(g.sent, [[w("a")]], "nothing sent lately: at once");
  g.advance(10_000);
  g.set([w("a"), w("b")]);
  g.turn();
  g.advance(5_000);
  g.set([w("a"), w("b"), w("c")]);
  g.turn();
  assert.equal(g.sent.length, 1, "held");
  assert.equal(g.timers.length, 1, "one timer for the window");
  g.advance(COALESCE_MS - 15_000 - 1);
  assert.equal(g.sent.length, 1);
  g.advance(1);
  assert.deepEqual(g.sent[1], [w("a"), w("b"), w("c")], "one push, counting what still waits");
  // After a quiet minute, at once again.
  g.advance(COALESCE_MS);
  g.set([w("d")]);
  g.turn();
  assert.deepEqual(g.sent[2], [w("d")]);
});

test("coalescing: nothing left waiting at the window end sends nothing", () => {
  const g = gate();
  g.set([w("a")]);
  g.turn();
  g.set([w("a"), w("b")]);
  g.turn();
  g.set([]);
  g.advance(COALESCE_MS);
  assert.equal(g.sent.length, 1);
});

test("no push while someone is looking; if they leave with it unanswered, it goes then", () => {
  let looking = true;
  const g = gate(() => looking);
  g.set([w("a")]);
  g.turn();
  assert.deepEqual(g.sent, [], "looking at the turn");
  g.advance(LOOK_AGAIN_MS);
  assert.deepEqual(g.sent, [], "still looking");
  looking = false;
  assert.deepEqual(g.sent, [], "nothing before the next look");
  g.advance(LOOK_AGAIN_MS);
  assert.deepEqual(g.sent, [[w("a")]], "left, and it still waits");
  assert.equal(g.timers.length, 0, "and nothing more runs");

  // Looking when a held push falls due: it waits on, once.
  g.set([w("a"), w("b")]);
  g.turn();
  looking = true;
  g.advance(COALESCE_MS);
  assert.equal(g.sent.length, 1);
  assert.equal(g.timers.length, 1);
});

test("answered while looking: no push, and the look stops", () => {
  let looking = true;
  const g = gate(() => looking);
  g.set([w("a")]);
  g.turn();
  g.set([]);
  looking = false;
  g.advance(LOOK_AGAIN_MS);
  assert.deepEqual(g.sent, []);
  assert.equal(g.timers.length, 0);
});

// --- what the phone hears, from a session's output to the push: the snapshot
// handler's own decision (main/phone-host.ts) on the real status code ---

/** One session: output and the clock go in, the record's answer comes back at once, a snapshot comes out. */
function session(key: string) {
  const activity = newActivity();
  let at = 0;
  let state: SessionState = { kind: "connecting" };
  const snap = () => ({ key, mood: sessionStatus(state, activity) as string, turn: turnMark(state, activity) });
  return {
    snap,
    ready() { state = { kind: "ready" }; },
    work() { for (const end = at + 6000; at < end; at += 500) onOutput(activity, at); },
    /** `menu`: what is on the screen by then. A record that says waiting has one up, unless a test says not. */
    quiet(end: TurnEnd, menu: string | null = end === "waiting" ? "Yes|No" : null) {
      at += 4000;
      // A menu is read off the screen as output pauses, before the quiet is long enough to ask the record.
      if (menu !== null) {
        onMenu(activity, menu, at);
        return;
      }
      assert.equal(onTick(activity, at), true);
      onTurnEnd(activity, end, activity.lastOutput, at);
    },
  };
}

/** The handler, on a pretend clock: what it sends for each snapshot. */
function host(looking = () => false) {
  let clock = 1_000_000;
  let before: ReturnType<ReturnType<typeof session>["snap"]>[] = [];
  const sent: string[] = [];
  const timers: Array<{ at: number; run: () => void }> = [];
  const gate = pushGate({
    now: () => clock,
    later: (run, ms) => void timers.push({ at: clock + ms, run }),
    looking,
    waiting: () => before.filter((one) => one.mood === "waiting").map((one) => ({ session: one.key, title: "t", asks: "choose" as const })),
    send: (list) => void sent.push(`WAITING(${list.length})`),
  });
  return {
    sent,
    advance(ms: number) { clock += ms; for (const timer of timers.splice(0)) { if (timer.at <= clock) timer.run(); else timers.push(timer); } },
    snap(list: typeof before) {
      const pushes = snapshotPushes(before, list);
      before = list;
      if (pushes.waiting) gate();
    },
  };
}

function worked() {
  const one = session("a");
  one.ready();
  one.work();
  return one;
}

test("scenario 1: a session stops and asks, one waiting push", () => {
  const h = host();
  const a = worked();
  h.snap([a.snap()]);
  a.quiet("waiting");
  h.snap([a.snap()]);
  assert.deepEqual(h.sent, ["WAITING(1)"]);
});

test("scenario 2: the same while someone looks, nothing", () => {
  const h = host(() => true);
  const a = worked();
  h.snap([a.snap()]);
  a.quiet("waiting");
  h.snap([a.snap()]);
  assert.deepEqual(h.sent, []);
});

test("scenario 3: a second session asking within 60 s is held and grouped", () => {
  const h = host();
  const a = worked();
  const b = session("b");
  b.ready();
  b.work();
  h.snap([a.snap(), b.snap()]);
  a.quiet("waiting");
  h.snap([a.snap(), b.snap()]);
  h.advance(10_000);
  b.quiet("waiting");
  h.snap([a.snap(), b.snap()]);
  assert.deepEqual(h.sent, ["WAITING(1)"]);
  h.advance(60_000);
  assert.deepEqual(h.sent, ["WAITING(1)", "WAITING(2)"]);
});

test("scenario 4: still waiting does not repeat", () => {
  const h = host();
  const a = worked();
  h.snap([a.snap()]);
  a.quiet("waiting");
  for (let i = 0; i < 3; i++) h.snap([a.snap()]);
  assert.deepEqual(h.sent, ["WAITING(1)"]);
});

test("scenario 5: the only session finished its work: no push at all", () => {
  const h = host();
  const a = worked();
  h.snap([a.snap()]);
  a.quiet("finished");
  h.snap([a.snap()]);
  assert.deepEqual(h.sent, []);
});

test("scenario 6: every session finished at once: no push at all", () => {
  const h = host();
  const a = worked();
  const b = session("b");
  b.ready();
  b.work();
  h.snap([a.snap(), b.snap()]);
  a.quiet("finished");
  b.quiet("finished");
  h.snap([a.snap(), b.snap()]);
  h.snap([a.snap(), b.snap()]);
  assert.deepEqual(h.sent, []);
});

test("scenario 7: connecting ended with no work, silence", () => {
  const h = host();
  const a = session("a");
  h.snap([a.snap()]);
  assert.equal(a.snap().mood, "working", "every surface still shows it as busy");
  a.ready();
  h.snap([a.snap()]);
  assert.equal(a.snap().mood, "done");
  assert.deepEqual(h.sent, []);
});

test("a screen drawn on connecting looks like work, and the record says none: silence", () => {
  const h = host();
  const a = worked();
  h.snap([a.snap()]);
  a.quiet("quiet");
  h.snap([a.snap()]);
  assert.deepEqual(h.sent, []);
});

test("stopped by the operator: silence", () => {
  const h = host();
  const a = worked();
  h.snap([a.snap()]);
  a.quiet("stopped");
  h.snap([a.snap()]);
  assert.deepEqual(h.sent, []);
});

test("one finished and one with a menu: the waiting push", () => {
  const h = host();
  const a = worked();
  const b = session("b");
  b.ready();
  b.work();
  h.snap([a.snap(), b.snap()]);
  a.quiet("finished");
  b.quiet("waiting");
  h.snap([a.snap(), b.snap()]);
  assert.deepEqual(h.sent, ["WAITING(1)"]);
});

test("a session still connecting and another finished: no push", () => {
  const h = host();
  const a = worked();
  const b = session("b");
  h.snap([a.snap(), b.snap()]);
  a.quiet("finished");
  h.snap([a.snap(), b.snap()]);
  assert.deepEqual(h.sent, []);
});

test("no menu, no push: a question in plain words, or no record to ask", () => {
  for (const end of ["waiting", "unknown"] as const) {
    const h = host();
    const a = worked();
    h.snap([a.snap()]);
    a.quiet(end, null);
    h.snap([a.snap()]);
    assert.deepEqual(h.sent, [], end);
  }
});

test("a menu with no record to ask still rings", () => {
  const h = host();
  const a = worked();
  h.snap([a.snap()]);
  a.quiet("unknown", "Yes|No");
  h.snap([a.snap()]);
  assert.deepEqual(h.sent, ["WAITING(1)"]);
});

test("a menu asks for an approval when one of its options says yes, allow, approve or proceed", () => {
  assert.equal(menuAsks([{ label: "Yes" }, { label: "Yes, and don't ask again for this command" }, { label: "No, and tell Claude what to do differently" }]), "approve");
  assert.equal(menuAsks([{ label: "Allow once" }, { label: "Deny" }]), "approve");
  assert.equal(menuAsks([{ label: "예" }, { label: "아니요" }]), "approve");
  assert.equal(menuAsks([{ label: "Postgres" }, { label: "SQLite" }, { label: "Type something." }]), "choose");
  assert.equal(menuAsks([{ label: "Yesterday's log" }, { label: "Today's log" }]), "choose", "a word that only starts with yes");
});

test("the title names the folder, its AI and a named PC; empty parts are left out", () => {
  assert.equal(pushTitle("lepons", "Claude Code", "집 PC"), "lepons · Claude Code · 집 PC");
  assert.equal(pushTitle("lepons", undefined, undefined), "lepons");
  assert.equal(pushTitle("blog", "Codex", ""), "blog · Codex");
});

test("an AI that failed or hit its limit pushes once, in its own lock-screen slot; a plain terminal does not", () => {
  const s = (key: string, mood: string, extra: { limited?: true; terminal?: boolean; turn?: "starting" } = {}) => ({ key, mood, ...extra });
  assert.deepEqual(newlyStopped([s("a", "working")], [s("a", "failed")]).map((one) => one.why), ["failed"]);
  assert.deepEqual(newlyStopped([s("a", "failed")], [s("a", "failed")]), [], "already failed");
  assert.deepEqual(newlyStopped([s("a", "working")], [s("a", "idle", { limited: true })]).map((one) => one.why), ["limit"]);
  assert.deepEqual(newlyStopped([s("a", "idle", { limited: true })], [s("a", "idle", { limited: true })]), [], "the line still on screen");
  assert.deepEqual(newlyStopped([s("t", "working", { terminal: true })], [s("t", "failed", { terminal: true })]), []);
  assert.deepEqual(newlyStopped([], [s("a", "failed")]), [], "a session just seen is not news");
  assert.deepEqual(newlyStopped([s("a", "idle")], [s("a", "failed")]), [], "closed while idle: no work was lost");
  assert.deepEqual(newlyStopped([s("a", "working", { turn: "starting" })], [s("a", "failed")]), [], "a reconnect that failed again");
  const push = stopPush("ExpoPushToken[a]", "lepons · Codex", "오류로 멈췄어요", "0123abcd");
  assert.equal(push.title, "lepons · Codex");
  assert.equal(push.collapseId, "lepons-stop");
  assert.equal(push.tag, "lepons-stop");
  assert.deepEqual(push.data, { session: "0123abcd" });
});

test("the limit is read off the screen's foot, in the agent's own words, not from a usage readout", () => {
  assert.equal(limitOnScreen(["● Working", "", "  ⎿  5-hour limit reached ∙ resets 3pm"]), true);
  assert.equal(limitOnScreen(["■ You've hit your usage limit. Try again at 4:12 PM."]), true);
  assert.equal(limitOnScreen(["Current session  5-hour limit  40% used", "Weekly limit 12%"]), false);
  assert.equal(limitOnScreen(["Claude usage limit reached", ...Array.from({ length: 9 }, (_, i) => `line ${i}`)]), false, "scrolled up past the foot");
});

import { test } from "node:test";
import assert from "node:assert/strict";

import xterm from "@xterm/headless"; // CommonJS: no named exports under Node
const { Terminal } = xterm;

import { reflow } from "./copied.ts";
import { menuFrom } from "./menu.ts";
import { statusFrom } from "./status.ts";
import { lampState } from "./types.ts";
import { accountsOf, commandsOf, filesOf, screenOf, stateOf, workflowChangeOf, workflowOf } from "./validate.ts";
import { createDemo } from "../demo.ts";
// The checks that the phone's copies still match the cockpit, run from both apps.
import "../../../cockpit/src/renderer/workflowmap/copies.test.ts";

test("received data is checked: bad items dropped, bad frames refused", () => {
  const state = stateOf({
    sessions: [
      { id: "ab12", pc: "PC", folder: "f", mood: "waiting", agent: true, preview: "p" },
      { id: "AB<script>", pc: "PC", folder: "f", mood: "waiting", agent: true },
      { id: "cd34", pc: "PC", folder: "f", mood: "sleeping", agent: true },
      { id: "ef56", pc: 3, folder: "f", mood: "done", agent: false },
    ],
    pcs: [{ label: "PC", state: "live" }, { label: "x", state: "on fire" }],
  });
  assert.deepEqual(state, { sessions: [{ id: "ab12", pc: "PC", folder: "f", mood: "waiting", agent: true, preview: "p" }], pcs: [{ label: "PC", state: "live" }] });
  assert.equal(stateOf({ sessions: "nope", pcs: [] }), undefined);
  const gone = (agentGone?: unknown) => stateOf({ sessions: [{ id: "ab12", pc: "PC", folder: "f", mood: "done", agent: true, ...(agentGone === undefined ? {} : { agentGone }) }], pcs: [] })!.sessions[0]!;
  assert.equal(lampState(gone(true)), "shellOnly", "the AI has gone from its terminal");
  assert.equal(lampState(gone()), "done", "a PC that does not send it renders as before");
  assert.equal(lampState(gone("yes")), "done", "nor does anything else count");
  const tree = (extra: Record<string, unknown>) => stateOf({ sessions: [{ id: "ab12", pc: "PC", folder: "t", mood: "done", agent: true, ...extra }], pcs: [] })!.sessions[0]!;
  assert.deepEqual([tree({ worktreeOf: "f", worktree: "t" }).worktreeOf, tree({ worktreeOf: "f", worktree: "t" }).worktree], ["f", "t"]);
  assert.equal("worktree" in tree({ worktreeOf: "", worktree: "t" }), false, "no task without its folder");
  assert.deepEqual(tree({ worktreeOf: "f", worktree: 3 }).worktree, undefined);
  assert.equal("worktreeOf" in tree({ worktreeOf: "x".repeat(501) }), false);
  assert.equal(stateOf(null), undefined);

  assert.deepEqual(screenOf({ data: "x", cols: 100000, rows: -1 }), { data: "x", cols: 500, rows: 5 });
  assert.equal(screenOf({ data: 1, cols: 80, rows: 24 }), undefined);

  assert.equal(workflowOf({ ok: false, reason: "no_transcript" }), null);
  assert.deepEqual(workflowOf({ ok: true, events: [{ kind: "prompt", at: 1, text: "hi" }, { kind: "prompt", at: "x", text: "bad" }, { kind: "evil" }] }), {
    events: [{ kind: "prompt", at: 1, text: "hi" }],
  });
  assert.deepEqual(workflowOf({ ok: true, events: [{ kind: "note", at: 1, text: "a", cancelled: true }, { kind: "action", at: 2, text: "b", cancelled: true }, { kind: "subagent", at: 3, description: "c", instructions: "", cancelled: true }, { kind: "note", at: 4, text: "d", cancelled: "yes" }, { kind: "prompt", at: 5, text: "e", cancelled: true }] }), {
    events: [
      { kind: "note", at: 1, text: "a", cancelled: true },
      { kind: "action", at: 2, text: "b", cancelled: true },
      { kind: "subagent", at: 3, description: "c", instructions: "", cancelled: true },
      { kind: "note", at: 4, text: "d" },
      { kind: "prompt", at: 5, text: "e" },
    ],
  });
  assert.deepEqual(filesOf({ files: ["a.md", "../etc/passwd", "", 3, "d/b.png"] }), ["a.md", "d/b.png"]);
  assert.deepEqual(commandsOf({ commands: [{ name: "/a", description: "x" }, { name: "b", description: "x" }] }), [{ name: "/a", description: "x" }]);
});

/** The screen path the session view takes: bytes into a headless terminal, then menu and status off its rows. */
function read(data: string): Promise<string[]> {
  const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
  return new Promise((resolve) =>
    term.write(data, () => {
      const buffer = term.buffer.active;
      const rows = [];
      for (let y = 0; y < buffer.length; y++) {
        const line = buffer.getLine(y)!;
        rows.push({ text: line.translateToString(true), wrapped: line.isWrapped });
      }
      term.dispose();
      resolve(reflow(rows));
    }));
}

test("demo: same routes and refusals as the PC, events the app can read", async () => {
  const events: Array<[string, unknown]> = [];
  const demo = createDemo((name, data) => events.push([name, data]));
  try {
    const listed = await demo.request("GET", "/api/state");
    const state = stateOf(listed.body);
    assert.ok(state && state.sessions.length === 9, "state passes the app's own check");
    const waiting = state.sessions.find((s) => s.mood === "waiting")!;
    const terminal = state.sessions.find((s) => !s.agent)!;

    const input = (body: Record<string, unknown>) => demo.request("POST", "/api/input", { body });
    assert.equal((await input({ s: waiting.id, text: "/exit" })).status, 422);
    assert.equal((await input({ s: waiting.id, text: "!ls" })).status, 403);
    assert.equal((await input({ s: waiting.id, text: "x".repeat(2001) })).status, 413);
    assert.equal((await input({ s: waiting.id, key: "ctrl-c" })).status, 400);
    // A plain terminal takes a line, as the PC's terminal tab does (the demo echoes it).
    assert.equal((await input({ s: terminal.id, text: "ls" })).status, 200);

    assert.equal((await demo.request("GET", `/api/events?s=${waiting.id}`)).status, 200);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const screen = screenOf(events.find(([name]) => name === "screen")?.[1]);
    assert.ok(screen);
    const menu = menuFrom(await read(screen.data));
    assert.deepEqual(menu?.map((option) => option.n), [1, 2, 3], "the demo's prompt reads as a three-button menu");

    assert.equal((await input({ s: waiting.id, key: "1" })).status, 200);
    const output = events.filter(([name]) => name === "output").at(-1)?.[1];
    assert.equal(typeof output, "string");
    assert.match(statusFrom(await read(output as string)) ?? "", /Working/);
    assert.equal(stateOf(events.filter(([name]) => name === "state").at(-1)?.[1])?.sessions.find((s) => s.id === waiting.id)?.mood, "working");

    const flow = workflowOf((await demo.request("GET", `/api/workflow?s=${waiting.id}`)).body);
    assert.ok(flow && flow.events.length > 0);
    const asked = workflowChangeOf((await demo.request("GET", `/api/workflow?s=${waiting.id}&v=`)).body);
    assert.ok(asked && "v" in asked && asked.v && asked.events.length === flow.events.length);
    assert.deepEqual(workflowChangeOf((await demo.request("GET", `/api/workflow?s=${waiting.id}&v=${asked.v}`)).body), { same: true });

    assert.equal(events.some(([name]) => name === "flow"), false, "only a phone that asks hears flow");
    assert.equal((await demo.request("GET", `/api/events?s=${waiting.id}&live=1`)).status, 200);
    assert.equal((await input({ s: waiting.id, text: "next" })).status, 200);
    assert.ok(events.some(([name]) => name === "flow"));
    const docs = filesOf((await demo.request("GET", `/api/docs?s=${waiting.id}`)).body);
    assert.ok(docs && docs.includes("README.md"));
    assert.equal((await demo.request("GET", `/api/doc?s=${waiting.id}&p=nope.md`)).status, 404);
    assert.equal((await demo.request("GET", `/api/file?s=${waiting.id}&p=src%2Fcart.ts`)).status, 200);
  } finally {
    demo.stop();
  }
});

test("a bad pane leaves the session outside", () => {
  const state = stateOf({ sessions: [{ id: "ab", pc: "p", folder: "f", mood: "idle", agent: true, pane: { n: 0, tab: 0, shown: true } }], pcs: [] });
  assert.equal(state?.sessions[0]?.pane, undefined);
  assert.deepEqual(stateOf({ sessions: [{ id: "ab", pc: "p", folder: "f", mood: "idle", agent: true, pane: { n: 3, tab: 2, shown: false } }], pcs: [] })?.sessions[0]?.pane, { n: 3, tab: 2, shown: false });
});

test("usage, PC ids and accounts are checked like the rest", () => {
  const state = stateOf({
    sessions: [],
    pcs: [{ id: "0123456789abcdef", label: "PC", state: "failed" }, { id: "node-1", label: "B", state: "off" }, { id: 7, label: "C", state: "live" }],
    usage: [
      { name: "Claude Code", fiveHour: { percent: 42, resetsAt: 1_800_000_000 }, week: { percent: 140 } },
      { name: "Codex", fiveHour: { percent: "12" } },
      { name: 5, fiveHour: { percent: 1 } },
      { name: "Agy", week: { percent: 3, resetsAt: "soon" } },
    ],
  });
  // A bad id is dropped, not the PC: it shows, without a reconnect button.
  assert.deepEqual(state?.pcs, [{ id: "0123456789abcdef", label: "PC", state: "failed" }, { label: "B", state: "off" }, { label: "C", state: "live" }]);
  assert.deepEqual(state?.usage, [{ name: "Claude Code", fiveHour: { percent: 42, resetsAt: 1_800_000_000 } }]);
  assert.equal("usage" in (stateOf({ sessions: [], pcs: [], usage: [{ name: "x" }] }) ?? {}), false, "nothing left, no card");
  assert.equal("usage" in (stateOf({ sessions: [], pcs: [], usage: "lots" }) ?? {}), false);

  assert.deepEqual(accountsOf({ pcs: [
    { pc: "PC", agents: [{ name: "Claude Code", state: "in", email: "me@example.com" }, { name: "Codex", state: "maybe" }, { name: 3, state: "in" }] },
    { pc: 9, agents: [] },
    { pc: "B", agents: "none" },
  ] }), [{ pc: "PC", agents: [{ name: "Claude Code", state: "in" }] }]);
  assert.equal(accountsOf({ pcs: "x" }), undefined);
  assert.equal(accountsOf(null), undefined);
});

test("demo: usage card, AI accounts and a PC to reconnect, with the PC's limit", async () => {
  const demo = createDemo(() => undefined);
  try {
    const state = stateOf((await demo.request("GET", "/api/state")).body)!;
    assert.ok(state.usage && state.usage.length > 0);
    const off = state.pcs.find((pc) => pc.state === "off");
    assert.ok(off?.id);
    const accounts = accountsOf((await demo.request("GET", "/api/accounts")).body);
    assert.ok(accounts && accounts.length > 0 && accounts[0]!.agents.length > 0);
    const reconnect = (id: unknown) => demo.request("POST", "/api/pc-reconnect", { body: { id } });
    assert.equal((await reconnect("ffffffffffffffff")).status, 404);
    assert.equal((await reconnect(off.id)).status, 200);
    assert.equal((await reconnect(off.id)).status, 429);
  } finally {
    demo.stop();
  }
});

test("steps are checked: known kinds only, five at most, none is no field", () => {
  const session = (steps: unknown) => stateOf({ sessions: [{ id: "ab", pc: "p", folder: "f", mood: "idle", agent: true, steps }], pcs: [] })?.sessions[0];
  assert.deepEqual(session(["prompt", "rm -rf", 3, "action", "subagent"])?.steps, ["prompt", "action", "subagent"]);
  assert.deepEqual(session(["action", "action", "action", "action", "action", "prompt"])?.steps, ["action", "action", "action", "action", "prompt"]);
  assert.equal("steps" in session(["nope"])!, false);
  assert.equal("steps" in session("prompt")!, false);
});

test("summaries and subagents are checked: capped, typed, dropped when bad", () => {
  const session = (extra: Record<string, unknown>) => stateOf({ sessions: [{ id: "ab", pc: "p", folder: "f", mood: "working", agent: true, ...extra }], pcs: [] })?.sessions[0];
  const progress = { files: 4, fileNames: ["cart.ts", 7, "x".repeat(80 * 16 + 1), "a.ts", "b.ts"], reads: 2, commands: 1, subagents: 3, running: 1, since: 5 };
  assert.deepEqual(session({ summary: { goal: "목표", now: { at: 9, kind: "action", text: "Edit cart.ts" }, result: "됐어요", progress, extra: "no" } })?.summary, {
    goal: "목표", now: { at: 9, kind: "action", text: "Edit cart.ts" }, result: "됐어요",
    progress: { files: 4, fileNames: ["cart.ts"], reads: 2, commands: 1, subagents: 3, running: 1, since: 5 },
  });
  // Too long, wrong type, negative or fractional: that part goes, the rest stays.
  assert.deepEqual(session({ summary: { goal: "g".repeat(200 * 16 + 1), now: { at: "9", kind: "action", text: "x" }, result: 3, progress: { ...progress, reads: -1 } } })?.summary, undefined);
  assert.deepEqual(session({ summary: { goal: "g", progress: { ...progress, running: 1.5 } } })?.summary, { goal: "g" });
  assert.equal("summary" in session({ summary: "lots" })!, false);
  const nine = Array.from({ length: 9 }, (_, i) => ({ label: `s${i}`, running: i < 2 }));
  assert.equal(session({ subagents: nine })?.subagents?.length, 8);
  // An empty label is what the PC sends for a subagent with no description: kept.
  assert.deepEqual(session({ subagents: [{ label: "a", running: "yes" }, { label: "", running: true }, { label: "b", running: false, doneAt: 7 }, { label: "c", running: false, doneAt: 9e15 }] })?.subagents, [{ label: "", running: true }, { label: "b", running: false, doneAt: 7 }]);
  // When it was sent and what it came back with: a time and a capped string, else the subagent is dropped.
  assert.deepEqual(session({ subagents: [{ label: "d", running: false, since: 5, doneAt: 7, result: "ok." }, { label: "e", running: true, since: "now" }, { label: "f", running: false, result: "x".repeat(80 * 16 + 1) }] })?.subagents, [{ label: "d", running: false, since: 5, doneAt: 7, result: "ok." }]);
  // Times Date cannot hold, counts that contradict each other, an unknown step kind: that part goes.
  assert.equal(session({ summary: { now: { at: 8.64e15, kind: "action", text: "x" } } })?.summary, undefined);
  assert.equal(session({ summary: { now: { at: 1, kind: "shell", text: "x" } } })?.summary, undefined);
  assert.equal(session({ summary: { now: { at: 1, text: "x" } } })?.summary, undefined);
  assert.equal(session({ summary: { progress: { ...progress, since: -9e15 } } })?.summary, undefined);
  assert.equal(session({ summary: { progress: { ...progress, running: 4 } } })?.summary, undefined);
  assert.equal(session({ summary: { progress: { ...progress, files: 0 } } })?.summary, undefined);
  // Emoji-heavy text the PC cut at 200 characters is far over 200 UTF-16 units, and still kept.
  const family = "👨‍👩‍👧‍👦".repeat(200);
  assert.equal(session({ summary: { goal: family, result: "" } })?.summary?.goal, family);
  assert.equal("subagents" in session({ subagents: [] })!, false);
});

test("demo: a map for each of two PCs, summaries that are the PC's own reading of its records", async () => {
  // The demo dates its finished work minutes ago; just after midnight that is yesterday and "done today" drops. Pin noon.
  const realNow = Date.now;
  const noon = new Date();
  noon.setHours(12, 0, 0, 0);
  Date.now = () => noon.getTime();
  const { phoneMap, progressLine } = await import("../workflowmap/phone-graph.ts");
  const { build } = await import("../../../cockpit/src/renderer/workflowmap/model.ts");
  const { forPhone } = await import("../../../cockpit/src/renderer/workflowmap/summary.ts");
  const demo = createDemo(() => undefined);
  try {
    const state = stateOf((await demo.request("GET", "/api/state")).body)!;
    assert.equal(state.pcs.length, 2);
    const words = { agent: "에이전트", terminal: "터미널" };
    const models = state.pcs.map((pc) => build(phoneMap(pc, state.sessions, words)));
    for (const model of models) {
      assert.equal(model.nodes[0]!.kind, "hub", "the PC is the hub");
      assert.equal(model.nodes.filter((node) => node.kind === "hub").length, 1, "one PC at a time");
      assert.ok(model.nodes.filter((node) => node.kind === "folder" || node.kind === "merged").length >= 2);
      assert.ok(model.nodes.some((node) => node.lines?.length), "summaries under the pills");
    }
    const [desk] = models;
    assert.ok(desk!.nodes.some((node) => node.kind === "merged"), "a one-session folder is one pill");
    assert.ok(desk!.nodes.some((node) => node.kind === "folder"), "api-server has two sessions");
    assert.equal(desk!.nodes.filter((node) => node.kind === "sub" && node.mood !== "done").length, 2, "the working session's two running subagents");
    assert.deepEqual(desk!.nodes[0]!.counts, { working: 1, waiting: 1, done: 4, subagents: 2 });
    assert.ok(desk!.edges.some((edge) => edge.kind === "branch" && edge.from === "f:shop-web"), "the worktree branches from shop-web");
    const working = desk!.nodes.find((node) => node.mood === "working" && node.lines);
    assert.equal(working?.lines?.[0]?.text, "Bash", "a command's text never reaches the phone");

    // The demo writes out what the PC would send; it must be what the PC's own function reads off the same record.
    for (const session of state.sessions) {
      const flow = workflowOf((await demo.request("GET", `/api/workflow?s=${session.id}`)).body);
      const told = forPhone(flow ?? undefined);
      const strip = (s?: typeof session.summary) => s && { ...s, ...(s.now ? { now: s.now.text } : {}), ...(s.progress ? { progress: { ...s.progress, since: 0 } } : {}) };
      assert.deepEqual(strip(session.summary), strip(told.summary), session.folder);
      assert.deepEqual(session.subagents, told.subagents, session.folder);
    }
    const busy = state.sessions.find((session) => session.mood === "working")!;
    assert.match(progressLine(busy.summary!, true), /orders\.ts, orders\.test\.ts/);
  } finally {
    demo.stop();
    Date.now = realNow;
  }
});

test("the xterm shim gives React Native's navigator what @xterm/headless reads at load", async () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { value: {}, configurable: true, writable: true });
  try {
    await import("./xterm-shim.ts?rn");
    const nav = (globalThis as unknown as { navigator: { userAgent: unknown; platform: unknown } }).navigator;
    assert.equal(typeof nav.userAgent, "string");
    assert.equal(typeof nav.platform, "string");
  } finally {
    if (saved) Object.defineProperty(globalThis, "navigator", saved);
  }
});

test("phone map: an agent step reads as one, and a subagent back before midnight is not today's", async () => {
  const { phoneMap } = await import("../workflowmap/phone-graph.ts");
  const { build } = await import("../../../cockpit/src/renderer/workflowmap/model.ts");
  const today = new Date(2026, 9, 31, 0, 30).getTime();
  const yesterday = new Date(2026, 9, 30, 23, 50).getTime();
  const pc = { label: "PC", state: "live" as const };
  const session = {
    id: "ab", pc: "PC", folder: "f", mood: "working" as const, agent: true,
    summary: { goal: "go", now: { at: today, kind: "agent" as const, text: "조사" }, progress: { files: 0, fileNames: [], reads: 0, commands: 0, subagents: 2, running: 1, since: yesterday } },
    subagents: [{ label: "조사", running: true }, { label: "어제 것", running: false, doneAt: yesterday }],
  };
  const model = build(phoneMap(pc, [session], { agent: "에이전트", terminal: "터미널" }, today));
  const pill = model.nodes.find((node) => node.lines?.length);
  assert.deepEqual(pill?.lines?.[0], { at: today, text: "조사", agent: true });
  assert.equal(model.nodes[0]!.counts!.done, 0, "came back yesterday");
  assert.deepEqual([model.nodes[0]!.state, model.nodes[0]!.os, model.nodes[0]!.local], ["live", undefined, undefined], "its ring is the PC's state; no OS is known here");
  assert.deepEqual(model.nodes.filter((node) => node.kind === "sub").map((node) => [node.label, node.mood]), [["조사", "working"], ["어제 것", "done"]], "running first, then the ones back as cards");
  const back = build(phoneMap(pc, [{ ...session, subagents: [session.subagents[0]!, { ...session.subagents[1]!, doneAt: today }] }], { agent: "에이전트", terminal: "터미널" }, today));
  assert.equal(back.nodes[0]!.counts!.done, 1, "came back today");
  const told = build(phoneMap(pc, [{ ...session, subagents: [{ label: "조사", running: true, since: today }, { label: "어제 것", running: false, since: today - 240000, doneAt: today, result: "찾았어요. 더 있어요." }] }], { agent: "에이전트", terminal: "터미널" }, today));
  assert.deepEqual(told.nodes.filter((node) => node.kind === "sub").map((node) => [node.since, node.result]), [[today, undefined], [today - 240000, "찾았어요."]], "its blocks: time out from when it was sent, what it came back with");
});

test("fmt: {n|one|many} says 1 file, 2 files", async () => {
  const { fmt } = await import("../i18n.ts");
  assert.equal(fmt("{n} {n|file|files} edited", { n: 1 }), "1 file edited");
  assert.equal(fmt("{n} {n|file|files} edited", { n: 2 }), "2 files edited");
  assert.equal(fmt("{m} {n}", { n: 3 }), "{m} 3");
});

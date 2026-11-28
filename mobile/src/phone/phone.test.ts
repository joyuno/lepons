import { test } from "node:test";
import assert from "node:assert/strict";

import xterm from "@xterm/headless"; // CommonJS: no named exports under Node
const { Terminal } = xterm;

import { reflow } from "./copied.ts";
import { menuFrom } from "./menu.ts";
import { statusFrom } from "./status.ts";
import { lampState, type PhoneBot } from "./types.ts";
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

test("the PC's ask is kept whole or dropped whole, never the session with it", () => {
  const good = {
    id: "0a1b2c3d", question: "Which fruits?", tabs: [{ label: "Fruits", done: false }, { label: "Submit", done: false }], tab: 0,
    options: [{ n: 1, label: "Apple", detail: "red", checked: true }, { n: 2, label: "Type something", freeText: true, checked: false }],
  };
  const trust = { id: "ff", options: [{ n: 1, label: "No, exit", keys: ["enter"] }, { n: 2, label: "Yes", keys: ["down", "enter"] }] };
  const ask = (value: unknown) => stateOf({ sessions: [{ id: "ab", pc: "p", folder: "f", mood: "waiting", agent: true, ask: value }], pcs: [] })?.sessions[0];
  assert.deepEqual(ask(good)?.ask, good);
  assert.deepEqual(ask(trust)?.ask, trust);
  for (const bad of [
    { ...good, id: "XYZ" },
    { ...good, question: "q".repeat(301) },
    { ...good, options: [] },
    { ...good, options: Array.from({ length: 10 }, (_, i) => ({ n: (i % 9) + 1, label: "x" })) },
    { ...good, options: [{ n: 1, label: "x".repeat(121) }] },
    { ...good, options: [{ n: 1, label: "x", freeText: false }] },
    { ...good, options: [{ n: 1, label: "x", key: "space" }] },
    { ...trust, options: [{ n: 1, label: "x", keys: ["\x1b[2J"] }] },
    { ...good, tab: 2 },
    { ...trust, tab: 0 },
    "nope",
  ]) {
    const session = ask(bad);
    assert.ok(session, "the session stays");
    assert.equal(session.ask, undefined, JSON.stringify(bad));
  }
});

test("the whole question set is kept whole, or only it is dropped", () => {
  const form = { id: "toolu_01", questions: [{ header: "Fruits", question: "Which fruits?", multiSelect: true, options: [{ label: "Apple", description: "red" }, { label: "Pear" }] }] };
  const menu = { id: "0a1b2c3d", tabs: [{ label: "Fruits", done: false }, { label: "Submit", done: false }], options: [{ n: 1, label: "Apple" }] };
  const ask = (value: unknown) => stateOf({ sessions: [{ id: "ab", pc: "p", folder: "f", mood: "waiting", agent: true, ask: value }], pcs: [] })?.sessions[0]?.ask;
  assert.deepEqual(ask({ ...menu, form })?.form, form);
  const one = form.questions[0]!;
  for (const bad of [
    { ...form, id: "toolu 01" },
    { ...form, questions: [] },
    { ...form, questions: Array.from({ length: 5 }, () => one) },
    { ...form, questions: [{ ...one, multiSelect: "yes" }] },
    { ...form, questions: [{ ...one, options: Array.from({ length: 5 }, () => ({ label: "x" })) }] },
    { ...form, questions: [{ ...one, options: [{ label: "" }] }] },
    { ...form, questions: [{ ...one, header: "h".repeat(41) }] },
  ]) assert.deepEqual(ask({ ...menu, form: bad }), menu, JSON.stringify(bad));
  // No tab line read (a lone question, or a narrow pane that wraps it): the form still comes.
  assert.deepEqual(ask({ id: "0a", options: [{ n: 1, label: "Apple" }], form })?.form, form);
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

test("phone map: bots hang under their folders, a folder with only bots shows, and a bot's own session is the bot", async () => {
  const { phoneMap } = await import("../workflowmap/phone-graph.ts");
  const { build, nodeOfSession } = await import("../../../cockpit/src/renderer/workflowmap/model.ts");
  const { t } = await import("../i18n.ts");
  const now = new Date(2026, 9, 31, 12, 0).getTime();
  const pc = { label: "PC", state: "live" as const };
  const session = { id: "s1", pc: "PC", folder: "app", mood: "idle" as const, agent: true };
  const botSession = { id: "s2", pc: "PC", folder: "app", mood: "working" as const, agent: true, bot: "정리봇" };
  const bot = (over: Partial<PhoneBot>): PhoneBot => ({
    id: "b", name: "봇", pc: "PC", pcId: "p", folder: "app", executor: "Claude Code", fresh: true, paused: false, state: "idle",
    next: null, last: null, missed: null, jobs: [], runs: [], sessionId: null, ...over,
  });
  const bots = [
    bot({ id: "b1", name: "정리봇", state: "running", sessionId: "s2" }),
    bot({ id: "b2", name: "보고봇", folder: "reports", next: new Date(now + 600000).toISOString(), last: { at: new Date(now - 60000).toISOString(), status: "failed", reason: "error" } }),
    bot({ id: "b3", name: "남의봇", pc: "Mac", folder: "elsewhere" }),
  ];
  const words = { agent: "에이전트", terminal: "터미널" };
  const input = phoneMap(pc, [session, botSession], words, now, bots);
  assert.deepEqual(input.folders.map((f) => f.id), ["app", "reports"], "a folder with only a bot is on the map; another PC's bot is not");
  assert.deepEqual(input.bots!.map((b) => b.id), ["b1", "b2"]);
  assert.deepEqual(input.bots![1]!.last, { at: now - 60000, state: "failed", why: t.botWhy_error });
  const model = build(input);
  assert.deepEqual(model.nodes.filter((n) => n.kind === "bot").map((n) => [n.id, n.parent, n.mood]), [["b:b1", "f:app", "working"], ["b:b2", "f:reports", "failed"]]);
  assert.equal(model.byId.get("f:app")!.kind, "merged", "the bot's own session is not a second session of its folder");
  assert.equal(nodeOfSession(model, "s2")!.id, "b:b1");
  assert.deepEqual(phoneMap(pc, [session], words, now), phoneMap(pc, [session], words, now, []), "no bots: the same input as before");
  assert.equal("bots" in phoneMap(pc, [session], words, now), false);
});

test("fmt: {n|one|many} says 1 file, 2 files", async () => {
  const { fmt } = await import("../i18n.ts");
  assert.equal(fmt("{n} {n|file|files} edited", { n: 1 }), "1 file edited");
  assert.equal(fmt("{n} {n|file|files} edited", { n: 2 }), "2 files edited");
  assert.equal(fmt("{m} {n}", { n: 3 }), "{m} 3");
});

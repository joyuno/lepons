import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";

import { relayBridge } from "../relay/bridge.ts";
import { encodeMessage, type Message } from "../relay/protocol.ts";
import type { PhoneSession, SessionWorkflowResult, WorkflowItem } from "../shared/ipc.ts";
import { PhoneAuth } from "./auth.ts";
import { OutputRing } from "./screen.ts";
import { createPhoneApi, MAX_SCREEN_JSON, sessionId, type PhoneDeps } from "./server.ts";

const KEY = "local::a";
const ID = sessionId(KEY);

/** A signed-in API over one session, on a clock these tests turn. */
function setup(t: TestContext, over: Partial<PhoneDeps> = {}, mood: () => PhoneSession["mood"] = () => "done") {
  let clock = 1_800_000_000_000;
  const auth = new PhoneAuth();
  const token = auth.open(clock, 0);
  const api = createPhoneApi({
    sessions: () => [{ key: KEY, nodeId: "local", repoId: "a", terminal: false, pc: "이 PC", folder: "a", mood: mood() }],
    isAgent: () => true,
    screen: () => ({ data: "", cols: 80, rows: 24 }),
    pcs: () => [],
    folders: () => [],
    signedIn: () => {},
    write: () => true,
    ...over,
  } as PhoneDeps, auth, () => clock);
  t.after(() => api.close());
  const sink = () => {
    const sent: Array<[string, unknown]> = [];
    return { sent, send: (name: string, data: unknown) => void sent.push([name, data]), end() {} };
  };
  const advance = (ms: number) => {
    clock += ms;
    t.mock.timers.tick(ms);
  };
  return { api, token, sink, advance, get: (path: string) => api.call({ method: "GET", path, token }), post: (path: string, body: Record<string, unknown>) => api.call({ method: "POST", path, token, body }) };
}

const names = (sent: Array<[string, unknown]>) => sent.map(([name]) => name);

/** The size the bug report measured: a full 64 KB ring, its escapes grown to six bytes each in JSON. */
function fullRing(end: string): string {
  const extra = 90_889 - 65_536 - JSON.stringify({ t: "event", name: "screen", data: { data: "", cols: 120, rows: 40 } }).length - (Buffer.byteLength(JSON.stringify(end)) - 2 - Buffer.byteLength(end));
  const escapes = "\x1b".repeat(Math.floor(extra / 5));
  const quotes = '"'.repeat(extra % 5);
  const ring = new OutputRing();
  ring.push(Buffer.from("x".repeat(65_536 - escapes.length - quotes.length - Buffer.byteLength(end))));
  ring.push(Buffer.from(escapes + quotes + end));
  return ring.bytes().toString("utf8");
}

test("a full screen used to be lost whole; its tail now reaches the phone, and what the phone reads off it", (t) => {
  const end = "\r\n❯ 1. Yes\r\n  2. No\r\n";
  const data = fullRing(end);
  const screen = { data, cols: 120, rows: 40 };
  const uncut: Message = { t: "event", name: "screen", data: screen };
  assert.equal(Buffer.byteLength(JSON.stringify(uncut)), 90_889, "the size the bug was seen at");
  assert.throws(() => encodeMessage(uncut), /too big/, "the bug itself: an event has no chunks");

  const { api, token } = setup(t, { screen: () => screen });
  const sent: Message[] = [];
  const connection = relayBridge(api)((message) => {
    encodeMessage(message);
    sent.push(message);
  });
  t.after(() => connection.close());
  connection.message({ t: "req", id: 1, method: "GET", path: `/api/events?s=${ID}`, token: token! });
  return new Promise<void>((done) => setImmediate(done)).then(() => {
    const shown = sent.find((message) => message.t === "event" && message.name === "screen");
    assert.ok(shown, "the screen event got through");
    const kept = (shown as { data: typeof screen }).data;
    assert.ok(Buffer.byteLength(JSON.stringify(kept)) <= MAX_SCREEN_JSON);
    assert.ok(data.endsWith(kept.data), "its newest part, nothing rewritten");
    assert.ok(kept.data.endsWith(end), "the menu at the end is there");
    assert.ok(kept.data.length > 10_000, "and most of what fits");
    assert.deepEqual([kept.cols, kept.rows], [120, 40]);
    assert.ok(sent.some((message) => message.t === "event" && message.name === "state"));
  });
});

test("a screen that fits goes as it always did", (t) => {
  const screen = { data: "\x1b[31mhello\x1b[0m", cols: 80, rows: 24 };
  const { api, token, sink } = setup(t, { screen: () => screen });
  assert.equal(api.watch(token, ID, sink())!.first[1]![1], screen);
});

test("state goes out only when it changed, stream by stream", (t) => {
  let mood: PhoneSession["mood"] = "done";
  const { api, token, sink } = setup(t, {}, () => mood);
  const one = sink();
  api.watch(token, null, one);
  api.changed();
  api.changed();
  assert.deepEqual(one.sent, [], "the list it started with, again");
  mood = "working";
  api.changed();
  api.changed();
  assert.deepEqual(names(one.sent), ["state"]);

  // No streams hear of the change back; one opened since started from what it says now.
  mood = "done";
  const two = sink();
  api.watch(token, null, two);
  api.changed();
  assert.deepEqual(names(one.sent), ["state", "state"]);
  assert.deepEqual(two.sent, []);
  mood = "working";
  api.changed();
  assert.deepEqual([names(one.sent).length, names(two.sent).length], [3, 1]);
});

test("a phone that did not ask gets every chunk as it comes, and no flow", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { api, token, sink, advance, post } = setup(t);
  const old = sink();
  api.watch(token, ID, old);
  api.output(KEY, "a");
  api.output(KEY, "b");
  void post("/api/input", { s: ID, text: "hi" });
  advance(10_000);
  assert.deepEqual(old.sent, [["output", "a"], ["output", "b"]]);
});

test("with live=1, output comes in one batch per 200 ms, nothing lost or reordered", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { api, token, sink, advance } = setup(t);
  const one = sink();
  api.watch(token, ID, one, true);
  api.output(KEY, "a");
  advance(100);
  api.output(KEY, "b");
  assert.deepEqual(one.sent, []);
  advance(100);
  assert.deepEqual(one.sent, [["output", "ab"]]);
  api.output("local::other", "not this session's");
  api.output(KEY, "c");
  advance(200);
  assert.deepEqual(one.sent, [["output", "ab"], ["output", "c"]]);
});

test("a burst too big for one frame comes in pieces that all fit", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { api, token, sink, advance } = setup(t);
  const one = sink();
  api.watch(token, ID, one, true);
  const burst = "\x1b".repeat(35_000);
  api.output(KEY, burst);
  api.output(KEY, "한글".repeat(5000));
  advance(200);
  const pieces = one.sent.filter(([name]) => name === "output").map(([, data]) => data as string);
  assert.equal(pieces.join(""), burst + "한글".repeat(5000));
  for (const data of pieces) encodeMessage({ t: "event", name: "output", data });
});

test("flow: after typing, when output goes quiet, and every 5 s of steady output", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { api, token, sink, advance, post } = setup(t);
  const one = sink();
  api.watch(token, ID, one, true);
  const flows = () => names(one.sent).filter((name) => name === "flow").length;

  void post("/api/input", { s: ID, text: "hi" });
  return new Promise<void>((done) => setImmediate(done)).then(() => {
    advance(799);
    assert.equal(flows(), 0);
    advance(1);
    assert.equal(flows(), 1, "0.8 s after the text went in");

    api.output(KEY, "x");
    advance(1499);
    assert.equal(flows(), 1);
    advance(1);
    assert.equal(flows(), 2, "1.5 s of quiet");

    // Steady output, a chunk per 500 ms for 20 s: never quiet.
    for (let i = 0; i < 40; i++) {
      api.output(KEY, "x");
      advance(500);
    }
    assert.equal(flows(), 2 + 3, "at 5, 10 and 15 s, and the next at 20");
    api.output(KEY, "x");
    assert.equal(flows(), 2 + 4);
    advance(1500);
    assert.equal(flows(), 2 + 5, "and when it stops");
  });
});

test("a stream that stopped hears nothing more", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { api, token, sink, advance } = setup(t);
  const one = sink();
  const opened = api.watch(token, ID, one, true)!;
  api.output(KEY, "a");
  opened.stop();
  advance(10_000);
  assert.deepEqual(one.sent, []);
});

test("/api/workflow without &v= answers as it always did", async (t) => {
  const workflow = { title: "제목", events: [{ kind: "prompt", at: 1, text: "p" }] as WorkflowItem[] };
  const { get } = setup(t, { workflow: async () => ({ ok: true, workflow }) });
  assert.deepEqual((await get(`/api/workflow?s=${ID}`)).body, { ok: true, ...workflow });
});

test("/api/workflow with &v=: unchanged is a few bytes; new events alone; anything else the whole list", async (t) => {
  let events: WorkflowItem[] = [{ kind: "prompt", at: 1, text: "p" }, { kind: "subagent", at: 2, description: "d", instructions: "i" }, { kind: "action", at: 3, text: "Read a", labels: ["Read a"] }];
  let result: SessionWorkflowResult = { ok: true, workflow: { events } };
  const { get } = setup(t, { workflow: async () => result });
  const ask = async (v: string, after?: number) => (await get(`/api/workflow?s=${ID}&v=${v}${after === undefined ? "" : `&after=${after}`}`)).body as { v: string; after?: number; events: WorkflowItem[]; same?: true };
  const set = (next: WorkflowItem[]) => {
    events = next;
    result = { ok: true, workflow: { events } };
  };

  const first = await ask("");
  assert.deepEqual(first.events, events);
  assert.match(first.v, /^[0-9a-f]{16}$/);
  assert.deepEqual(await ask(first.v, 3), { same: true });

  // The last row grows and a new one comes: from that time on, no more.
  set([...events.slice(0, 2), { kind: "action", at: 3, text: "Read a  ·  Read b", labels: ["Read a", "Read b"] }, { kind: "note", at: 4, text: "n" }]);
  const grown = await ask(first.v, 3);
  assert.equal(grown.after, 3);
  assert.deepEqual(grown.events.map((event) => event.at), [3, 4]);

  // An older row changed: a subagent came back. Only the whole list is right.
  set(events.map((event) => (event.kind === "subagent" ? { ...event, result: "r", resultAt: 5 } : event)));
  const changed = await ask(grown.v, 4);
  assert.equal(changed.after, undefined);
  assert.deepEqual(changed.events, events);

  // A "v" this PC no longer knows, or no time to go from: the whole list.
  set([...events, { kind: "note", at: 6, text: "m" }]);
  const unknown = await ask("0000000000000000", 4);
  assert.equal(unknown.after, undefined);
  assert.deepEqual(unknown.events, events);
  set([...events, { kind: "note", at: 7, text: "l" }]);
  assert.equal((await ask(unknown.v)).after, undefined);

  result = { ok: false, reason: "no_transcript" };
  assert.deepEqual(await ask(""), { ok: false, reason: "no_transcript" });
});

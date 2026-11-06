import { test } from "node:test";
import assert from "node:assert/strict";
import type { ChatItem } from "./chat.ts";
import { chatKeys, flowPoller, pollDelay, recentChat } from "./recent-chat.ts";

const settle = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

test("the wait doubles while nothing changes and stays short while the agent works", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 20].map((n) => pollDelay(n, false, 0)), [3000, 6000, 12_000, 24_000, 30_000, 30_000]);
  assert.deepEqual([0, 1, 2, 3, 20].map((n) => pollDelay(n, true, 0)), [3000, 6000, 12_000, 12_000, 12_000]);
});

test("a long answer waits longer, but never past the longest wait", () => {
  assert.equal(pollDelay(0, true, 67_000), 3350);
  assert.equal(pollDelay(0, true, 4_800_000), 30_000);
});

test("late answers cannot update a stopped screen, and only one ask runs at a time", async () => {
  const pending: Array<(value: string) => void> = [];
  const shown: string[] = [];
  const poll = flowPoller({
    request: () => new Promise<string>((resolve) => pending.push(resolve)),
    receive: (value) => { shown.push(value); return { changed: true, size: 0 }; },
    working: () => false,
  });
  const first = poll.now();
  void poll.now();
  poll.poke();
  assert.equal(pending.length, 1);
  poll.stop();
  pending[0]!("previous session");
  await first;
  assert.deepEqual(shown, []);
});

test("asks again on schedule: slower when unchanged, quick again after a change or a refresh", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  let answer = "a";
  let last = "";
  let asks = 0;
  const poll = flowPoller({
    request: async () => { asks += 1; return answer; },
    receive: (value) => { const changed = value !== last; last = value; return { changed, size: 0 }; },
    working: () => false,
  });
  await poll.now();
  assert.equal(asks, 1);
  t.mock.timers.tick(2999);
  await settle();
  assert.equal(asks, 1);
  t.mock.timers.tick(1); // 3 s after the change
  await settle();
  assert.equal(asks, 2);
  t.mock.timers.tick(5999); // unchanged once: now 6 s
  await settle();
  assert.equal(asks, 2);
  answer = "b";
  t.mock.timers.tick(1);
  await settle();
  assert.equal(asks, 3);
  t.mock.timers.tick(3000); // it changed: 3 s again
  await settle();
  assert.equal(asks, 4);
  await poll.now();
  assert.equal(asks, 5);
  poll.stop();
  t.mock.timers.tick(60_000);
  await settle();
  assert.equal(asks, 5);
});

test("the PC's status changed: the chat's next poller asks at once, whatever the backoff, and the old one's late answer is dropped", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const shown: string[] = [];
  const pending: Array<(value: string) => void> = [];
  const poller = (name: string) => flowPoller({
    request: () => { shown.push(`asked ${name}`); return new Promise<string>((resolve) => pending.push(resolve)); },
    receive: () => { shown.push(`${name} answered`); return { changed: false, size: 0 }; },
    working: () => true,
  });
  // session/[id].tsx keys its poller on the mood: this is what a new mood does.
  const old = poller("working");
  const answers = async () => { pending.shift()!("same"); await settle(); };
  void old.now();
  for (const wait of [6000, 12_000, 12_000]) {
    await answers();
    t.mock.timers.tick(wait);
    await settle();
  }
  assert.equal(shown.filter((line) => line === "asked working").length, 4);
  t.mock.timers.tick(5000); // deep in a 12 s wait
  old.stop();
  const next = poller("done");
  void next.now();
  assert.equal(shown.at(-1), "asked done");
  const before = shown.length;
  pending.shift()!("late, from before the change");
  await settle();
  assert.equal(shown.length, before);
  next.stop();
});

test("terminal output can only ask early once the last ask is 6 s old", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  let asks = 0;
  const poll = flowPoller({ request: async () => { asks += 1; }, receive: () => ({ changed: false, size: 0 }), working: () => false });
  await poll.now(); // the next ask is due in 6 s
  t.mock.timers.tick(5999);
  poll.poke();
  await settle();
  assert.equal(asks, 1);
  t.mock.timers.tick(1);
  poll.poke();
  await settle();
  assert.equal(asks, 2); // the same moment as the timer: still one ask
  poll.stop();
});

test("a PC that sends flow is asked when it says so, and every 60 s besides; terminal output no longer asks", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  let asks = 0;
  const poll = flowPoller({ request: async () => { asks += 1; }, receive: () => ({ changed: false, size: 0, pushed: true }), working: () => true });
  await poll.now();
  assert.equal(asks, 1);
  t.mock.timers.tick(59_999);
  poll.poke();
  await settle();
  assert.equal(asks, 1);
  t.mock.timers.tick(1);
  await settle();
  assert.equal(asks, 2);
  poll.flow();
  await settle();
  assert.equal(asks, 3, "at once, whatever the wait");
  t.mock.timers.tick(59_999);
  await settle();
  assert.equal(asks, 3, "the wait starts again from that ask");
  poll.stop();
});

test("flow during an ask: one more ask after it, however many came", async () => {
  const pending: Array<() => void> = [];
  const poll = flowPoller({
    request: () => new Promise<void>((resolve) => pending.push(resolve)),
    receive: () => ({ changed: false, size: 0, pushed: true }),
    working: () => true,
  });
  void poll.now();
  poll.flow();
  poll.flow();
  assert.equal(pending.length, 1);
  pending[0]!();
  await settle();
  assert.equal(pending.length, 2);
  pending[1]!();
  await settle();
  assert.equal(pending.length, 2);
  poll.stop();
});

test("a failed ask goes back to the quick pace", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  let asks = 0;
  let pushed = true;
  const poll = flowPoller({ request: async () => { asks += 1; }, receive: () => ({ changed: false, size: 0, pushed }), working: () => true });
  await poll.now();
  pushed = false;
  t.mock.timers.tick(60_000);
  await settle();
  assert.equal(asks, 2);
  t.mock.timers.tick(12_000);
  await settle();
  assert.equal(asks, 3, "as today's polling");
  poll.stop();
});

test("the window keeps the newest rows and each tools row keeps its own labels", () => {
  const tools = (at: number): ChatItem => ({ kind: "tools", commands: 1, edits: 0, reads: 0, other: 0, at });
  const say = (at: number): ChatItem => ({ kind: "agent", text: String(at), at });
  const items = [tools(1), say(2), tools(3), say(4)];
  const { rows, hidden } = recentChat(items, [["old"], ["new"]], 2);
  assert.equal(hidden, 2);
  assert.deepEqual(rows.map((row) => [row.item.at, row.labels]), [[3, ["new"]], [4, []]]);
  assert.equal(recentChat(items, [["old"], ["new"]], 30).hidden, 0);
  assert.equal(recentChat(items, [["old"], ["new"]], 30).rows.length, 4);
});

test("chatKeys stay with their rows as older ones drop off, and never repeat", () => {
  const a = { kind: "user", at: 1 };
  const b = { kind: "agent", at: 2 };
  assert.deepEqual(chatKeys([a, b, b]), ["1-user", "2-agent", "2-agent-1"]);
  assert.deepEqual(chatKeys([b, b]), ["2-agent", "2-agent-1"]);
});

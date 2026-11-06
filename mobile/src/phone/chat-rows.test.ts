import { test } from "node:test";
import assert from "node:assert/strict";
import { chatMemory, firstDrawn, sameRow, stillAtBottom } from "./chat-rows.ts";
import { chatFrom } from "./chat.ts";
import { chatKeys, CHAT_PAGE, recentChat } from "./recent-chat.ts";

test("a row rebuilt from a new answer with the same content is the same row", () => {
  const events = [
    { kind: "prompt", at: 1, text: "a" },
    { kind: "action", at: 2, text: "Read x", labels: ["Read x"] },
  ] as Parameters<typeof chatFrom>[0];
  const [first, second] = [chatFrom(events), chatFrom(events)];
  assert.notEqual(first[0], second[0]);
  assert.equal(sameRow({ item: first[0]!, labels: [] }, { item: second[0]!, labels: [] }), true);
  assert.equal(sameRow({ item: first[1]!, labels: ["Read x"] }, { item: second[1]!, labels: ["Read x"] }), true);
});

test("a row whose text, count, stop or labels changed draws again", () => {
  const row = { kind: "agent", text: "a", at: 1 };
  assert.equal(sameRow({ item: row, labels: [] }, { item: { ...row, text: "ab" }, labels: [] }), false);
  assert.equal(sameRow({ item: row, labels: [] }, { item: { ...row, cancelled: true }, labels: [] }), false);
  assert.equal(sameRow({ item: row, labels: ["x"] }, { item: row, labels: ["x", "y"] }), false);
  assert.equal(sameRow({ item: row, labels: ["x"] }, { item: row, labels: ["y"] }), false);
});

test("new rows leave the drawn window's first row where it is", () => {
  const keys = Array.from({ length: 40 }, (_, i) => `k${i}`);
  assert.equal(firstDrawn(keys, undefined, CHAT_PAGE), 10);
  const anchor = keys[10];
  assert.equal(firstDrawn([...keys, "k40", "k41"], anchor, CHAT_PAGE), 10);
  const items = [...keys, "k40"].map((key, i) => ({ kind: "user" as const, text: key, at: i }));
  const start = firstDrawn(chatKeys(items), chatKeys(items)[10], CHAT_PAGE);
  const { hidden, rows } = recentChat(items, [], items.length - start);
  assert.equal(hidden, 10);
  assert.equal(rows[0]!.item.text, "k10");
});

test("the window stays on its row when the PC's own window drops rows above it, and when it drops that row every row left is drawn", () => {
  const keys = Array.from({ length: 40 }, (_, i) => `k${i}`);
  assert.equal(firstDrawn(keys.slice(3), "k10", CHAT_PAGE), 7);
  assert.equal(firstDrawn(keys.slice(1), "k0", CHAT_PAGE), 0, "a reader who asked for the oldest rows keeps them: not back to the newest page");
  assert.equal(firstDrawn([], undefined, CHAT_PAGE), 0);
});

test("only the reader moving up leaves the bottom", () => {
  const at = (y: number, viewport = 600, content = 2000) => ({ y, viewport, content });
  assert.equal(stillAtBottom(true, 1400, at(1400)), true);
  assert.equal(stillAtBottom(true, 1400, at(1200)), false, "moved up by hand");
  assert.equal(stillAtBottom(true, 1400, at(1350)), true, "up, but within reach of the bottom");
});

test("a keyboard, a taller bar or new rows do not make the chat stop following", () => {
  assert.equal(stillAtBottom(true, 1400, { y: 1400, viewport: 300, content: 2000 }), true, "the keyboard took 300");
  assert.equal(stillAtBottom(true, 1400, { y: 1400, viewport: 600, content: 2500 }), true, "a batch of rows arrived before the follow");
});

test("a reader above stays above until back at the bottom", () => {
  assert.equal(stillAtBottom(false, 800, { y: 900, viewport: 600, content: 2000 }), false);
  assert.equal(stillAtBottom(false, 900, { y: 1390, viewport: 600, content: 2000 }), true);
});

test("the chat memory gives back the last answer, holds eight, and forgets on clear", () => {
  const memory = chatMemory();
  const flow = { events: [] };
  memory.set("a", "{}", flow);
  assert.equal(memory.get("a")?.value, flow);
  assert.equal(memory.get("a")?.json, "{}");
  for (let i = 0; i < 8; i++) memory.set(`s${i}`, "{}", flow);
  assert.equal(memory.get("a"), undefined, "the oldest went");
  assert.ok(memory.get("s7"));
  memory.set("s0", "{}", null); // used again: now the newest
  memory.set("s8", "{}", flow);
  assert.ok(memory.get("s0"));
  assert.equal(memory.get("s1"), undefined);
  memory.clear();
  assert.equal(memory.get("s0"), undefined);
});

test("too long a chat is not kept, and the older copy of it goes too", () => {
  const memory = chatMemory();
  memory.set("a", "{}", { events: [] });
  memory.set("a", "x".repeat(1_000_001), { events: [] });
  assert.equal(memory.get("a"), undefined);
});

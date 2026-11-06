import { test } from "node:test";
import assert from "node:assert/strict";
import { draftBook, type DraftStorage } from "./drafts.ts";
import { outbox, stillWaiting, waitUntil, type Waiting } from "./outbox.ts";

const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

function memory() {
  const saved = new Map<string, string>();
  const storage: DraftStorage = {
    get: async (key) => saved.get(key) ?? null,
    set: async (key, value) => void saved.set(key, value),
    del: async (key) => void saved.delete(key),
  };
  return { saved, written: () => [...saved.values()].join("") };
}

function setUp(t: { mock: { timers: { enable(o: { apis: Array<"setTimeout" | "Date"> }): void } } }) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const disk = memory();
  const drafts = draftBook({
    get: async (key) => disk.saved.get(key) ?? null,
    set: async (key, value) => void disk.saved.set(key, value),
    del: async (key) => void disk.saved.delete(key),
  });
  return { disk, drafts, sends: outbox(drafts) };
}

test("pressed: the bubble is up, the box is empty, and the saved draft still holds the text", async (t) => {
  const { disk, drafts, sends } = setUp(t);
  drafts.edit("s", "안녕");
  sends.begin("s", "안녕", 5);
  await settle();
  assert.deepEqual(sends.waiting("s").map((one) => one.item.text), ["안녕"]);
  assert.equal(sends.box("s"), "");
  assert.equal(sends.flying("s"), true);
  assert.match(disk.written(), /안녕/, "already on disk: a crash mid-send loses nothing");
  sends.typed("s", ""); // what the emptied box's effect does
  assert.equal(drafts.peek("s"), "안녕");
});

test("accepted: no draft is left behind, on disk either, and the bubble stays", async (t) => {
  const { disk, drafts, sends } = setUp(t);
  drafts.edit("s", "안녕");
  sends.begin("s", "안녕", 5);
  await settle();
  sends.accepted("s");
  await settle();
  assert.equal(drafts.peek("s"), "");
  assert.equal(disk.written(), "");
  assert.equal(sends.flying("s"), false);
  assert.equal(sends.waiting("s").length, 1);
});

test("refused: the bubble goes and the box gets the text back with the reason", async (t) => {
  const { drafts, sends } = setUp(t);
  const back: Array<[string, string]> = [];
  sends.onReturned("s", (box, why) => back.push([box, why]));
  drafts.edit("s", "안녕");
  sends.begin("s", "안녕", 5);
  sends.refused("s", "보내지 못했어요");
  assert.deepEqual(back, [["안녕", "보내지 못했어요"]]);
  assert.equal(sends.waiting("s").length, 0);
  assert.equal(sends.flying("s"), false);
  assert.equal(drafts.peek("s"), "안녕");
  assert.equal(sends.box("s"), "안녕");
});

test("typed during a send: kept when it is accepted, and after the text when it is refused", async (t) => {
  const { drafts, sends } = setUp(t);
  drafts.edit("a", "먼저");
  sends.begin("a", "먼저", 0);
  sends.typed("a", "다음");
  assert.equal(drafts.peek("a"), "먼저\n다음");
  assert.equal(sends.box("a"), "다음");
  sends.accepted("a");
  assert.equal(drafts.peek("a"), "다음");
  assert.equal(sends.box("a"), "다음");

  drafts.edit("b", "먼저");
  sends.begin("b", "먼저", 0);
  sends.typed("b", "다음");
  sends.refused("b", "no");
  assert.equal(sends.box("b"), "먼저\n다음");
  assert.equal(drafts.peek("b"), "먼저\n다음");
});

test("a box opened mid-send shows only what was typed, and hears the refusal", (t) => {
  const { drafts, sends } = setUp(t);
  drafts.edit("s", "안녕");
  const first: string[] = [];
  const off = sends.onReturned("s", (box) => first.push(box));
  sends.begin("s", "안녕", 0);
  off(); // the files tab took the screen
  assert.equal(sends.box("s"), "");
  const second: string[] = [];
  sends.onReturned("s", (box) => second.push(box));
  sends.refused("s", "no");
  assert.deepEqual(first, []);
  assert.deepEqual(second, ["안녕"]);
});

test("the bubble ends when the transcript shows the same words, and not for an older row with those words", (t) => {
  const { sends } = setUp(t);
  sends.begin("s", "네  맞아요\n그걸로", 100);
  const old = { kind: "user", text: "네 맞아요 그걸로", at: 99 };
  const agent = { kind: "agent", text: "네 맞아요 그걸로", at: 200 };
  sends.landed("s", [old, agent]);
  assert.equal(sends.waiting("s").length, 1);
  sends.landed("s", [old, agent, { kind: "user", text: " 네 맞아요 그걸로 ", at: 300 }]);
  assert.equal(sends.waiting("s").length, 0);
});

test("the same words again get their own bubble, even with the first as the transcript's last row", (t) => {
  const { sends } = setUp(t);
  const first = { kind: "user", text: "계속", at: 100 };
  sends.begin("s", "계속", 100);
  assert.equal(stillWaiting(sends.waiting("s"), [first]).length, 1);
  sends.landed("s", [first]);
  assert.equal(sends.waiting("s").length, 1);
  sends.landed("s", [first, { ...first, at: 101 }]);
  assert.equal(sends.waiting("s").length, 0);
});

test("a pasted tab hands over: the PC types the text without it", (t) => {
  const { sends } = setUp(t);
  sends.begin("s", "탭	있는 말", 0);
  sends.landed("s", [{ kind: "user", text: "탭있는 말", at: 1 }]);
  assert.equal(sends.waiting("s").length, 0);
});

test("the same draft waits for itself: what the transcript does not show yet stays the same list, so nothing redraws", () => {
  const list = [{ item: { kind: "user", text: "a", at: 1 }, after: 0, timer: undefined as never }] as Waiting[];
  assert.equal(stillWaiting(list, [{ kind: "agent", text: "a", at: 5 }]), list);
});

test("a bubble the transcript never shows goes after 30 s", (t) => {
  const { sends } = setUp(t);
  const told: number[] = [];
  sends.subscribe(() => told.push(sends.waiting("s").length));
  sends.begin("s", "/compact", 0);
  sends.accepted("s");
  (t.mock.timers as unknown as { tick(ms: number): void }).tick(29_999);
  assert.equal(sends.waiting("s").length, 1);
  (t.mock.timers as unknown as { tick(ms: number): void }).tick(1);
  assert.equal(sends.waiting("s").length, 0);
  assert.equal(told.at(-1), 0);
});

test("another session's send stays out of this one", (t) => {
  const { sends } = setUp(t);
  sends.begin("a", "x", 0);
  assert.equal(sends.flying("b"), false);
  assert.equal(sends.waiting("b").length, 0);
  assert.equal(sends.box("b"), "");
});

test("a send waits for the link, up to 5 s, and goes on as soon as it is up", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const tick = async (ms: number) => { for (let i = 0; i < ms; i += 100) { await settle(); t.mock.timers.tick(100); } await settle(); };
  let up = false;
  let done = false;
  void waitUntil(() => up).then(() => { done = true; });
  await tick(4000);
  assert.equal(done, false);
  up = true;
  await tick(100);
  assert.equal(done, true);

  up = false;
  done = false;
  void waitUntil(() => up).then(() => { done = true; });
  await tick(4900);
  assert.equal(done, false);
  await tick(100);
  assert.equal(done, true, "gives up at 5 s: the send then fails as it did before");
});

test("two sends while the first is out: both bubbles, in order, each waits its turn, none lost", async (t) => {
  const { drafts, sends } = setUp(t);
  const order: string[] = [];
  const answers: Array<() => void> = [];
  const press = (text: string) => {
    drafts.edit("s", [drafts.peek("s"), text].filter(Boolean).join("\n"));
    sends.begin("s", text, 0);
    sends.turn("s", async () => {
      order.push(text);
      await new Promise<void>((resolve) => answers.push(resolve));
      sends.accepted("s");
    });
  };
  press("하나");
  await settle();
  press("둘");
  sends.typed("s", "쓰는 중");
  await settle();
  assert.deepEqual(sends.waiting("s").map((one) => one.item.text), ["하나", "둘"]);
  assert.equal(sends.box("s"), "쓰는 중");
  assert.deepEqual(order, ["하나"], "the second waits for the PC's answer to the first");
  answers.shift()!();
  await settle();
  (t.mock.timers as unknown as { tick(ms: number): void }).tick(399);
  await settle();
  assert.deepEqual(order, ["하나"], "and for the PC to type the first one's Enter");
  (t.mock.timers as unknown as { tick(ms: number): void }).tick(1);
  await settle();
  assert.deepEqual(order, ["하나", "둘"]);
  answers.shift()!();
  await settle();
  assert.equal(sends.flying("s"), false);
  assert.equal(drafts.peek("s"), "쓰는 중");
});

test("the first of two is refused: its text comes back to the box, the second still goes", (t) => {
  const { drafts, sends } = setUp(t);
  const back: string[] = [];
  sends.onReturned("s", (box) => back.push(box));
  drafts.edit("s", "하나");
  sends.begin("s", "하나", 0);
  drafts.edit("s", "하나\n둘");
  sends.begin("s", "둘", 0);
  sends.refused("s", "no");
  assert.deepEqual(back, ["하나"]);
  assert.equal(sends.box("s"), "하나");
  assert.equal(sends.flying("s"), true);
  assert.deepEqual(sends.waiting("s").map((one) => one.item.text), ["둘"]);
  sends.accepted("s");
  assert.equal(drafts.peek("s"), "하나");
});

test("a queued message's bubble outlasts a long turn; a slash command's does not", (t) => {
  const { drafts, sends } = setUp(t);
  drafts.edit("s", "이어서");
  sends.begin("s", "이어서", 0);
  sends.accepted("s");
  drafts.edit("c", "/compact");
  sends.begin("c", "/compact", 0);
  sends.accepted("c");
  (t.mock.timers as unknown as { tick(ms: number): void }).tick(30_000);
  assert.equal(sends.waiting("s").length, 1);
  assert.equal(sends.waiting("c").length, 0);
  (t.mock.timers as unknown as { tick(ms: number): void }).tick(5 * 60_000);
  assert.equal(sends.waiting("s").length, 0);
});

test("all refused: the texts come back in the order they were pressed, before what was typed", (t) => {
  const { drafts, sends } = setUp(t);
  for (const text of ["하나", "둘", "셋"]) {
    drafts.edit("s", [drafts.peek("s"), text].filter(Boolean).join("\n"));
    sends.begin("s", text, 0);
  }
  sends.typed("s", "쓰는 중");
  sends.refused("s", "no");
  sends.refused("s", "no");
  sends.refused("s", "no");
  assert.equal(sends.box("s"), "하나\n둘\n셋\n쓰는 중");
  assert.equal(sends.flying("s"), false);
});

test("a short message is not landed by a longer one that holds its letters", () => {
  const list = [{ item: { kind: "user", text: "ok", at: 1 }, after: 0 }] as unknown as Waiting[];
  assert.equal(stillWaiting(list, [{ kind: "user", text: "token 고쳐줘", at: 5 }]).length, 1);
});

test("messages the agent joined into one row all land", () => {
  const list = [{ item: { kind: "user", text: "하나", at: 1 }, after: 0 }, { item: { kind: "user", text: "둘", at: 2 }, after: 0 }] as unknown as Waiting[];
  assert.equal(stillWaiting(list, [{ kind: "user", text: "하나\n둘", at: 5 }]).length, 0);
});

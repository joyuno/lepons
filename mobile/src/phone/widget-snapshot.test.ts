import { test } from "node:test";
import assert from "node:assert/strict";
import type { PhoneSessionView } from "./types.ts";
import { widgetSnapshot } from "./widget-snapshot.ts";

const words = { waiting: "대기", working: "작업", done: "완료", open: "열기", more: "외 {n}개", asks: "답을 기다려요", empty: "없음" };
const session = (id: string, mood: PhoneSessionView["mood"], extra: Partial<PhoneSessionView> = {}): PhoneSessionView =>
  ({ id, pc: "회사 PC", folder: `/w/${id}`, mood, agent: true, agentName: "Claude Code", ...extra });

test("the widget lists AI sessions waiting first, counts them, and puts the newest question on top", () => {
  const snap = widgetSnapshot("회사 PC", [
    session("a", "working"),
    session("b", "waiting", { preview: "적용할까요?\n1. 네\n2. 아니요", summary: { now: { at: 100, kind: "note", text: "" } } as PhoneSessionView["summary"] }),
    session("c", "done"),
    session("t", "working", { agent: false }),
    session("d", "waiting", { summary: { now: { at: 300, kind: "note", text: "" } } as PhoneSessionView["summary"] }),
  ], words, (mood) => `[${mood}]`, 42);
  assert.equal(snap.at, 42);
  assert.deepEqual([snap.waiting, snap.working, snap.done], [2, 1, 1]);
  assert.deepEqual(snap.rows.map((row) => row.id).slice(0, 2).sort(), ["b", "d"]);
  assert.ok(!snap.rows.some((row) => row.id === "t"), "a plain terminal is no AI session");
  assert.deepEqual(snap.asks.map((ask) => ask.id), ["d", "b"]);
  assert.equal(snap.asks[1]!.text, "적용할까요?\n1. 네\n2. 아니요");
  assert.equal(snap.rows.find((row) => row.id === "a")!.label, "[working]");
});

test("a long question keeps its end, where the choices are", () => {
  const snap = widgetSnapshot("PC", [session("x", "waiting", { preview: `${"앞".repeat(900)}\n1. 네` })], words, String, 0);
  assert.ok(snap.asks[0]!.text!.endsWith("1. 네"));
  assert.ok(snap.asks[0]!.text!.length <= 601);
});

test("after the waiting ones, the session that moved last comes first, failed or not, with what it is doing", () => {
  const at = (n: number, text = "step", result?: string) => ({ summary: { now: { at: n, kind: "action", text }, ...(result ? { result } : {}) } as PhoneSessionView["summary"] });
  const snap = widgetSnapshot("PC", [
    session("old-fail", "failed", at(10, "broke")),
    session("new-work", "working", at(50, "Edit  src/app.ts\n")),
    session("wait", "waiting", at(5)),
    session("done", "done", at(40, "last step", "All tests pass")),
  ], words, String, 0);
  assert.deepEqual(snap.rows.map((row) => row.id), ["wait", "new-work", "done", "old-fail"]);
  assert.equal(snap.rows[1]!.now, "Edit src/app.ts");
  assert.equal(snap.rows[1]!.at, 50);
  assert.equal(snap.rows[2]!.now, "All tests pass", "a finished one shows its result");
});

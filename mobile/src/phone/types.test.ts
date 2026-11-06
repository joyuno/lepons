import { test } from "node:test";
import assert from "node:assert/strict";
import { byUrgency, type Mood } from "./types.ts";

test("working sessions list above failed ones, and each kind keeps the PC's order", () => {
  const list = [
    { id: "a", mood: "failed" }, { id: "b", mood: "done" }, { id: "c", mood: "working" }, { id: "d", mood: "working", agentGone: true },
    { id: "e", mood: "idle" }, { id: "f", mood: "working" }, { id: "g", mood: "waiting" },
  ] as Array<{ id: string; mood: Mood; agentGone?: boolean }>;
  assert.deepEqual(byUrgency(list).map((one) => one.id), ["g", "c", "f", "a", "b", "e", "d"]);
});

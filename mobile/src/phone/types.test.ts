import { test } from "node:test";
import assert from "node:assert/strict";
import { byUrgency, folderName, underOriginals, type Mood } from "./types.ts";

test("a worktree's sessions sit under their original folder's last one on the same PC", () => {
  const list = [
    { id: "w1", pc: "A", folder: "로그인 수정", worktreeOf: "lepons", worktree: "로그인 수정" },
    { id: "a", pc: "A", folder: "lepons" },
    { id: "b", pc: "B", folder: "lepons" },
    { id: "c", pc: "A", folder: "lepons" },
    { id: "w2", pc: "B", folder: "x", worktreeOf: "gone" },
  ];
  assert.deepEqual(underOriginals(list).map(({ session, nested }) => `${session.id}${nested ? ">" : ""}`), ["a", "b", "c", "w1>", "w2"]);
  assert.equal(folderName(list[0]!), "lepons · 로그인 수정");
  assert.equal(folderName(list[1]!), "lepons");
});

test("working sessions list above failed ones, and each kind keeps the PC's order", () => {
  const list = [
    { id: "a", mood: "failed" }, { id: "b", mood: "done" }, { id: "c", mood: "working" }, { id: "d", mood: "working", agentGone: true },
    { id: "e", mood: "idle" }, { id: "f", mood: "working" }, { id: "g", mood: "waiting" },
  ] as Array<{ id: string; mood: Mood; agentGone?: boolean }>;
  assert.deepEqual(byUrgency(list).map((one) => one.id), ["g", "c", "f", "a", "b", "e", "d"]);
});

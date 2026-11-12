import { test } from "node:test";
import assert from "node:assert/strict";
import { sessionList } from "./session-list.ts";
import type { Mood } from "./types.ts";

const s = (id: string, pc: string, folder: string, mood: Mood, worktreeOf?: string) => ({ id, pc, folder, mood, ...(worktreeOf ? { worktreeOf, worktree: folder } : {}) });

test("waiting sessions first; then each PC in the PC's order, open by urgency, then closed, worktrees under their original", () => {
  const sessions = [
    s("a", "pc-c", "app", "failed"),
    s("b", "pc-b", "app", "working"),
    s("w", "pc-b", "task 1", "done", "app"),
    s("q", "pc-b", "docs", "waiting"),
    s("x", "pc-a", "api", "done"),
  ];
  const folders = [
    { id: "f1", pc: "pc-b", folder: "notes" },
    { id: "f2", pc: "pc-b", folder: "task 2", worktreeOf: "app" },
    { id: "f3", pc: "pc-b", folder: "task 3", worktreeOf: "web" },
    { id: "f4", pc: "pc-b", folder: "web" },
  ];
  const pcs = [{ id: "p0", label: "pc-a", state: "live" as const }, { id: "p1", label: "pc-b", state: "live" as const }, { id: "p2", label: "pc-c", state: "failed" as const }];
  const { waiting, groups } = sessionList(sessions, folders, pcs);
  assert.deepEqual(waiting.map(({ session }) => session.id), ["q"]);
  assert.deepEqual(groups.map((group) => [group.pc, group.state, group.pcId]), [["pc-a", "live", "p0"], ["pc-b", "live", "p1"], ["pc-c", "failed", "p2"]]);
  const home = groups[1]!.rows.map((row) => `${row.kind === "session" ? row.session.id : row.folder.id}${row.nested ? (row.lastNested ? "└" : "├") : ""}`);
  assert.deepEqual(home, ["b", "w├", "f2└", "f1", "f4", "f3└"]);
});

test("a worktree whose original is not in its PC's part stands alone; a PC with nothing is left out", () => {
  const { groups } = sessionList([s("w", "A", "task 1", "working", "app"), s("o", "A", "app", "waiting")], [], [{ label: "B", state: "live" }]);
  assert.deepEqual(groups.map((group) => group.pc), ["A"]);
  assert.deepEqual(groups[0]!.rows.map((row) => [row.kind, row.nested]), [["session", false]]);
  assert.equal(groups[0]!.state, undefined);
});

import { test } from "node:test";
import assert from "node:assert/strict";

import { editedPaths, outside, overlap } from "./worktree-files.ts";

test("overlap is the same file by its place in the repository, however the paths are spelled", () => {
  assert.deepEqual(
    overlap(
      { root: "C:/Users/me/.lepons/worktrees/app-1/fix", paths: ["C:\\Users\\me\\.lepons\\worktrees\\app-1\\fix\\src\\a.ts", "C:/Users/me/.lepons/worktrees/app-1/fix/b.ts"] },
      { root: "C:/work/app", paths: ["c:\\work\\app\\src\\a.ts", "C:/work/app/c.ts", "C:/work/app/src/a.ts"] },
    ),
    ["src/a.ts"],
  );
});

test("an edit outside the worktree is found; one inside it, or a relative path, is not", () => {
  assert.deepEqual(outside("/home/u/.lepons/worktrees/app-1/fix", ["/home/u/.lepons/worktrees/app-1/fix/a.ts", "/home/u/app/a.ts", "a.ts", "/home/u/app/a.ts"]), ["/home/u/app/a.ts"]);
  // A sibling whose name only starts the same is outside.
  assert.deepEqual(outside("/w/fix", ["/w/fix-2/a.ts"]), ["/w/fix-2/a.ts"]);
});

test("edited paths come from the action rows of a read", () => {
  assert.deepEqual(editedPaths({ ok: true, workflow: { events: [{ kind: "prompt", at: 0, text: "x" }, { kind: "action", at: 1, text: "Edit a", paths: ["/a"] }, { kind: "action", at: 2, text: "Bash" }] } }), ["/a"]);
  assert.deepEqual(editedPaths({ ok: false, reason: "no_transcript" }), []);
  assert.deepEqual(editedPaths(undefined), []);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { containingRepo, freeCopyName, removeScript, transferProblem, transferScript } from "./entry-ops.ts";

const repos = [{ path: "/srv/api" }, { path: "C:/work/web/" }];

test("an entry is in reach only strictly inside a registered folder", () => {
  assert.equal(containingRepo(repos, "/srv/api/src/main.ts"), repos[0]);
  assert.equal(containingRepo(repos, "C:/work/web/index.html"), repos[1], "a trailing slash on the folder is not part of the rule");
  assert.equal(containingRepo(repos, "/srv/api"), undefined, "the folder itself is the registration, not an entry");
  assert.equal(containingRepo(repos, "/srv/api-old/x"), undefined, "a sibling sharing the prefix is outside");
  assert.equal(containingRepo(repos, "/srv/api/../etc/passwd"), undefined);
  assert.equal(containingRepo(repos, "/srv/api/..\\..\\etc"), undefined, "nor by backslash on Windows");
});

test("a folder cannot be copied or moved into itself, nor anything out of reach", () => {
  assert.equal(transferProblem(repos, "/srv/api/src", "/srv/api/src/lib/src"), "into_itself");
  assert.equal(transferProblem(repos, "/srv/api/src", "/srv/api/src copy"), undefined, "a name that merely starts the same is fine");
  assert.equal(transferProblem(repos, "/srv/api/a.txt", "/etc/a.txt"), "outside");
  assert.equal(transferProblem(repos, "/srv/api/a.txt", "C:/work/web/a.txt"), undefined, "between two folders on one machine");
});

test("a pasted copy takes a free name the way VS Code names it", () => {
  assert.equal(freeCopyName("a.txt", new Set(), false), "a.txt", "no clash, no rename");
  assert.equal(freeCopyName("a.txt", new Set(["a.txt"]), false), "a copy.txt");
  assert.equal(freeCopyName("a.txt", new Set(["a.txt", "a copy.txt"]), false), "a copy 2.txt");
  assert.equal(freeCopyName(".env", new Set([".env"]), false), ".env copy", "a dotfile has no extension to keep");
  assert.equal(freeCopyName("v1.2", new Set(["v1.2"]), true), "v1.2 copy", "a folder's dot is part of its name");
});

// Run for real in a scratch folder, names with spaces and quotes included:
// these strings are executed by a shell on the node.
test("the remote scripts copy, move and remove, and refuse a taken name", () => {
  const root = mkdtempSync(join(tmpdir(), "lepons-entry-"));
  const sh = (script: string): number => {
    try {
      execFileSync("sh", ["-c", script], { cwd: root, stdio: "ignore" });
      return 0;
    } catch (error) {
      return (error as { status: number }).status;
    }
  };
  try {
    mkdirSync(join(root, "it's dir"));
    writeFileSync(join(root, "it's dir", "a b.txt"), "x");
    writeFileSync(join(root, "taken.txt"), "keep");

    assert.equal(sh(transferScript("it's dir", "it's dir copy", false)), 0);
    assert.equal(readFileSync(join(root, "it's dir copy", "a b.txt"), "utf8"), "x", "a folder copies with its contents");
    assert.equal(sh(transferScript("it's dir/a b.txt", "taken.txt", false)), 3);
    assert.equal(sh(transferScript("it's dir/a b.txt", "taken.txt", true)), 3);
    assert.equal(readFileSync(join(root, "taken.txt"), "utf8"), "keep", "a taken name is never written over");

    assert.equal(sh(transferScript("it's dir copy", "moved", true)), 0);
    assert.ok(existsSync(join(root, "moved", "a b.txt")) && !existsSync(join(root, "it's dir copy")));
    assert.equal(sh(removeScript("moved")), 0);
    assert.ok(!existsSync(join(root, "moved")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

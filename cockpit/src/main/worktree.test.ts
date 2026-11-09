import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { addWorktree, goneWorktrees, localHost, mergeWorktree, movedTranscript, pendingWork, removeWorktree, slugFor, startPoint, startRepo } from "./worktree.ts";

const git = localHost.git;
const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

/** A temp repository with one commit on `main`, and a home for its worktrees. */
function repo(): { folder: string; home: string; done: () => void } {
  const top = realpathSync(mkdtempSync(join(tmpdir(), "lepons-wt-"))).replaceAll("\\", "/");
  const folder = `${top}/project`;
  execFileSync("git", ["init", "-q", "-b", "main", folder]);
  sh(folder, "config", "user.email", "t@example.com");
  sh(folder, "config", "user.name", "T");
  sh(folder, "config", "core.autocrlf", "false");
  writeFileSync(`${folder}/a.txt`, "one\n");
  writeFileSync(`${folder}/.gitignore`, ".env*\nbuild/\n");
  writeFileSync(`${folder}/.env`, "SECRET=1\n");
  writeFileSync(`${folder}/.worktreeinclude`, "build/\n");
  mkdirSync(`${folder}/build`);
  writeFileSync(`${folder}/build/out.js`, "x\n");
  sh(folder, "add", "a.txt", ".gitignore", ".worktreeinclude");
  sh(folder, "commit", "-q", "-m", "first");
  return { folder, home: `${top}/home`, done: () => rmSync(top, { recursive: true, force: true }) };
}

const make = async (folder: string, home: string, task = "Fix login") => {
  const made = await addWorktree(localHost, { folder, home, task, taken: [] });
  assert.ok(made.ok, JSON.stringify(made));
  return made;
};

test("a slug is a-z, 0-9 and dashes, numbered past those taken", () => {
  assert.equal(slugFor("Fix the Login!", () => false), "fix-the-login");
  assert.equal(slugFor("로그인 수정", () => false), "task");
  assert.equal(slugFor("../../etc; rm -rf", () => false), "etc-rm-rf");
  assert.equal(slugFor("fix", (slug) => slug === "fix" || slug === "fix-2"), "fix-3");
});

test("a worktree is made outside the repository, on its own branch, with ignored secrets and listed entries copied", async () => {
  const { folder, home, done } = repo();
  try {
    const made = await make(folder, home);
    assert.equal(made.branch, "lepons/fix-login");
    assert.equal(made.base, "main");
    assert.ok(made.path.startsWith(`${home}/.lepons/worktrees/project-`));
    assert.ok(!made.path.startsWith(folder));
    assert.equal(readFileSync(`${made.path}/a.txt`, "utf8"), "one\n");
    assert.equal(readFileSync(`${made.path}/.env`, "utf8"), "SECRET=1\n");
    assert.ok(existsSync(`${made.path}/build/out.js`));
    // The same name again gets the next number.
    const again = await make(folder, home);
    assert.equal(again.branch, "lepons/fix-login-2");
  } finally {
    done();
  }
});

test("반영: uncommitted work is committed, rebased onto the base and fast-forwarded into the original", async () => {
  const { folder, home, done } = repo();
  try {
    const made = await make(folder, home);
    writeFileSync(`${made.path}/b.txt`, "new\n");
    // The original moved on meanwhile: the rebase takes the worktree past it.
    writeFileSync(`${folder}/c.txt`, "c\n");
    sh(folder, "add", "c.txt");
    sh(folder, "commit", "-q", "-m", "c");
    assert.deepEqual(await pendingWork(git, made.path, made.base), { commits: 0, files: 1 });
    const merged = await mergeWorktree(git, { folder, path: made.path, branch: made.branch, base: made.base, message: "Fix login" });
    assert.deepEqual(merged, { ok: true });
    assert.equal(readFileSync(`${folder}/b.txt`, "utf8"), "new\n");
    assert.equal(sh(folder, "log", "-1", "--format=%s"), "Fix login");
    assert.deepEqual(await removeWorktree(git, { folder, path: made.path, branch: made.branch, force: false }), { ok: true });
    assert.ok(!existsSync(made.path));
    assert.equal(sh(folder, "branch", "--list", made.branch), "");
  } finally {
    done();
  }
});

test("a conflicting rebase is aborted and nothing reaches the original", async () => {
  const { folder, home, done } = repo();
  try {
    const made = await make(folder, home);
    writeFileSync(`${made.path}/a.txt`, "worktree\n");
    writeFileSync(`${folder}/a.txt`, "original\n");
    sh(folder, "commit", "-q", "-am", "original");
    const before = sh(folder, "rev-parse", "HEAD");
    const merged = await mergeWorktree(git, { folder, path: made.path, branch: made.branch, base: made.base, message: "m" });
    assert.deepEqual(merged, { ok: false, reason: "conflict" });
    assert.equal(sh(folder, "rev-parse", "HEAD"), before);
    assert.ok(!existsSync(join(sh(made.path, "rev-parse", "--absolute-git-dir"), "rebase-merge")));
  } finally {
    done();
  }
});

test("the original's own uncommitted change to the same file refuses the merge and stays as it was", async () => {
  const { folder, home, done } = repo();
  try {
    const made = await make(folder, home);
    writeFileSync(`${made.path}/a.txt`, "worktree\n");
    writeFileSync(`${folder}/a.txt`, "mine, not committed\n");
    const merged = await mergeWorktree(git, { folder, path: made.path, branch: made.branch, base: made.base, message: "m" });
    assert.equal(merged.ok ? "ok" : merged.reason, "refused");
    assert.equal(readFileSync(`${folder}/a.txt`, "utf8"), "mine, not committed\n");
    assert.equal(sh(folder, "log", "-1", "--format=%s"), "first");
  } finally {
    done();
  }
});

test("반영 asks for the original to be on the base branch", async () => {
  const { folder, home, done } = repo();
  try {
    const made = await make(folder, home);
    sh(folder, "checkout", "-q", "-b", "other");
    assert.deepEqual(await mergeWorktree(git, { folder, path: made.path, branch: made.branch, base: made.base, message: "m" }), { ok: false, reason: "moved", current: "other" });
  } finally {
    done();
  }
});

test("removing counts what would be lost, and only force takes unmerged work", async () => {
  const { folder, home, done } = repo();
  try {
    const made = await make(folder, home);
    writeFileSync(`${made.path}/b.txt`, "b\n");
    sh(made.path, "add", "b.txt");
    sh(made.path, "commit", "-q", "-m", "b");
    writeFileSync(`${made.path}/a.txt`, "changed\n");
    assert.deepEqual(await pendingWork(git, made.path, made.base), { commits: 1, files: 1 });
    assert.equal((await removeWorktree(git, { folder, path: made.path, branch: made.branch, force: false })).ok, false);
    assert.ok(existsSync(made.path));
    assert.deepEqual(await removeWorktree(git, { folder, path: made.path, branch: made.branch, force: true }), { ok: true });
    assert.ok(!existsSync(made.path));
    assert.equal(sh(folder, "branch", "--list", made.branch), "");
  } finally {
    done();
  }
});

test("a worktree deleted by hand is found gone; one still there is not", async () => {
  const { folder, home, done } = repo();
  try {
    const kept = await make(folder, home, "kept");
    const lost = await make(folder, home, "lost");
    rmSync(lost.path, { recursive: true, force: true });
    assert.deepEqual(await goneWorktrees(git, folder, [kept.path, lost.path]), [lost.path]);
    // git cannot say: nothing is gone.
    assert.deepEqual(await goneWorktrees(git, `${folder}/nowhere`, [kept.path]), []);
    // Spelled otherwise than git lists it (as a link in the home would): still a work tree, so kept.
    const respelled = `${kept.path}/../${kept.path.split(/[\\/]/).pop()}`;
    assert.deepEqual(await goneWorktrees(git, folder, [respelled]), []);
  } finally {
    done();
  }
});

test("a detached HEAD is refused; a plain folder is offered git, without its secrets in the first commit", async () => {
  const { folder, home, done } = repo();
  try {
    sh(folder, "checkout", "-q", "--detach");
    assert.deepEqual(await startPoint(git, folder), { ok: false, reason: "detached" });
    const plain = `${home}-plain`;
    mkdirSync(plain, { recursive: true });
    writeFileSync(`${plain}/main.py`, "print(1)\n");
    writeFileSync(`${plain}/.env`, "SECRET=1\n");
    assert.deepEqual(await startPoint(git, plain), { ok: false, reason: "not_repo" });
    assert.deepEqual(await startRepo(git, plain), { ok: true });
    assert.equal(sh(plain, "ls-files"), "main.py");
    const made = await make(plain, home);
    assert.ok(existsSync(`${made.path}/main.py`));
  } finally {
    done();
  }
});

test("a moved Claude record names the new folder", () => {
  const jsonl = [
    JSON.stringify({ type: "user", cwd: "C:\\work\\app", sessionId: "s" }),
    JSON.stringify({ type: "summary" }),
    JSON.stringify({ type: "user", cwd: "C:\\work\\other" }),
    "not json \"cwd\"",
  ].join("\n");
  const moved = movedTranscript(jsonl, "C:/work/app", "C:/wt/fix").split("\n");
  assert.equal(JSON.parse(moved[0]!).cwd, "C:\\wt\\fix");
  assert.equal(moved[1], jsonl.split("\n")[1]);
  assert.equal(JSON.parse(moved[2]!).cwd, "C:\\work\\other");
  assert.equal(moved[3], "not json \"cwd\"");
});

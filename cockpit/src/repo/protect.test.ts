import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { scratchDir } from "../scratch-dir.ts";

import { protectCommand, protectLocally, isSecretName, parseProtectOutput } from "./protect.ts";

const repo = async (setup?: string): Promise<string> => {
  const dir = scratchDir("lepons-git-");
  execFileSync("git", ["init", "-q", "."], { cwd: dir });
  if (setup) execFileSync("sh", ["-c", setup], { cwd: dir });
  return dir;
};

test("only secret-shaped names are protected", () => {
  for (const name of [".env", ".env.local", ".env.production"]) {
    assert.equal(isSecretName(name), true, name);
  }
  for (const name of ["README.md", "environment.ts", "env"]) {
    assert.equal(isSecretName(name), false, name);
  }
});

// The whole point of asking git rather than reading .gitignore: an existing
// rule in another form already covers the path, and appending would add a
// line that changes nothing.
test("git decides, so a rule in another form is not duplicated", async () => {
  const dir = scratchDir("lepons-git-");
  const sh = (command: string) => execFileSync("sh", ["-c", command], { cwd: dir, encoding: "utf8" });
  sh("git init -q .");
  await writeFile(join(dir, ".gitignore"), "*.env\n");

  sh(protectCommand(".env"));

  assert.equal(readFileSync(join(dir, ".gitignore"), "utf8"), "*.env\n", "nothing appended");
});

test("the rule is added once, and only once", async () => {
  const dir = scratchDir("lepons-git-");
  const sh = (command: string) => execFileSync("sh", ["-c", command], { cwd: dir, encoding: "utf8" });
  sh("git init -q .");

  sh(protectCommand(".env"));
  sh(protectCommand(".env"));

  assert.equal(readFileSync(join(dir, ".gitignore"), "utf8"), ".env\n");
});

test("a file git already tracks is reported, because ignoring will not help", async () => {
  const dir = scratchDir("lepons-git-");
  const sh = (command: string) => execFileSync("sh", ["-c", command], { cwd: dir, encoding: "utf8" });
  sh("git init -q . && printf 'SECRET=1\\n' > .env && git add -f .env");

  const seen = parseProtectOutput(sh(protectCommand(".env")));

  assert.deepEqual(seen, { gitRepo: true, ignored: true, tracked: true });
});

// The local branch runs on whatever platform the cockpit is on, including
// Windows, where the shell line above would reach cmd.exe and do nothing.
test("the local path ignores the file with no shell involved", async () => {
  const dir = await repo();

  const seen = await protectLocally(dir, ".env");

  assert.deepEqual(seen, { gitRepo: true, ignored: true, tracked: false });
  assert.equal(readFileSync(join(dir, ".gitignore"), "utf8"), ".env\n");
});

test("the local path writes the rule for a nested file, at the repository root", async () => {
  const dir = await repo("mkdir -p services/api");

  const seen = await protectLocally(dir, "services/api/.env");

  assert.equal(seen.ignored, true);
  assert.equal(readFileSync(join(dir, ".gitignore"), "utf8"), "services/api/.env\n");
});

// The two branches are two implementations of one promise; a difference
// between them is a machine where the operator is told something untrue.
test("the local path and the remote shell line agree", async () => {
  for (const setup of ["", "printf '*.env\\n' > .gitignore", "printf 'S=1\\n' > .env && git add -f .env"]) {
    const local = await repo(setup);
    const remote = await repo(setup);

    const fromLocal = await protectLocally(local, ".env");
    const fromRemote = parseProtectOutput(
      execFileSync("sh", ["-c", protectCommand(".env")], { cwd: remote, encoding: "utf8" }),
    );

    assert.deepEqual(fromLocal, fromRemote, setup);
    assert.equal(readFileSync(join(local, ".gitignore"), "utf8"), readFileSync(join(remote, ".gitignore"), "utf8"));
  }
});

test("the local path leaves a directory that is not a repository alone", async () => {
  const dir = scratchDir("lepons-git-");

  assert.deepEqual(await protectLocally(dir, ".env"), { gitRepo: false, ignored: false, tracked: false });
});

test("a directory that is not a repository is left alone", async () => {
  const dir = scratchDir("lepons-git-");
  const output = execFileSync("sh", ["-c", protectCommand(".env")], { cwd: dir, encoding: "utf8" });

  assert.equal(parseProtectOutput(output).gitRepo, false);
});

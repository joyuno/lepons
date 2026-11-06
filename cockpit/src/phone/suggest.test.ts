import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { claudeBuiltins, codexBuiltins, commandFrom, commandScript, describe, matchFiles, mergeCommands, parseCommandOutput } from "./suggest.ts";
import { parseFindOutput, safePath } from "./docs.ts";
import { posixQuote } from "../session/state.ts";

test("built-ins never offer a way out of the agent", () => {
  for (const name of ["/exit", "/quit", "/logout", "/login"]) {
    assert.equal(claudeBuiltins.some((command) => command.name === name), false, name);
    assert.equal(codexBuiltins.some((command) => command.name === name), false, name);
  }
  assert.ok(claudeBuiltins.some((command) => command.name === "/compact"));
  assert.ok(codexBuiltins.some((command) => command.name === "/review"));
});

test("a description comes from front matter, else the first line", () => {
  assert.equal(describe("---\nname: x\ndescription: \"Ship a release\"\n---\nbody"), "Ship a release");
  assert.equal(describe("# Deploy to staging\n\nsteps…"), "Deploy to staging");
  assert.equal(describe(""), "");
});

test("files become commands: Claude commands, skills, Codex prompts", () => {
  assert.deepEqual(commandFrom("commands", "deploy.md", "# Deploy"), { name: "/deploy", description: "Deploy" });
  assert.deepEqual(commandFrom("commands", "git/pr.md", "Open a PR"), { name: "/git:pr", description: "Open a PR" });
  assert.deepEqual(commandFrom("skills", "graphify/SKILL.md", "---\nname: graphify\ndescription: Knowledge graph\n---\n"), { name: "/graphify", description: "Knowledge graph" });
  assert.deepEqual(commandFrom("skills", "folder/SKILL.md", "---\ndescription: d\n---\n"), { name: "/folder", description: "d" });
  assert.deepEqual(commandFrom("prompts", "draftpr.md", "Draft a PR"), { name: "/prompts:draftpr", description: "Draft a PR" });
  assert.equal(commandFrom("skills", "a/b/SKILL.md", ""), undefined);
  assert.equal(commandFrom("skills", "a/README.md", ""), undefined);
  assert.equal(commandFrom("commands", "notes.txt", ""), undefined);
  assert.equal(commandFrom("commands", "../evil.md", ""), undefined);
  assert.equal(commandFrom("commands", "we ird$(x).md", ""), undefined);
});

test("the remote discovery script, run for real in a shell, parses back", () => {
  const home = mkdtempSync(join(tmpdir(), "lepons-cmds-"));
  mkdirSync(join(home, "commands", "git"), { recursive: true });
  mkdirSync(join(home, "skills", "graphify"), { recursive: true });
  writeFileSync(join(home, "commands", "deploy.md"), "---\ndescription: Deploy it\n---\nrun");
  writeFileSync(join(home, "commands", "git", "pr.md"), "# Open a PR");
  writeFileSync(join(home, "skills", "graphify", "SKILL.md"), "---\nname: graphify\ndescription: Graph\n---\n");
  const posix = home.replace(/\\/g, "/");
  const script = commandScript([
    { kind: "commands", dir: `${posix}/commands` },
    { kind: "skills", dir: `${posix}/skills` },
    { kind: "prompts", dir: `${posix}/missing` },
  ], posixQuote);
  const output = execFileSync("bash", ["-c", script], { encoding: "utf8" });
  assert.deepEqual(parseCommandOutput(output).sort((a, b) => a.name.localeCompare(b.name)), [
    { name: "/deploy", description: "Deploy it" },
    { name: "/git:pr", description: "Open a PR" },
    { name: "/graphify", description: "Graph" },
  ]);
});

test("custom commands follow the built-ins, without shadowing one", () => {
  const merged = mergeCommands(claudeBuiltins, [{ name: "/compact", description: "mine" }, { name: "/deploy", description: "d" }]);
  assert.equal(merged.filter((command) => command.name === "/compact").length, 1);
  assert.equal(merged.at(-1)!.name, "/deploy");
});

test("@ paths: only safe relative paths, matched by every word, file names first", () => {
  const listing = "./src/auth.ts\0./src/auth/README.md\0./evil\n/etc/passwd\0./a/../../x\0/abs\0./docs/auth-notes.md\0";
  const files = parseFindOutput(listing, () => true);
  assert.deepEqual(files, ["src/auth.ts", "src/auth/README.md", "docs/auth-notes.md"]);
  assert.equal(safePath("C:/x"), false);
  assert.deepEqual(matchFiles(files, "auth"), ["src/auth.ts", "docs/auth-notes.md", "src/auth/README.md"]);
  assert.deepEqual(matchFiles(files, "src read"), ["src/auth/README.md"]);
  assert.equal(matchFiles(Array.from({ length: 200 }, (_, i) => `f${i}.ts`), "").length, 50);
});

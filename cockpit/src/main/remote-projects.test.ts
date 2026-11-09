import { test } from "node:test";
import assert from "node:assert/strict";

import { existingFoldersCommand, parseExistingFolders, parseRemoteProjects } from "./remote-projects.ts";

test("remote scan: one folder per path, both tools, newest first, sdk runs and shell noise skipped", () => {
  const output = [
    "Welcome to Ubuntu",
    'LPJ\tclaude\t1700000000\t"cwd":"/home/a/web"\t"entrypoint":"cli"',
    'LPJ\tcodex\t1700000500\t"cwd":"/home/a/web/"\t',
    'LPJ\tclaude\t1700000300\t"cwd":"/home/a/api"\t',
    'LPJ\tclaude\t1700000900\t"cwd":"/home/a/bot"\t"entrypoint":"sdk-ts"',
    'LPJ\tclaude\t1700000100\t"cwd":"/home/a/my \\"q\\" dir"\t',
    "LPJ\tclaude\t1700000100\tbroken",
  ].join("\r\n");
  assert.deepEqual(parseRemoteProjects(output, ["/home/a/api"]), [
    { path: "/home/a/web", tools: ["claude", "codex"], lastUsed: 1700000500000, known: false },
    { path: "/home/a/api", tools: ["claude"], lastUsed: 1700000300000, known: true },
    { path: '/home/a/my "q" dir', tools: ["claude"], lastUsed: 1700000100000, known: false },
  ]);
});

test("remote scan: which folders are still there, quoted for the shell", () => {
  assert.equal(
    existingFoldersCommand(["/a b", "/it's"]),
    `for p in '/a b' '/it'\\''s'; do [ -d "$p" ] && printf 'LPD\\t%s\\n' "$p"; done; true`,
  );
  assert.deepEqual(parseExistingFolders("motd\nLPD\t/a b\r\nLPD\t/c\n"), new Set(["/a b", "/c"]));
});

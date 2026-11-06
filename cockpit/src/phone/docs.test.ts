import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { posixQuote } from "../session/state.ts";
import { markdownFiles, parseFindOutput, safeRelative, viewable, viewableFindScript, phoneDirectory, phoneDirectoryScript, parsePhoneDirectory } from "./docs.ts";

test("lists .md files only, skipping hidden folders, node_modules and symlinks", async () => {
  const root = mkdtempSync(join(tmpdir(), "lepons-docs-"));
  const outside = mkdtempSync(join(tmpdir(), "lepons-outside-"));
  writeFileSync(join(outside, "secret.md"), "x");
  for (const dir of ["docs/specs", ".git", "node_modules/pkg", "a/b/c/d/e"]) mkdirSync(join(root, dir), { recursive: true });
  for (const file of ["README.md", "notes.txt", "docs/specs/plan.MD", ".git/x.md", "node_modules/pkg/README.md", "a/b/c/deep.md", "a/b/c/d/e/too-deep.md"]) {
    writeFileSync(join(root, file), "x");
  }
  try {
    symlinkSync(join(outside, "secret.md"), join(root, "link.md"));
  } catch {
    // Windows without the symlink privilege: the rest still holds.
  }
  assert.deepEqual((await markdownFiles(root)).sort(), ["README.md", "a/b/c/deep.md", "docs/specs/plan.MD"]);
});

test("a name with a newline cannot make the listing name a path outside the folder", () => {
  // `printf 'x' > $'evil\n/etc/passwd.md'` on the PC: line-split, that was two entries.
  const output = "./README.md\0./evil\n/etc/passwd.md\0./docs/plan.md\0./a/../../secret.md\0";
  assert.deepEqual(parseFindOutput(output), ["README.md", "docs/plan.md"]);
});

test("only relative .md paths without .. or control characters pass", () => {
  for (const ok of ["README.md", "docs/plan.md", "한글 문서.md", "a..b.md"]) assert.equal(safeRelative(ok), true, ok);
  for (const bad of ["", "/etc/passwd.md", "\\\\server\\x.md", "C:/x.md", "c:x.md", "../x.md", "docs/../../x.md", "docs\\..\\x.md",
    "evil\n/etc/x.md", "tab\t.md", "notes.txt"]) {
    assert.equal(safeRelative(bad), false, JSON.stringify(bad));
  }
});

test("the viewer lists md, images, PDF and HTML, nothing else, with the same path checks", () => {
  for (const ok of ["README.md", "shots/a.PNG", "x.jpeg", "chart.svg", "r.pdf", "site/index.html"]) assert.equal(viewable(ok), true, ok);
  for (const bad of ["run.sh", "a.png.exe", "../x.png", "/etc/x.pdf", "a\n/x.png", "noext"]) assert.equal(viewable(bad), false, bad);
  assert.deepEqual(parseFindOutput("./a.png\0./evil\n/x.pdf\0./b.sh\0./site/i.html\0", viewable), ["a.png", "site/i.html"]);
  // A read refuses a backslash, so a list must not offer what will not open.
  assert.deepEqual(parseFindOutput("./a\\b.md\0./c.md\0", viewable), ["c.md"]);
  // A name not in UTF-8 (EUC-KR, say) arrives with its bytes lost, and no read finds it under that name.
  assert.deepEqual(parseFindOutput("./�.md\0./c.md\0", viewable), ["c.md"]);
  assert.deepEqual(parsePhoneDirectory("f�.md\0fc.md\0"), [{ name: "c.md", directory: false }]);
  assert.match(viewableFindScript, /-iname '\*\.pdf'/);
});


test("directory browsing includes hidden files and empty folders, but never follows symlinks or escapes", async () => {
  const root = mkdtempSync(join(tmpdir(), "lepons-phone-tree-"));
  const outside = mkdtempSync(join(tmpdir(), "lepons-phone-outside-"));
  mkdirSync(join(root, "empty"));
  writeFileSync(join(root, ".env"), "secret");
  writeFileSync(join(root, "code.ts"), "code");
  try { symlinkSync(outside, join(root, "link"), "dir"); } catch {}
  assert.deepEqual((await phoneDirectory(root, ""))?.sort((a, b) => a.name.localeCompare(b.name)), [
    { name: ".env", directory: false }, { name: "code.ts", directory: false }, { name: "empty", directory: true },
  ]);
  assert.deepEqual(await phoneDirectory(root, "empty"), []);
  for (const path of ["../outside", "empty/../outside", "link", "empty\\..", "/tmp"]) assert.equal(await phoneDirectory(root, path), undefined);
  assert.equal(phoneDirectoryScript(root, "../outside", (x) => x), undefined);
  assert.deepEqual(parsePhoneDirectory("dempty\0f.env\0d../bad\0flink\nname\0"), [{ name: "empty", directory: true }, { name: ".env", directory: false }]);
});

test("the remote directory script is sh's whatever the account's shell, and takes quotes and spaces", () => {
  const root = mkdtempSync(join(tmpdir(), "lepons phone-")).replaceAll("\\", "/");
  mkdirSync(join(root, "it's here", "empty"), { recursive: true });
  writeFileSync(join(root, "it's here", ".env"), "x");
  const script = phoneDirectoryScript(root, "it's here", posixQuote)!;
  assert.match(script, /^sh -c '/);
  const names = parsePhoneDirectory(execFileSync("bash", ["-c", script], { encoding: "utf8" })).sort((a, b) => a.name.localeCompare(b.name));
  assert.deepEqual(names, [{ name: ".env", directory: false }, { name: "empty", directory: true }]);
});

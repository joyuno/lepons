import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";

import { readLocalFile } from "./local.ts";
import { grepLocal } from "./grep-local.ts";
import { maxReadBytes, readThrough, type ReadDisk } from "./envelope.ts";
import { containedBy } from "./wire-path.ts";

// The local half of read_file / search_repo: what an agent on another PC gets
// from a folder on this one. A link inside the shared folder must not lead
// out of it, a Korean name must read like any other, and size is bounded.
test("a shared folder on this PC is read and searched inside its own bounds only", async () => {
  const base = mkdtempSync(join(tmpdir(), "lepons-local-"));
  try {
    mkdirSync(join(base, "outside"));
    writeFileSync(join(base, "outside", "secret.txt"), "OUTSIDE needle\n");
    const root = join(base, "한글 폴더");
    mkdirSync(join(root, "문서"), { recursive: true });
    writeFileSync(join(root, "문서", "메모.md"), "안에 있는 needle\n");
    writeFileSync(join(root, "big.txt"), Buffer.alloc(maxReadBytes + 1, 97));
    // A junction needs no privilege on Windows; elsewhere the type is ignored.
    symlinkSync(join(base, "outside"), join(root, "link"), "junction");
    // As addFolder stores it: forward slashes, no trailing one.
    const shared = root.replaceAll("\\", "/");
    const read = (path: string) => readLocalFile({ id: "t", root: shared, path, salt: "s" });

    const memo = await read("문서/메모.md");
    assert.equal(Buffer.from(memo.entry!.content_base64, "base64").toString("utf8"), "안에 있는 needle\n");

    for (const escape of ["link/secret.txt", "../outside/secret.txt", "link"]) {
      const refused = await read(escape);
      assert.equal(refused.entry?.kind === "file", false, escape);
      assert.ok(refused.error || refused.entry?.kind === "symlink", escape);
    }
    assert.equal((await read("big.txt")).error?.message, "file exceeds the read limit");

    const found = await grepLocal({ root: shared, pattern: "needle", salt: "s" });
    assert.ok(found.ok);
    assert.deepEqual(found.matches.map((match) => match.path), ["문서/메모.md"]);
    const through = await grepLocal({ root: shared, pattern: "needle", salt: "s", subPath: "link" });
    assert.equal(through.ok, false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// A whole drive (stored as "C:/") or a POSIX root ("/") added as a folder:
// reads resolve under it and search results come back relative to it.
test("a root folder reads and searches with paths relative to the root", async () => {
  const base = mkdtempSync(join(tmpdir(), "lepons-root-"));
  try {
    mkdirSync(join(base, "sub"));
    writeFileSync(join(base, "sub", "a.txt"), "root needle\n");
    const absolute = base.replaceAll("\\", "/");
    const root = process.platform === "win32" ? absolute.slice(0, 3) : "/";
    const relative = absolute.slice(root.length);

    const read = await readLocalFile({ id: "t", root, path: `${relative}/sub/a.txt`, salt: "s" });
    assert.equal(Buffer.from(read.entry!.content_base64, "base64").toString("utf8"), "root needle\n");

    const found = await grepLocal({ root, pattern: "root needle", salt: "s", subPath: relative });
    assert.ok(found.ok);
    assert.deepEqual(found.matches.map((match) => match.path), [`${relative}/sub/a.txt`]);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("containment holds for root folders", () => {
  assert.equal(containedBy("/", "/etc/hosts"), true);
  assert.equal(containedBy("C:/", "C:/Users/x"), true);
  assert.equal(containedBy("C:/", "D:/x"), false);
});

// On a POSIX disk a backslash is a character of a name, so a link to a file named
// `x\..\..\secret.txt` must not come to mean a path out of the root once resolved.
test("a backslash in a name another PC resolves to is not read as a way out of the root", async () => {
  const name = String.raw`/srv/repo/x\..\..\secret.txt`;
  const files = new Map([[name, "the file in the root"], ["/srv/secret.txt", "OUTSIDE"]]);
  const disk: ReadDisk = {
    realpath: async (path) => (path === "/srv/repo/link" ? name : path),
    lstat: async (path) => {
      const content = files.get(posix.normalize(path));
      if (content === undefined) throw new Error("no such file");
      return { isSymbolicLink: () => false, isFile: () => true, size: content.length };
    },
    readFile: async (path) => Buffer.from(files.get(posix.normalize(path))!),
  };
  const read = await readThrough(disk, { id: "t", root: "/srv/repo", path: "link", salt: "s" }, false);
  assert.equal(Buffer.from(read.entry!.content_base64, "base64").toString("utf8"), "the file in the root");
});

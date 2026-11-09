import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getWith, putWith, type TreeSftp } from "./tree-copy.ts";

/** A "PC" whose SFTP paths are a folder here: "/x" is `<root>/x`. */
const fakeSftp = (root: string, names?: (path: string) => string[] | undefined): TreeSftp => {
  const at = (path: string) => join(root, path);
  const done = (promise: Promise<unknown>, cb: (error?: Error | null) => void) => void promise.then(() => cb(), (error: Error) => cb(error));
  return {
    mkdir: (path, cb) => done(mkdir(at(path)), cb),
    fastPut: (local, remote, cb) => done(copyFile(local, at(remote)), cb),
    fastGet: (remote, local, cb) => done(copyFile(at(remote), local), cb),
    chmod: (path, mode, cb) => done(chmod(at(path), mode), cb),
    lstat: (path, cb) => void lstat(at(path)).then((info) => cb(null, info), (error: Error) => cb(error, undefined as never)),
    readdir: (path, cb) => void readdir(at(path)).then((found) => cb(null, (names?.(path) ?? found).map((filename) => ({ filename }))), (error: Error) => cb(error, [])),
  };
};

const scratch = async (run: (here: string, there: string) => Promise<void>) => {
  const here = await mkdtemp(join(tmpdir(), "tree-here-"));
  const there = await mkdtemp(join(tmpdir(), "tree-there-"));
  try {
    await run(here, there);
  } finally {
    await rm(here, { recursive: true, force: true });
    await rm(there, { recursive: true, force: true });
  }
};

test("a folder goes to another PC and back whole, and never over one already there", () => scratch(async (here, there) => {
  await mkdir(join(here, "src", "deep"), { recursive: true });
  await writeFile(join(here, "src", "a.txt"), "a");
  await writeFile(join(here, "src", "deep", "b.bin"), Buffer.from([0, 1, 2]));
  const sftp = fakeSftp(there);

  assert.deepEqual(await putWith(sftp, join(here, "src"), "/src"), []);
  assert.equal(await readFile(join(there, "src", "a.txt"), "utf8"), "a");
  assert.deepEqual([...await readFile(join(there, "src", "deep", "b.bin"))], [0, 1, 2]);
  await assert.rejects(putWith(sftp, join(here, "src"), "/src"), "a folder already there is refused");

  assert.deepEqual(await getWith(sftp, "/src", join(here, "back")), []);
  assert.equal(await readFile(join(here, "back", "deep", "b.bin"), "hex"), "000102");
  await assert.rejects(getWith(sftp, "/src", join(here, "back")));

  await putWith(sftp, join(here, "src", "a.txt"), "/one.txt");
  await getWith(sftp, "/one.txt", join(here, "one.txt"));
  assert.equal(await readFile(join(here, "one.txt"), "utf8"), "a");
}));

test("a name from the other PC that is a path here stops the copy", () => scratch(async (here, there) => {
  await mkdir(join(there, "src"));
  await writeFile(join(there, "src", "x"), "x");
  const sftp = fakeSftp(there, (path) => (path === "/src" ? ["..\\..\\x"] : undefined));
  await assert.rejects(getWith(sftp, "/src", join(here, "src")), /unsafe name/);
}));

test("a script stays runnable, and a link is listed as left behind", { skip: process.platform === "win32" && "chmod and links need a POSIX disk" }, () => scratch(async (here, there) => {
  await mkdir(join(here, "app"));
  await writeFile(join(here, "app", "run.sh"), "echo");
  await chmod(join(here, "app", "run.sh"), 0o755);
  await symlink("run.sh", join(here, "app", "current"));
  const skipped = await putWith(fakeSftp(there), join(here, "app"), "/app");
  assert.equal((await stat(join(there, "app", "run.sh"))).mode & 0o777, 0o755);
  assert.deepEqual(skipped, [join(here, "app", "current")]);
}));

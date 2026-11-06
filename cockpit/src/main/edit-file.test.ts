import { test } from "node:test";
import assert from "node:assert/strict";
import { lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { localStore, openForEdit, saveEdited, withRemoteStore, type FileStat, type FileStore } from "./edit-file.ts";

/** An in-memory store; `refuseReplace` stands in for a server without atomic rename. */
function memoryStore(files: Record<string, Buffer>, options: { symlinks?: string[]; refuseReplace?: boolean } = {}) {
  const modes: Record<string, number> = {};
  const calls: string[] = [];
  const store: FileStore = {
    async lstat(path): Promise<FileStat | undefined> {
      if (options.symlinks?.includes(path)) return { isSymlink: true, isFile: false, size: 0, mode: 0o777 };
      const data = files[path];
      return data ? { isSymlink: false, isFile: true, size: data.length, mode: 0o100000 | (modes[path] ?? 0o755) } : undefined;
    },
    async read(path) { return files[path]!; },
    async create(path, data, mode) {
      calls.push(`create ${path}`);
      if (files[path]) throw new Error("exists");
      files[path] = data;
      modes[path] = mode;
    },
    async replace(from, to) {
      calls.push(`replace ${from} -> ${to}`);
      if (options.refuseReplace) throw new Error("Server does not support this extended request");
      files[to] = files[from]!;
      modes[to] = modes[from]!;
      delete files[from];
    },
    async remove(path) { calls.push(`remove ${path}`); delete files[path]; },
    async overwrite(path, data) { calls.push(`overwrite ${path}`); files[path] = data; },
  };
  return { store, files, modes, calls };
}

const crlfBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("첫 줄\r\n둘째 줄\r\n")]);

test("a file opens as LF text, remembering its line endings and BOM", async () => {
  const { store } = memoryStore({ "/r/a.md": crlfBom });
  const opened = await openForEdit(store, "/r/a.md");
  assert.ok(opened.ok);
  assert.equal(opened.text, "첫 줄\n둘째 줄\n");
  assert.equal(opened.eol, "\r\n");
  assert.equal(opened.bom, true);
});

test("what cannot be edited safely is refused, saying why", async () => {
  const { store } = memoryStore({
    "/r/cp949.txt": Buffer.from([0xc7, 0xd1, 0xb1, 0xdb]),
    "/r/bin.dat": Buffer.from([0x50, 0x4b, 0x03, 0x00, 0x14]),
    "/r/big.log": Buffer.alloc(3 * 1024 * 1024, 0x61),
  }, { symlinks: ["/r/link.md"] });
  assert.deepEqual(await openForEdit(store, "/r/cp949.txt"), { ok: false, reason: "not_text" });
  assert.deepEqual(await openForEdit(store, "/r/bin.dat"), { ok: false, reason: "not_text" });
  assert.deepEqual(await openForEdit(store, "/r/big.log"), { ok: false, reason: "too_big" });
  assert.deepEqual(await openForEdit(store, "/r/link.md"), { ok: false, reason: "symlink" });
  assert.deepEqual(await openForEdit(store, "/r/gone.md"), { ok: false, reason: "missing" });
});

test("a save writes CRLF and the BOM back, through a temp file swapped in with the same mode", async () => {
  const { store, files, modes, calls } = memoryStore({ "/r/a.md": crlfBom });
  const opened = await openForEdit(store, "/r/a.md");
  assert.ok(opened.ok);
  const saved = await saveEdited(store, "/r/a.md", { ...opened, text: "고친 줄\n둘째 줄\n" }, false);
  assert.ok(saved.ok);
  assert.deepEqual(files["/r/a.md"], Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("고친 줄\r\n둘째 줄\r\n")]));
  assert.equal(modes["/r/a.md"], 0o755, "an executable stays executable");
  assert.match(calls[0]!, /^create \/r\/\.a\.md\.lepons-[0-9a-f]+\.tmp$/, "the temp file sits beside the target");
  assert.match(calls[1]!, /^replace /);
  assert.deepEqual(Object.keys(files), ["/r/a.md"], "no temp file is left behind");
});

// The reason this exists: an agent on that machine edited the file while it
// was open here. Saving over it would silently throw its work away.
test("a file changed since it was opened is not overwritten unless asked", async () => {
  const { store, files } = memoryStore({ "/r/a.md": Buffer.from("v1\n") });
  const opened = await openForEdit(store, "/r/a.md");
  assert.ok(opened.ok);
  files["/r/a.md"] = Buffer.from("v1\nagent's line\n");
  assert.deepEqual(await saveEdited(store, "/r/a.md", { ...opened, text: "mine\n" }, false), { ok: false, reason: "changed" });
  assert.equal(files["/r/a.md"]!.toString(), "v1\nagent's line\n", "untouched");
  const forced = await saveEdited(store, "/r/a.md", { ...opened, text: "mine\n" }, true);
  assert.ok(forced.ok);
  assert.equal(files["/r/a.md"]!.toString(), "mine\n");
});

test("a deleted file is reported, and recreated only when asked", async () => {
  const { store, files } = memoryStore({ "/r/a.md": Buffer.from("v1\n") });
  const opened = await openForEdit(store, "/r/a.md");
  assert.ok(opened.ok);
  delete files["/r/a.md"];
  assert.deepEqual(await saveEdited(store, "/r/a.md", { ...opened, text: "v2\n" }, false), { ok: false, reason: "missing" });
  assert.ok((await saveEdited(store, "/r/a.md", { ...opened, text: "v2\n" }, true)).ok);
  assert.equal(files["/r/a.md"]!.toString(), "v2\n");
});

test("where a swap is not possible the file is overwritten in place, and the temp file cleaned up", async () => {
  const { store, files, calls } = memoryStore({ "/r/a.md": Buffer.from("v1\n") }, { refuseReplace: true });
  const opened = await openForEdit(store, "/r/a.md");
  assert.ok(opened.ok);
  assert.ok((await saveEdited(store, "/r/a.md", { ...opened, text: "v2\n" }, false)).ok);
  assert.equal(files["/r/a.md"]!.toString(), "v2\n");
  assert.ok(calls.some((call) => call.startsWith("remove ")), "the temp file is removed");
  assert.equal(calls.at(-1), "overwrite /r/a.md");
  assert.deepEqual(Object.keys(files), ["/r/a.md"]);
});

test("the local store does the same on a real disk", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lepons-edit-")).replace(/\\/g, "/");
  try {
    const path = `${dir}/note.md`;
    writeFileSync(path, "a\r\nb\r\n");
    const opened = await openForEdit(localStore, path);
    assert.ok(opened.ok);
    const saved = await saveEdited(localStore, path, { ...opened, text: "a\nB\n" }, false);
    assert.ok(saved.ok, JSON.stringify(saved));
    assert.equal(readFileSync(path, "utf8"), "a\r\nB\r\n");
    assert.deepEqual(readdirSync(dir), ["note.md"], "no temp file left");
    assert.ok(statSync(path).isFile() && !lstatSync(path).isSymbolicLink());
    writeFileSync(path, "someone else\n");
    assert.deepEqual(await saveEdited(localStore, path, { ...opened, text: "x\n", hash: saved.ok ? saved.hash : "" }, false), { ok: false, reason: "changed" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Over SFTP, against the fake node: what opens is what is there, a save
// lands, a change made meanwhile is refused, and with no posix-rename on the
// server the save falls back to writing in place without leaving a temp file.
test("the same over SFTP, falling back where the server cannot swap", async () => {
  const { generateHostKey, startFakeNode, fakeHome } = await import("../ssh/fake-node.ts");
  const node = await startFakeNode(generateHostKey());
  const path = `${fakeHome}/projects/notes.md`;
  node.writtenFiles.set(path, "첫 줄\r\n");
  try {
    const opened = await withRemoteStore(node.options, (store) => openForEdit(store, path));
    assert.ok(opened.ok, JSON.stringify(opened));
    assert.equal(opened.text, "첫 줄\n");
    const saved = await withRemoteStore(node.options, (store) => saveEdited(store, path, { ...opened, text: "고침\n" }, false));
    assert.ok(saved.ok, JSON.stringify(saved));
    assert.equal(node.writtenFiles.get(path), "고침\r\n");
    assert.deepEqual([...node.writtenFiles.keys()], [path], "no temp file left on the node");
    node.writtenFiles.set(path, "agent\r\n");
    const refused = await withRemoteStore(node.options, (store) => saveEdited(store, path, { ...opened, text: "x\n" }, false));
    assert.deepEqual(refused, { ok: false, reason: "changed" });
    assert.deepEqual(node.execCommands, [], "no shell command carries the contents");
  } finally {
    await node.close();
  }
});

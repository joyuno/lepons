import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test, type TestContext } from "node:test";

import { ExecutorCheckError } from "../agent/delegate.ts";
import { findGitBash } from "../main/allow-ssh.ts";
import { openForEdit, saveEdited } from "../main/edit-file.ts";
import { scratchDir } from "../scratch-dir.ts";
import type { NodeConfig } from "../shared/ipc.ts";
import { inLoginShell, runRemote, runRemoteStatus } from "../ssh/capabilities.ts";
import { generateHostKey, startFakeNode, type FakeNode } from "../ssh/fake-node.ts";
import { localMachine, machineFor, sharedReads, type Machine, type MachineReach } from "./machine.ts";

// The SSH adapter's scripts are POSIX: they need a shell here to run on. CI has
// bash; a Windows PC has it with Git. Without one this adapter's cases are skipped.
const shell = process.platform === "win32" ? findGitBash() : "bash";

const slashes = (path: string) => path.replaceAll("\\", "/");

const trashed: string[] = [];
const trash = async (path: string) => {
  trashed.push(slashes(path));
  rmSync(path, { recursive: true });
};

/** A fresh folder with the same tree for every case; `path` names a thing in it as a machine does. */
function tree(home: string) {
  const root = slashes(scratchDir(`${home}-`));
  const path = (relative: string) => `${root}/${relative}`;
  mkdirSync(path("docs"));
  mkdirSync(path("node_modules"));
  writeFileSync(path("note.md"), "hello 한글\n");
  writeFileSync(path("code.ts"), "const a = 1;\n");
  writeFileSync(path("docs/deep.md"), "deep\n");
  writeFileSync(path("node_modules/skip.md"), "skip\n");
  return { root, path };
}

const sshNode = { kind: "ssh", id: "pc", label: "pc", agent: "claude", home: "", destination: "me@pc", useTmux: false, repos: [] } as NodeConfig;

const adapters: Array<{
  name: string;
  skip: boolean;
  start(): Promise<{ machine: Machine; connect?: FakeNode["options"]; home: string; stop(): Promise<void> }>;
}> = [
  {
    name: "this PC",
    skip: false,
    start: async () => ({ machine: localMachine(trash), home: homedir(), stop: async () => {} }),
  },
  {
    name: "over SSH",
    skip: shell === undefined,
    start: async () => {
      // A space on purpose: an account's name can hold one, on a Windows PC above all.
      // Real path: macOS reaches its temp folder through /var -> /private/var, and the node reports the resolved one.
      const home = slashes(realpathSync(scratchDir("machine home-")));
      const node = await startFakeNode(generateHostKey(), { home, shell: shell! });
      const reach: MachineReach = {
        ensureKeyReady: async () => ({ ok: true }),
        sshOptions: () => node.options,
        runRemote,
        runRemoteStatus,
        trash,
        probePool: { run: async () => undefined },
        probeCache: new Map(),
      };
      return { machine: machineFor({ ...sshNode, home } as NodeConfig, reach), connect: node.options, home, stop: () => node.close() };
    },
  },
];

/** A link where the machine allows one: a junction for a folder needs no privilege on Windows, a file link does. */
function link(t: TestContext, target: string, path: string, kind: "file" | "junction"): boolean {
  try {
    symlinkSync(target, path, kind);
    return true;
  } catch {
    t.skip("no symlink privilege on this machine");
    return false;
  }
}

for (const adapter of adapters) {
  describe(`machine contract: ${adapter.name}`, { skip: adapter.skip }, () => {
    const isSsh = adapter.name === "over SSH";
    let machine: Machine;
    let connect: FakeNode["options"] | undefined;
    let home: string;
    let stop: () => Promise<void>;
    before(async () => {
      ({ machine, connect, home, stop } = await adapter.start());
    });
    after(() => stop());

    // ---- run ----------------------------------------------------------------

    test("a command says what it printed, on either stream, and how it ended", async () => {
      const ran = (await machine.run("echo hello"))!;
      assert.equal(ran.code, 0);
      assert.equal(ran.output.trim(), "hello");
      assert.equal(ran.timedOut, undefined);
      assert.equal((await machine.run("echo oops 1>&2"))!.output.trim(), "oops");
      assert.equal((await machine.run("exit 3"))!.code, 3);
    });

    test("a command that will not end is given up on and says so", async () => {
      const node = process.execPath.replaceAll("\\", "/");
      const ran = (await machine.run(`"${node}" -e "setTimeout(() => {}, 1500)"`, { timeoutMs: 100 }))!;
      assert.equal(ran.timedOut, true);
      assert.notEqual(ran.code, 0);
    });

    test("a path reads as the machine's own tools spell it", () => {
      assert.equal(machine.nativePath("a/b"), isSsh || process.platform !== "win32" ? "a/b" : "a\\b");
    });

    // ---- agent records --------------------------------------------------------

    // Only over SSH: on this PC it reads the real home (workflow/turn.test.ts covers its parts).
    test("an agent's record: the newest one's end and the machine's clock, empty when it keeps none", { skip: !isSsh }, async () => {
      const before = Date.now();
      const none = (await machine.recordTail("claude", "/no/such/folder"))!;
      assert.equal(none.tail, "");
      assert.ok(Math.abs(none.now - before) < 60_000);
      assert.equal((await machine.recordTail("codex", "/no/such/folder"))!.tail, "");

      const dir = join(home, ".claude", "projects", "-work-repo");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "only.jsonl"), `${"x".repeat(600_000)}\nlast line 한글\n`);
      const { tail } = (await machine.recordTail("claude", "/work/repo"))!;
      assert.ok(tail.endsWith("\nlast line 한글\n"));
      assert.ok(Buffer.byteLength(tail) === 500_000);

      const rollouts = join(home, ".codex", "sessions", "2026", "11", "03");
      mkdirSync(rollouts, { recursive: true });
      const rollout = `${JSON.stringify({ type: "session_meta", payload: { cwd: "/work/repo" } })}\n`;
      writeFileSync(join(rollouts, "rollout-a.jsonl"), rollout);
      assert.equal((await machine.recordTail("codex", "/work/repo"))!.tail, rollout);
      // A subagent's rollout shares the folder and is newer: it is not the session.
      writeFileSync(join(rollouts, "rollout-b.jsonl"), `${JSON.stringify({ type: "session_meta", payload: { cwd: "/work/repo", source: { subagent: { thread_spawn: {} } } } })}\n`);
      utimesSync(join(rollouts, "rollout-b.jsonl"), new Date(), new Date(Date.now() + 60_000));
      assert.equal((await machine.recordTail("codex", "/work/repo"))!.tail, rollout);
    });

    test("a record's stamp holds until the record moves", { skip: !isSsh }, async () => {
      assert.equal(await machine.recordStamp("codex", "/no/such/stamp"), undefined);
      const dir = join(home, ".claude", "projects", "-work-stamp");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "only.jsonl"), "one\n");
      const stamp = await machine.recordStamp("claude", "/work/stamp");
      assert.ok(stamp);
      assert.equal(await machine.recordStamp("claude", "/work/stamp"), stamp);
      writeFileSync(join(dir, "only.jsonl"), "one\ntwo\n");
      assert.notEqual(await machine.recordStamp("claude", "/work/stamp"), stamp);
    });

    test("an agent's whole record, and what it has talked about in a folder", { skip: !isSsh }, async () => {
      assert.equal(await machine.record("claude", "/no/such/folder"), undefined);
      assert.equal((await machine.record("codex", "/no/such/folder")) ?? "", "");
      assert.deepEqual(await machine.past("/no/such/folder", "x"), []);

      const id = "11111111-2222-3333-4444-555555555555";
      const dir = join(home, ".claude", "projects", "-work-past");
      mkdirSync(dir, { recursive: true });
      const line = `${JSON.stringify({ type: "custom-title", customTitle: "그 일" })}\n`;
      writeFileSync(join(dir, `${id}.jsonl`), line);
      assert.equal(await machine.record("claude", "/work/past"), line);
      assert.deepEqual((await machine.past("/work/past", "x"))!.map((entry) => [entry.agent, entry.id, entry.title]), [["claude", id, "그 일"]]);
    });

    // ---- list ---------------------------------------------------------------

    test("a listing puts folders first and says which folder it is", async () => {
      const { root, path } = tree("machine-list");
      const result = await machine.list(root);
      assert.ok(result.ok);
      assert.equal(slashes(result.path), root);
      assert.deepEqual(result.entries.map((entry) => [entry.name, entry.isDirectory]), [
        ["docs", true], ["node_modules", true], ["code.ts", false], ["note.md", false],
      ]);
      assert.equal((await machine.list(path("absent"))).ok, false);
    });

    test("an empty path lists the account's home; a missing folder is not an empty one", async () => {
      const result = await machine.list("");
      assert.ok(result.ok);
      assert.equal(slashes(result.path), slashes(home));
      const { path } = tree("machine-list");
      const absent = await machine.list(path("absent"));
      assert.ok(!absent.ok);
      assert.equal(absent.reason, "listing_failed");
    });

    test("a phone's folder listing names what is there, with no link and nothing out of the folder", async (t) => {
      const { root, path } = tree("machine-inside");
      const entries = (await machine.listInside(root, ""))!;
      assert.deepEqual(entries.map((entry) => [entry.name, entry.directory]).sort(), [
        ["code.ts", false], ["docs", true], ["node_modules", true], ["note.md", false],
      ]);
      assert.deepEqual(await machine.listInside(root, "docs"), [{ name: "deep.md", directory: false }]);
      assert.equal(await machine.listInside(root, "absent"), undefined);
      for (const bad of ["..", "../..", "docs/../..", "/etc", "docs\\deep"]) assert.equal(await machine.listInside(root, bad), undefined, bad);
      // A shell's `cd` reads these as "the folder before" and "the home folder".
      for (const bad of ["-", "-L", "-P", "docs/-"]) assert.equal(await machine.listInside(root, bad), undefined, bad);

      const outside = tree("machine-outside");
      if (!link(t, outside.root, path("out"), "junction")) return;
      assert.equal(await machine.listInside(root, "out"), undefined);
      assert.ok(!(await machine.listInside(root, ""))!.some((entry) => entry.name === "out"));
    });

    test("what a phone can open, and every file: dependency folders skipped, links not walked", async (t) => {
      const { root, path } = tree("machine-find");
      const outside = tree("machine-outside");
      if (!link(t, outside.root, path("out"), "junction")) return;
      assert.deepEqual((await machine.viewableFiles(root)).sort(), ["docs/deep.md", "note.md"]);
      assert.deepEqual((await machine.allFiles(root)).sort(), ["code.ts", "docs/deep.md", "note.md"]);
    });

    test("a listing cut at its size limit names only whole files", async () => {
      const { path, root } = tree("machine-find");
      mkdirSync(path("long"));
      for (let i = 0; i < 3000; i++) writeFileSync(path(`long/${String(i).padStart(4, "0")}${"x".repeat(125)}.md`), "");
      const long = (await machine.allFiles(root)).filter((file) => file.startsWith("long/"));
      assert.ok(long.length > 2000);
      assert.deepEqual(long.filter((file) => file.length !== 137), []);
    });

    test("slash commands and skills are found the same way", async () => {
      const { path } = tree("machine-commands");
      mkdirSync(path("commands"));
      mkdirSync(path("skills/tidy"), { recursive: true });
      writeFileSync(path("commands/ship.md"), "---\ndescription: Ship it\n---\nbody");
      writeFileSync(path("commands/skip.txt"), "not a command");
      writeFileSync(path("skills/tidy/SKILL.md"), "---\nname: tidy\ndescription: Tidy up\n---\n");
      const found = await machine.customCommands([{ kind: "commands", dir: path("commands") }, { kind: "skills", dir: path("skills") }, { kind: "commands", dir: path("absent") }]);
      assert.deepEqual(found.map((command) => [command.name, command.description]).sort(), [
        ["/ship", "Ship it"], ["/tidy", "Tidy up"],
      ]);
    });

    test("a folder's manifests come back by name, absent ones left out", async () => {
      const { root, path } = tree("machine-manifests");
      writeFileSync(path("go.mod"), "module x\n");
      const manifests = (await machine.manifests(root))!;
      assert.deepEqual(Object.keys(manifests), ["go.mod"]);
      assert.equal(manifests["go.mod"]!.trim(), "module x");
    });

    // ---- read ---------------------------------------------------------------

    test("a read returns the file's exact bytes, up to the limit", async () => {
      const { path } = tree("machine-read");
      const bytes = Buffer.from([0, 1, 2, 250, 255, 10, 13, 0]);
      writeFileSync(path("blob.bin"), bytes);
      assert.deepEqual(await machine.read(path("blob.bin"), 8), bytes);
      assert.equal(await machine.read(path("blob.bin"), 7), undefined);
      assert.equal(await machine.read(path("absent"), 100), undefined);
      assert.equal(await machine.read(path("docs"), 100), undefined);
    });

    // A known difference, kept as it was: a remote read learns of an empty file
    // only from its empty output. Fixing it changes what a preview shows there.
    test("an empty file reads as empty here and as gone over SSH", async () => {
      const { path } = tree("machine-read");
      writeFileSync(path("empty"), "");
      const read = await machine.read(path("empty"), 100);
      if (isSsh) assert.equal(read, undefined);
      else assert.equal(read?.length, 0);
    });

    test("a read inside a folder takes files only, within the limit", async () => {
      const { root, path } = tree("machine-inside");
      assert.equal((await machine.readInside(root, "docs/deep.md", 100))?.toString(), "deep\n");
      assert.equal((await machine.readInside(`${root}/`, "docs/deep.md", 100))?.toString(), "deep\n");
      assert.equal(await machine.readInside(root, "docs/deep.md", 2), undefined);
      assert.equal(await machine.readInside(root, "absent.md", 100), undefined);
      assert.equal(await machine.readInside(root, "docs", 100), undefined);
      for (const bad of ["", ".", "..", "../note.md", "docs/../note.md", "./note.md", "docs//deep.md", "docs\\deep.md", "/etc/hostname"]) {
        assert.equal(await machine.readInside(root, bad, 100), undefined, bad);
      }
      truncateSync(path("note.md"), 0);
      // The size test passes, base64 prints nothing: empty, not refused.
      assert.equal((await machine.readInside(root, "note.md", 100))?.length, 0);
    });

    test("a folder swapped for a link is not walked through", async (t) => {
      const { root, path } = tree("machine-inside");
      const outside = tree("machine-outside");
      writeFileSync(outside.path("secret.md"), "secret");
      renameSync(path("docs"), path("docs-moved"));
      if (!link(t, outside.root, path("docs"), "junction")) return;
      assert.equal(await machine.readInside(root, "docs/secret.md", 100), undefined);
    });

    test("a file swapped for a link is not followed", async (t) => {
      const { root, path } = tree("machine-inside");
      const outside = tree("machine-outside");
      writeFileSync(outside.path("secret.md"), "secret");
      rmSync(path("note.md"));
      if (!link(t, outside.path("secret.md"), path("note.md"), "file")) return;
      assert.equal(await machine.readInside(root, "note.md", 100), undefined);
    });

    test("text to change: absent is told apart from unreadable", async () => {
      const { path } = tree("machine-text");
      assert.deepEqual(await machine.readText(path("note.md")), { ok: true, contents: "hello 한글\n" });
      assert.deepEqual(await machine.readText(path("absent.json")), { ok: true, contents: undefined });
      assert.equal((await machine.readText(path("docs"))).ok, false);
    });

    test("a copy lands on this PC; a missing file says why", async () => {
      const { path } = tree("machine-copy");
      const target = join(scratchDir("machine-copy-to-"), "copy.md");
      assert.equal(await machine.saveCopy(path("note.md"), target), undefined);
      assert.equal(readFileSync(target, "utf8"), "hello 한글\n");
      assert.equal(typeof await machine.saveCopy(path("absent"), target), "string");
    });

    // ---- write --------------------------------------------------------------

    test("a new file lands whole, for its owner only, and never over an old one", async () => {
      const { path } = tree("machine-create");
      assert.deepEqual(await machine.create(path(".env"), "SECRET=1\n"), { ok: true });
      assert.equal(readFileSync(path(".env"), "utf8"), "SECRET=1\n");
      // Windows carries no POSIX mode bits, and the fake node sets none on its disk.
      if (!isSsh && process.platform !== "win32") assert.equal(statSync(path(".env")).mode & 0o777, 0o600);

      const again = await machine.create(path(".env"), "NEW=1\n");
      assert.ok(!again.ok);
      assert.equal(again.reason, "exists");
      assert.equal(readFileSync(path(".env"), "utf8"), "SECRET=1\n");

      assert.deepEqual(await machine.create(path("shot.png"), Buffer.from([137, 80, 0, 255])), { ok: true });
      assert.deepEqual(readFileSync(path("shot.png")), Buffer.from([137, 80, 0, 255]));
      assert.equal((await machine.create(path("absent/file"), "x")).ok, false);
    });

    test("overwriting replaces or creates", async () => {
      const { path } = tree("machine-overwrite");
      assert.deepEqual(await machine.overwrite(path("note.md"), "new"), { ok: true });
      assert.equal(readFileSync(path("note.md"), "utf8"), "new");
      assert.deepEqual(await machine.overwrite(path("fresh.json"), "{}"), { ok: true });
      assert.equal(readFileSync(path("fresh.json"), "utf8"), "{}");
      assert.equal((await machine.overwrite(path("absent/file"), "x")).ok, false);
    });

    test("folders: parents made on request; one already there is reported", async () => {
      const { path } = tree("machine-folders");
      await machine.makeDirs(path("a/b/c"));
      await machine.makeDirs(path("a/b/c"));
      assert.ok(statSync(path("a/b/c")).isDirectory());
      assert.deepEqual(await machine.makeFolder(path("fresh")), { ok: true });
      assert.ok(statSync(path("fresh")).isDirectory());
      const again = await machine.makeFolder(path("fresh"));
      assert.ok(!again.ok);
      assert.equal(again.reason, "failed");
      assert.ok(again.detail);
    });

    test("copy and move take whole folders and never a taken name", async () => {
      const { path } = tree("machine-transfer");
      assert.deepEqual(await machine.transfer(path("docs"), path("docs2"), false), { ok: true });
      assert.equal(readFileSync(path("docs2/deep.md"), "utf8"), "deep\n");
      assert.ok(existsSync(path("docs/deep.md")));
      assert.deepEqual(await machine.transfer(path("docs2"), path("docs3"), true), { ok: true });
      assert.ok(!existsSync(path("docs2")));
      assert.equal(readFileSync(path("docs3/deep.md"), "utf8"), "deep\n");

      assert.deepEqual(await machine.transfer(path("code.ts"), path("note.md"), true), { ok: false, reason: "name_taken" });
      assert.deepEqual(await machine.transfer(path("code.ts"), path("note.md"), false), { ok: false, reason: "name_taken" });
      assert.equal(readFileSync(path("note.md"), "utf8"), "hello 한글\n");
      assert.ok(existsSync(path("code.ts")));

      const missing = await machine.transfer(path("absent"), path("elsewhere"), false);
      assert.ok(!missing.ok);
      assert.equal(missing.reason, "failed");
      assert.ok(missing.detail);
    });

    test("a dangling link is a name taken too", async (t) => {
      const { path } = tree("machine-transfer");
      const gone = tree("machine-gone");
      rmSync(gone.root, { recursive: true });
      if (!link(t, gone.root, path("dangling"), "junction")) return;
      assert.deepEqual(await machine.transfer(path("code.ts"), path("dangling"), false), { ok: false, reason: "name_taken" });
    });

    test("removing takes a file or a whole folder", async () => {
      const { path } = tree("machine-remove");
      assert.deepEqual(await machine.remove(path("note.md")), { ok: true });
      assert.ok(!existsSync(path("note.md")));
      assert.deepEqual(await machine.remove(path("docs")), { ok: true });
      assert.ok(!existsSync(path("docs")));
      // Here it went to the Trash, where it can come back from; there is none over SSH.
      assert.equal(trashed.includes(path("docs")), !isSsh);
    });

    test("a secret is ignored in a git repository and left alone outside one", async () => {
      const plain = tree("machine-protect");
      assert.deepEqual(await machine.protect(plain.root, ".env"), { gitRepo: false, ignored: false, tracked: false });
      assert.ok(!existsSync(plain.path(".gitignore")));

      const repo = tree("machine-protect");
      execFileSync("git", ["init", "-q"], { cwd: repo.root });
      writeFileSync(repo.path(".env"), "SECRET=1\n");
      assert.deepEqual(await machine.protect(repo.root, ".env"), { gitRepo: true, ignored: true, tracked: false });
      assert.equal(readFileSync(repo.path(".gitignore"), "utf8").trim(), ".env");
    });

    test("an edit in place opens and saves through the machine's own disk", async () => {
      const { path } = tree("machine-edit");
      const result = await machine.withFiles(async (store) => {
        const opened = await openForEdit(store, path("note.md"));
        assert.ok(opened.ok);
        const stale = await saveEdited(store, path("note.md"), { text: "stale", hash: "not this file", eol: opened.eol, bom: opened.bom }, false);
        assert.deepEqual(stale, { ok: false, reason: "changed" });
        return saveEdited(store, path("note.md"), { text: "edited\n", hash: opened.hash, eol: opened.eol, bom: opened.bom }, false);
      });
      assert.ok(result.ok);
      assert.equal(readFileSync(path("note.md"), "utf8"), "edited\n");
    });

    // ---- what a share hands out ----------------------------------------------

    const share = (root: string, path: string) => sharedReads(connect).read({ id: "t", root, path, salt: "s" });

    test("a shared read is exact and hashed, and masks a secret before it leaves", async () => {
      const { root, path } = tree("machine-share");
      writeFileSync(path(".env"), "API_KEY=abcdef123456\n");
      const exact = await share(root, "note.md");
      assert.equal(exact.entry?.fidelity, "exact");
      assert.equal(Buffer.from(exact.entry!.content_base64, "base64").toString(), "hello 한글\n");
      assert.equal(exact.entry!.as_of.content_hash, createHash("sha256").update("hello 한글\n").digest("hex"));

      const masked = await share(root, ".env");
      assert.equal(masked.entry?.fidelity, "masked");
      assert.ok(!Buffer.from(masked.entry!.content_base64, "base64").toString().includes("abcdef123456"));
    });

    test("a shared read refuses a path out of the root and reports a missing or oversized file", async () => {
      const { root, path } = tree("machine-share");
      assert.equal((await share(root, "../outside.md")).error?.code, "invalid_path");
      assert.equal((await share(root, "absent.md")).error?.code, "read_failed");
      assert.equal((await share(root, "docs")).error?.code, "read_failed");
      writeFileSync(path("big"), "");
      truncateSync(path("big"), 11 * 1024 * 1024);
      assert.equal((await share(root, "big")).error?.code, "read_failed");
    });

    test("a shared read returns no bytes through a link that leaves the root", async (t) => {
      const { root, path } = tree("machine-share");
      const outside = tree("machine-outside");
      writeFileSync(outside.path("secret.md"), "secret");
      if (!link(t, outside.root, path("out"), "junction")) return;
      const response = await share(root, "out/secret.md");
      assert.equal(response.entry?.content_base64 ?? "", "");
    });

    // Known differences, kept as they were; pinned so a change to either is a decision.
    test("a link to a folder is offered as a folder here and as a file over SSH", async (t) => {
      const { root, path } = tree("machine-list");
      if (!link(t, path("docs"), path("alias"), "junction")) return;
      const result = await machine.list(root);
      assert.ok(result.ok);
      assert.equal(result.entries.find((entry) => entry.name === "alias")?.isDirectory, !isSsh);
    });

    test("a shared read names a link here and resolves it over SSH", async (t) => {
      const { root, path } = tree("machine-share");
      if (!link(t, path("docs"), path("alias"), "junction")) return;
      const response = await share(root, "alias");
      if (isSsh) assert.equal(response.error?.code, "read_failed");
      else assert.equal(response.entry?.kind, "symlink");
    });

    test("a shared search finds a line and masks a secret's", async () => {
      const { root, path } = tree("machine-share");
      writeFileSync(path(".env"), "API_KEY=abcdef123456\n");
      const found = await sharedReads(connect).grep({ root, pattern: "deep", salt: "s" });
      assert.ok(found.ok);
      assert.deepEqual(found.matches.map((match) => [match.path, match.text]), [["docs/deep.md", "deep"]]);
      const secret = await sharedReads(connect).grep({ root, pattern: "API_KEY", salt: "s" });
      assert.ok(secret.ok);
      assert.ok(secret.matches.every((match) => !match.text.includes("abcdef123456")));
    });

    test("a shared search is not led out of the root by a link", async (t) => {
      const { root, path } = tree("machine-share");
      const outside = tree("machine-outside");
      writeFileSync(outside.path("secret.md"), "secret");
      if (!link(t, outside.root, path("out"), "junction")) return;
      assert.deepEqual(await sharedReads(connect).grep({ root, pattern: "secret", salt: "s", subPath: "out" }), { ok: false, reason: "invalid_path", detail: "path is invalid" });
      const everything = await sharedReads(connect).grep({ root, pattern: "secret", salt: "s" });
      assert.ok(everything.ok);
      assert.deepEqual(everything.matches, []);
    });

    // A known difference, kept as it was; the one rule both hold is the root above.
    test("a search through a link that stays in the root goes on here and is refused over SSH", async (t) => {
      const { root, path } = tree("machine-share");
      if (!link(t, path("docs"), path("alias"), "junction")) return;
      const found = await sharedReads(connect).grep({ root, pattern: "deep", salt: "s", subPath: "alias" });
      assert.equal(found.ok, !isSsh);
    });
  });
}

// ---- only over SSH: a machine that cannot be asked ----------------------------

const unreachable: MachineReach = {
  ensureKeyReady: async () => ({ ok: true }),
  sshOptions: () => { throw new Error("never asked"); },
  runRemote: async () => undefined,
  runRemoteStatus: async () => undefined,
  trash,
  probePool: { run: async () => undefined },
  probeCache: new Map(),
};

test("a locked key stops what checks it first, before the node is asked", async () => {
  const asked: string[] = [];
  const machine = machineFor(sshNode, {
    ...unreachable,
    ensureKeyReady: async () => ({ ok: false, reason: "locked" }),
    runRemote: async (_options, script) => { asked.push(script); return undefined; },
    runRemoteStatus: async (_options, script) => { asked.push(script); return undefined; },
  });
  assert.deepEqual(await machine.list("/x"), { ok: false, reason: "auth_failed", detail: "locked" });
  assert.equal(await machine.listInside("/x", ""), undefined);
  assert.deepEqual(await machine.viewableFiles("/x"), []);
  assert.deepEqual(await machine.allFiles("/x"), []);
  assert.deepEqual(await machine.customCommands([{ kind: "commands", dir: "/x" }]), []);
  assert.equal(await machine.manifests("/x"), undefined);
  assert.equal(await machine.saveCopy("/x", "/y"), "locked");
  assert.deepEqual(await machine.transfer("/x", "/y", true), { ok: false, reason: "failed", detail: "locked" });
  assert.deepEqual(await machine.remove("/x"), { ok: false, reason: "failed", detail: "locked" });
  assert.deepEqual(await machine.withFiles(async () => "ran"), { ok: false, reason: "unreachable", detail: "locked" });
  assert.deepEqual(asked, []);
});

test("a file it may not read is not bytes: a read takes the shell's word for how it ended", async () => {
  const said = "bash: line 1: /x: Permission denied\n";
  const machine = machineFor(sshNode, { ...unreachable, sshOptions: () => ({}) as never, runRemote: async () => said, runRemoteStatus: async () => ({ code: 1, output: said }) });
  assert.equal(await machine.read("/x", 100), undefined);
});

test("a command over SSH goes through the login shell on request, and a dead node is undefined", async () => {
  const asked: Array<[string, number | undefined]> = [];
  const machine = machineFor(sshNode, {
    ...unreachable,
    sshOptions: () => ({}) as never,
    runRemoteStatus: async (_options, command, timeoutMs) => { asked.push([command, timeoutMs]); return undefined; },
  });
  assert.equal(await machine.run("tmux ls"), undefined);
  await machine.run("tmux ls", { login: true, timeoutMs: 8000 });
  assert.deepEqual(asked, [["tmux ls", undefined], [inLoginShell("tmux ls"), 8000]]);
});

test("an agent is asked for on the machine's own connection, and a key that no longer reads is a failure", async () => {
  const broken = machineFor(sshNode, unreachable);
  await assert.rejects(broken.checkAgent("codex"), /never asked/);
  await assert.rejects(broken.delegate("claude", "/work", "tidy up", {}), /never asked/);

  // Nothing listens on this port, so reaching the node's connection is what fails.
  const fake = await startFakeNode(generateHostKey());
  const gone = fake.options;
  await fake.close();
  const dead = machineFor(sshNode, { ...unreachable, sshOptions: () => gone });
  await assert.rejects(dead.checkAgent("codex"), (error) => error instanceof ExecutorCheckError && error.reason === "unreachable");
  await assert.rejects(dead.delegate("claude", "/work", "tidy up", {}), /./);
});

test("a record is read on the open connection first, and only a one-shot read if that says nothing", async () => {
  const pooled: string[] = [];
  const oneShot: string[] = [];
  let open = false;
  const machine = machineFor({ ...sshNode, home: "/home/me" } as NodeConfig, {
    ...unreachable,
    sshOptions: () => ({}) as never,
    probePool: { run: async (_id, _options, command) => { pooled.push(command); return open ? "over the pool" : undefined; } },
    runRemote: async (_options, command) => { oneShot.push(command); return "one shot"; },
  });
  assert.equal(await machine.record("codex", "/work"), "one shot");
  assert.deepEqual(oneShot, pooled);
  open = true;
  assert.equal(await machine.record("codex", "/work"), "over the pool");
  assert.equal(oneShot.length, 1);
  // Without a home there is nowhere to look for Claude's.
  assert.equal(await machineFor(sshNode, unreachable).record("claude", "/work"), undefined);
  // Nor is a PC that does not answer a folder with no past.
  assert.equal(await machineFor(sshNode, { ...unreachable, sshOptions: () => ({}) as never }).past("/work", "x"), null);
});

test("Codex on a Windows PC is looked up by the cwd it wrote, in backslashes", async () => {
  const asked: string[] = [];
  const machine = machineFor({ ...sshNode, windows: true } as NodeConfig, {
    ...unreachable,
    sshOptions: () => ({}) as never,
    runRemote: async (_options, command) => { asked.push(command); return ""; },
  });
  const slashes = /C:\\\\Users\\\\me/;
  await machine.record("codex", "C:/Users/me");
  assert.match(asked.at(-1)!, slashes);
  await machine.recordTail("codex", "C:/Users/me");
  assert.match(asked.at(-1)!, slashes);
  await machine.past("C:/Users/me", "x");
  assert.ok(asked.some((command) => command.includes("session_index") && slashes.test(command)));
  await machine.recordTail("claude", "C:/Users/me");
  assert.doesNotMatch(asked.at(-1)!, slashes);
});

test("an agent's file over SSH is under the account's home, once its agent is found", async () => {
  const asked: string[] = [];
  let code = 0;
  const machine = machineFor(sshNode, {
    ...unreachable,
    sshOptions: () => ({}) as never,
    runRemoteStatus: async (_options, command) => { asked.push(command); return { code, output: "" }; },
  });
  assert.equal(await machine.agentFile("agy", ".gemini/antigravity/settings.json"), ".gemini/antigravity/settings.json");
  assert.ok(asked[0]!.includes("command -v agy"));
  assert.ok(asked[0]!.includes(".gemini/antigravity"));
  code = 1;
  assert.equal(await machine.agentFile("agy", ".gemini/antigravity/settings.json"), undefined);
});

test("an SSH PC's accounts say unknown when it cannot be asked, not missing", async () => {
  const accounts = await machineFor(sshNode, { ...unreachable, sshOptions: () => ({}) as never }).agentAccounts();
  assert.ok(accounts.length > 0 && accounts.every((account) => account.unknown === true));
});

test("a connection is worked out when asked for, not when the machine is made", () => {
  // A PC with no key must not stop the app listing its folders at start.
  const broken = machineFor(sshNode, unreachable);
  assert.throws(() => broken.connection(), /never asked/);
  assert.equal(localMachine(trash).connection(), undefined);
});

test("ready asks for the key over SSH, and this PC has none to ask for", async () => {
  const machine = machineFor(sshNode, { ...unreachable, ensureKeyReady: async () => ({ ok: false, reason: "locked" }) });
  assert.deepEqual(await machine.ready(), { ok: false, reason: "locked" });
  assert.deepEqual(await localMachine(trash).ready(), { ok: true });
});

test("a node that does not answer is not mistaken for an empty one, or a refusal", async () => {
  const machine = machineFor({ ...sshNode }, { ...unreachable, sshOptions: () => ({}) as never });
  assert.equal(await machine.read("/x", 100), undefined);
  assert.equal(await machine.readInside("/r", "x", 100), undefined);
  assert.equal(await machine.listInside("/x", ""), undefined);
  assert.deepEqual(await machine.makeFolder("/x"), { ok: false, reason: "unreachable" });
  assert.deepEqual(await machine.transfer("/x", "/y", false), { ok: false, reason: "unreachable" });
  assert.deepEqual(await machine.remove("/x"), { ok: false, reason: "unreachable" });
});

test("a local machine goes to the Trash it was given, and says when that fails", async () => {
  const machine = machineFor({ kind: "local", id: "here", label: "here", agent: "claude", home: "", repos: [] } as NodeConfig, {
    ...unreachable,
    trash: async () => { throw new Error("bin is full"); },
  });
  assert.deepEqual(await machine.remove("/x"), { ok: false, reason: "failed", detail: "bin is full" });
});

test("a PC over SSH answers for its tmux sessions in one command, and silence says nobody is gone", async () => {
  const asked: string[] = [];
  let reply: { code: number; output: string } | undefined = { code: 0, output: "lepons-a 0\n@tmux 0\n" };
  let limit: number | undefined;
  const machine = machineFor({ ...sshNode, useTmux: true } as NodeConfig, {
    ...unreachable,
    sshOptions: () => ({}) as never,
    runRemoteStatus: async (_options, command, timeoutMs) => { asked.push(command); limit = timeoutMs; return reply; },
  });
  const probes = [{ key: "a", tmux: "lepons-a" }, { key: "b", tmux: "lepons-b" }];
  assert.deepEqual(await machine.agentsGone(probes), ["b"]);
  assert.equal(asked.length, 1);
  assert.ok(asked[0]!.includes("list-panes -a"));
  assert.ok(limit !== undefined, "an rc file that never ends must not hold up every later look");
  reply = undefined;
  assert.deepEqual(await machine.agentsGone(probes), []);
});

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { Machine } from "../machine/machine.ts";
import { outsidePlaces, outsideSecret, printedIn, readOutside } from "./outside.ts";

test("where a printed path may be: ~ under the home, a rootless dot-folder under it too", () => {
  assert.deepEqual(outsidePlaces("~/.codex/sessions/a.jsonl", "/home/me"), ["/home/me/.codex/sessions/a.jsonl"]);
  assert.deepEqual(outsidePlaces("/.codex/config.toml", "/home/me/"), ["/.codex/config.toml", "/home/me/.codex/config.toml"]);
  assert.deepEqual(outsidePlaces("/home/me/other/README.md", "/home/me"), ["/home/me/other/README.md"]);
  assert.deepEqual(outsidePlaces("C:\\Users\\me\\x.ts", "C:\\Users\\me"), ["C:/Users/me/x.ts"]);
  assert.deepEqual(outsidePlaces("~/x.md", "C:\\Users\\me"), ["C:/Users/me/x.md"]);
  for (const bad of ["src/a.ts", "../a.ts", "/home/me/../root/a", "~/a\nb", "/", "~/"]) assert.equal(outsidePlaces(bad, "/home/me"), undefined, bad);
});

test("places that keep keys or sign-ins are refused", () => {
  for (const path of ["/home/me/.ssh/config", "C:\\Users\\me\\.aws\\config", "/home/me/.codex/auth.json", "/home/me/.claude/.credentials.json",
    "/srv/app/.env.local", "/home/me/server.key", "/home/me/id_ed25519", "/home/me/.git-credentials", "/home/me/.config/gcloud/x.json"]) {
    assert.equal(outsideSecret(path), true, path);
  }
  for (const path of ["/home/me/.codex/config.toml", "/home/me/.codex/sessions/2026/a.jsonl", "/home/me/other/README.md", "C:/Users/me/keys.md"]) {
    assert.equal(outsideSecret(path), false, path);
  }
});

test("a path counts as printed as it is or as JSON spells it", () => {
  assert.equal(printedIn(`{"text":"see ~/.codex/a.md"}`, "~/.codex/a.md"), true);
  assert.equal(printedIn(String.raw`{"text":"C:\\Users\\me\\a.md"}`, "C:\\Users\\me\\a.md"), true);
  assert.equal(printedIn(`{"text":"nothing"}`, "/etc/hosts"), false);
  assert.equal(printedIn(`{"text":"고쳤어요: /home/me/a.md."}`, "/home/me/a.md"), true, "a full stop after it");
  assert.equal(printedIn(`{"text":"\`~/.codex/a.md\`를"}`, "~/.codex/a.md"), true);
  assert.equal(printedIn(`{"text":"~/.config/x/hosts.yml.bak"}`, "~/.config/x/hosts.yml"), false, "the start of a longer path");
  assert.equal(printedIn(`{"text":"/mnt/backup/home/me/a.md"}`, "/home/me/a.md"), false, "the end of a longer path");
  assert.equal(printedIn(`{"text":"/home/me/a.md/b"}`, "/home/me/a.md"), false);
});

test("what reads as empty but is a process's environment is refused", () => {
  for (const path of ["/proc/self/environ", "/sys/kernel/x", "/home/me/.config/gh/hosts.yml", "/home/me/.claude.json", "/home/me/.bash_history"]) {
    assert.equal(outsideSecret(path), true, path);
  }
});

test("on this PC: the first place there, by its real path; a link, a folder or a big file is not read", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "lepons-outside-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const local = { connection: () => undefined } as unknown as Machine;
  await writeFile(join(dir, "a.md"), "hello");
  await mkdir(join(dir, "sub"));
  assert.deepEqual(await readOutside(local, [join(dir, "gone.md"), join(dir, "a.md")], 100), { path: join(dir, "a.md"), bytes: Buffer.from("hello") });
  assert.equal(await readOutside(local, [join(dir, "a.md")], 3), "big");
  assert.equal(await readOutside(local, [join(dir, "sub")], 100), undefined);
  assert.equal(await readOutside(local, [join(dir, "gone.md")], 100), undefined);
  const linked = await symlink(join(dir, "a.md"), join(dir, "link.md")).then(() => true, () => false);
  if (linked) assert.equal(await readOutside(local, [join(dir, "link.md")], 100), undefined);
});

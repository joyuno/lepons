import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFile, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { heldRecord, OUTPUT_MARK, type HeldText } from "./held-record.ts";

// Through a real sh, as over SSH: what is tested is the byte arithmetic of tail and head.
test("a held record grows by what was written, goes back as far as asked, and joins whole lines", async (t) => {
  try {
    execFileSync("sh", ["-c", "true"]);
  } catch {
    t.skip("no sh here");
    return;
  }
  const dir = (await mkdtemp(join(tmpdir(), "held-"))).replaceAll("\\", "/");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const scripts: string[] = [];
  const run = async (script: string) => {
    scripts.push(script);
    return execFileSync("sh", ["-c", script], { encoding: "utf8" });
  };
  // Multibyte text, so a cut that is off by a byte shows as a broken line.
  const line = (n: number) => `${JSON.stringify({ n, text: "한글 ".repeat(n % 7 + 1) })}\n`;
  const all = Array.from({ length: 200 }, (_, n) => line(n)).join("");
  const file = `${dir}/a.jsonl`;
  await writeFile(file, all + '{"n":"half');
  const record = heldRecord(dir);
  // A sh that runs: never unreachable, nor denied.
  const read = (bytes: number) => record(bytes, run) as Promise<HeldText | undefined>;
  const parsed = (text: string) => text.split("\n").filter(Boolean).map((l) => JSON.parse(l) as { n: number });

  const first = (await read(1000))!;
  assert.equal(first.whole, false);
  const firstNs = parsed(first.text).map((e) => e.n);
  assert.equal(firstNs.at(-1), 199, "the half-written line waits");
  assert.ok(Buffer.byteLength(first.text) <= 1000 && Buffer.byteLength(first.text) > 800);

  // Claude finishes the line and writes another: only those come.
  await appendFile(file, `"}\n${line(200)}`);
  scripts.length = 0;
  const grown = (await read(1000))!;
  assert.equal(scripts.length, 1, "one ask when it only grew");
  assert.ok(grown.text.startsWith(first.text));
  assert.deepEqual(parsed(grown.text).slice(-2).map((e) => e.n), ["half" as never, 200]);

  // Further back on request, joined where the lines meet.
  const back = (await read(1_000_000))!;
  assert.equal(back.whole, true);
  assert.deepEqual(parsed(back.text).slice(0, 201).map((e) => e.n), Array.from({ length: 200 }, (_, n) => n).concat(["half" as never]));

  // Having read it all, a smaller ask is given its end only, from a line's start: each read is parsed whole.
  const small = (await read(1000))!;
  assert.equal(small.whole, false);
  assert.ok(back.text.endsWith(small.text) && Buffer.byteLength(small.text) >= 1000 && Buffer.byteLength(small.text) < Buffer.byteLength(back.text) / 3);
  assert.doesNotThrow(() => parsed(small.text));

  // A new conversation's record is read from its own end.
  const other = `${dir}/b.jsonl`;
  await writeFile(other, line(7));
  const later = new Date(Date.now() + 5000);
  await utimes(other, later, later);
  const switched = (await read(1000))!;
  assert.equal(switched.text, line(7));
  assert.equal(switched.whole, true);

  // A line longer than the ask, still being written: nothing kept to grow from mid-line, and the whole line once it ends.
  const third = `${dir}/c.jsonl`;
  await writeFile(third, `${line(7)}{"n":"${"x".repeat(5000)}`);
  const latest = new Date(Date.now() + 10_000);
  await utimes(third, latest, latest);
  assert.deepEqual(await read(1000), { text: "", whole: false });
  await appendFile(third, `"}\n${line(8)}`);
  await utimes(third, latest, latest);
  assert.deepEqual(parsed((await read(10_000))!.text).map((e) => typeof e.n === "number" ? e.n : "long"), [7, "long", 8]);

  // A record just begun, still empty: nothing further back to ask for.
  const empty = `${dir}/d.jsonl`;
  await writeFile(empty, "");
  const newest = new Date(Date.now() + 15_000);
  await utimes(empty, newest, newest);
  assert.deepEqual(await read(1000), { text: "", whole: true });

  // No record at all.
  assert.equal(await heldRecord(`${dir}/none`)(1000, run), undefined);
});

test("a held record past its first ask grows with one command, under a shell that prints first, and says why it has none", async (t) => {
  try {
    execFileSync("sh", ["-c", "true"]);
  } catch {
    t.skip("no sh here");
    return;
  }
  const dir = (await mkdtemp(join(tmpdir(), "held-"))).replaceAll("\\", "/");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const scripts: string[] = [];
  // A chatty rc file: its banner comes before every command's own output.
  const run = async (script: string) => {
    scripts.push(script);
    return `Welcome to the server\n${execFileSync("sh", ["-c", script], { encoding: "utf8" })}`;
  };
  // A long line just after where the first ask begins: its start is rounded up past that, as a big tool output does.
  const file = `${dir}/a.jsonl`;
  await writeFile(file, `{"n":0}\n{"long":"${"x".repeat(3000)}"}\n${'{"n":1}\n'.repeat(20)}`);
  const record = heldRecord(dir);
  const first = await record(1000, run);
  assert.ok(typeof first === "object" && first.text.startsWith('{"n":1}'));
  for (let n = 2; n < 5; n++) {
    await appendFile(file, `{"n":${n}}\n`);
    scripts.length = 0;
    const grown = await record(1000, run);
    assert.ok(typeof grown === "object" && grown.text.endsWith(`{"n":${n}}\n`));
    assert.equal(scripts.length, 1, "one command when it only grew");
  }
  // The machine could not be asked; the folder is not this account's to read.
  assert.equal(await heldRecord(dir)(1000, async () => undefined), "unreachable");
  assert.equal(await heldRecord(dir)(1000, async () => `banner\n${OUTPUT_MARK}\ndenied\n`), "denied");
  // Output with no marker is not the command's (an rc file that ended the shell first): never read as a path.
  assert.equal(await heldRecord(dir)(1000, async () => `${file}\n10\n`), undefined);
});

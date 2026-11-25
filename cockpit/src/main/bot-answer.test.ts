import assert from "node:assert/strict";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { scratchDir } from "../scratch-dir.ts";
import { projectSlug, transcriptFiles, transcriptText } from "../workflow/transcript.ts";
import { answerOfRun } from "./bot-answer.ts";

const FOLDER = "/work/app";
const START = Date.parse("2026-11-24T09:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const rows = (...items: Array<["user" | "assistant", string, number]>) =>
  items.map(([type, text, at]) => JSON.stringify({ type, timestamp: iso(at), message: { role: type, content: type === "user" ? text : [{ type: "text", text }] } })).join("\n") + "\n";

/** Real files in a temp home, read through the real listing; only the machine around them is faked. */
function rig() {
  const home = scratchDir("lepons-botanswer-");
  const dir = join(home, ".claude", "projects", projectSlug(FOLDER));
  mkdirSync(dir, { recursive: true });
  const put = (name: string, text: string, mtimeSec: number) => {
    writeFileSync(join(dir, name), text);
    utimesSync(join(dir, name), mtimeSec, mtimeSec);
  };
  const machine = { recordFiles: async () => transcriptFiles(FOLDER, home), recordFile: async (_f: string, _p: string, id: string) => transcriptText(FOLDER, id, home) } as never;
  return { put, machine, before: () => transcriptFiles(FOLDER, home) };
}

test("the run picks its own changed file, not the newer file of a person talking in the same folder", async () => {
  const r = rig();
  r.put("bot.jsonl", rows(["user", "옛 일", START - 9000], ["assistant", "옛 답.", START - 8000]), 100);
  r.put("person.jsonl", rows(["user", "내 질문", START - 5000], ["assistant", "내 답.", START - 4000]), 200);
  const before = await r.before();
  r.put("bot.jsonl", rows(["user", "옛 일", START - 9000], ["assistant", "옛 답.", START - 8000], ["user", "일해", START + 1000], ["assistant", "봇의 답입니다.", START + 2000]), 300);
  assert.equal(await answerOfRun(r.machine, "claude", FOLDER, before, START, 5), "봇의 답입니다.");
});

test("two changed files mean no answer", async () => {
  const r = rig();
  r.put("bot.jsonl", rows(["user", "a", START - 9000]), 100);
  r.put("person.jsonl", rows(["user", "b", START - 9000]), 100);
  const before = await r.before();
  r.put("bot.jsonl", rows(["user", "a", START - 9000], ["assistant", "봇.", START + 2000]), 300);
  r.put("person.jsonl", rows(["user", "b", START - 9000], ["assistant", "사람.", START + 2000]), 300);
  assert.equal(await answerOfRun(r.machine, "claude", FOLDER, before, START, 5), undefined);
});

test("a note older than the run's start is rejected, after one retry", async () => {
  const r = rig();
  r.put("bot.jsonl", rows(["user", "a", START - 9000]), 100);
  const before = await r.before();
  r.put("bot.jsonl", rows(["user", "a", START - 9000], ["assistant", "지난 답.", START - 1000]), 300);
  assert.equal(await answerOfRun(r.machine, "claude", FOLDER, before, START, 5), undefined);
});

test("a note that lands during the retry is taken", async () => {
  const r = rig();
  r.put("bot.jsonl", rows(["user", "a", START - 9000]), 100);
  const before = await r.before();
  r.put("bot.jsonl", rows(["user", "a", START - 9000], ["user", "일해", START + 1000]), 300);
  setTimeout(() => r.put("bot.jsonl", rows(["user", "a", START - 9000], ["user", "일해", START + 1000], ["assistant", "늦은 답.", START + 2000]), 400), 20);
  assert.equal(await answerOfRun(r.machine, "claude", FOLDER, before, START, 100), "늦은 답.");
});

test("no snapshot, or an agent with no files to tell apart, gives no answer", async () => {
  const r = rig();
  assert.equal(await answerOfRun(r.machine, "claude", FOLDER, undefined, START, 5), undefined);
  assert.equal(await answerOfRun(r.machine, null, FOLDER, [], START, 5), undefined);
});

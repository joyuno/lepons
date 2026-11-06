import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeEntry, codexEntry, codexNames, localPast, parsePastListing, remoteClaudePastScript, remoteCodexPastScript } from "./past.ts";
import { projectSlug } from "./transcript.ts";

const id = "95c7d9d4-d741-4643-9f06-2e0f431f1a40";
const line = (type: string, key: string, value: string) => JSON.stringify({ type, [key]: value, sessionId: id });

test("a Claude title is the operator's own name, then Claude's, then the last prompt; the folder name is none", () => {
  const ai = line("ai-title", "aiTitle", "zsrch 위치");
  const prompts = [line("last-prompt", "lastPrompt", "first"), line("last-prompt", "lastPrompt", "second")];
  assert.equal(claudeEntry(id, 5, [line("custom-title", "customTitle", "USB 확인"), ai].join("\n"), "app")?.title, "USB 확인");
  assert.equal(claudeEntry(id, 5, [line("custom-title", "customTitle", "app"), ai].join("\n"), "app")?.title, "zsrch 위치");
  assert.equal(claudeEntry(id, 5, prompts.join("\n"), "app")?.title, "second");
  assert.deepEqual(claudeEntry(id, 5, '{"type":"user","cwd":"/x"}\n{"type":"ai-ti', "app"), { agent: "claude", id, at: 5, title: "" });
});

test("programs driving Claude, and files that are not conversations, are not offered", () => {
  assert.equal(claudeEntry(id, 5, '{"type":"user","entrypoint":"sdk-cli"}', "app"), undefined);
  assert.equal(claudeEntry("agent-1", 5, "", "app"), undefined);
});

test("Codex titles come from its index, a later line renaming", () => {
  const cid = "01a18035-32ea-7882-aea8-6af87bac56f9";
  const names = codexNames(`${JSON.stringify({ id: cid, thread_name: "old" })}\nnot json\n${JSON.stringify({ id: cid, thread_name: "new" })}\n`);
  assert.deepEqual(codexEntry(`/h/.codex/sessions/2026/10/28/rollout-2026-10-28T10-52-12-${cid}.jsonl`, 7, names), { agent: "codex", id: cid, at: 7, title: "new" });
  assert.equal(codexEntry("/h/rollout-x.jsonl", 7, names), undefined);
});

test("a remote listing reads into entries; noise before it is ignored", () => {
  const out = `motd\n@@ 1700000000 /h/.claude/projects/-a/${id}.jsonl\n${line("ai-title", "aiTitle", "T")}\n@@ 1600000000 /h/.claude/projects/-a/${id}.jsonl\n"entrypoint":"sdk\n`;
  assert.deepEqual(parsePastListing("claude", out, "a"), [{ agent: "claude", id, at: 1700000000_000, title: "T" }]);
  assert.deepEqual(parsePastListing("codex", "\n@@index\n", "a"), []);
});

test("this PC and the remote scripts list the same conversations, newest first", async () => {
  const home = mkdtempSync(join(tmpdir(), "past-")).replaceAll("\\", "/");
  const folder = "/home/u/app";
  const older = "11111111-1111-4111-8111-111111111111";
  const newer = "22222222-2222-4222-8222-222222222222";
  const sdk = "33333333-3333-4333-8333-333333333333";
  const claudeDir = join(home, ".claude", "projects", projectSlug(folder));
  mkdirSync(claudeDir, { recursive: true });
  const write = (path: string, text: string, at: number) => { writeFileSync(path, text); utimesSync(path, at, at); };
  write(join(claudeDir, `${older}.jsonl`), `{"type":"user","cwd":"${folder}","entrypoint":"cli"}\n${line("ai-title", "aiTitle", "옛 대화")}\n`, 1_700_000_000);
  write(join(claudeDir, `${sdk}.jsonl`), `{"type":"user","entrypoint":"sdk-cli"}\n`, 1_700_000_500);
  const day = join(home, ".codex", "sessions", "2026", "10", "28");
  mkdirSync(day, { recursive: true });
  write(join(day, `rollout-2026-10-28T10-52-12-${newer}.jsonl`), `${JSON.stringify({ type: "session_meta", payload: { id: newer, cwd: folder } })}\n`, 1_700_001_000);
  write(join(day, `rollout-2026-10-28T09-00-00-${sdk}.jsonl`), `${JSON.stringify({ type: "session_meta", payload: { id: sdk, cwd: "/elsewhere" } })}\n`, 1_700_002_000);
  writeFileSync(join(home, ".codex", "session_index.jsonl"), `${JSON.stringify({ id: newer, thread_name: "새 대화" })}\n`);

  const expected = [
    { agent: "codex", id: newer, at: 1_700_001_000_000, title: "새 대화" },
    { agent: "claude", id: older, at: 1_700_000_000_000, title: "옛 대화" },
  ];
  assert.deepEqual(await localPast(folder, "app", home), expected);
  const sh = (script: string) => execFileSync("sh", ["-c", script], { encoding: "utf8", env: { ...process.env, HOME: home } });
  const remote = [
    ...parsePastListing("claude", sh(remoteClaudePastScript(`${home}/.claude/projects/${projectSlug(folder)}`)), "app"),
    ...parsePastListing("codex", sh(remoteCodexPastScript(folder)), "app"),
  ].sort((a, b) => b.at - a.at);
  assert.deepEqual(remote, expected);
});

test("a folder with no record lists nothing", async () => {
  const home = mkdtempSync(join(tmpdir(), "past-"));
  assert.deepEqual(await localPast("/none", "none", home), []);
});

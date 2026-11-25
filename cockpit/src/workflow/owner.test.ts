import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { botPreamble, botProfilePath } from "../agent/bots.ts";
import { findGitBash } from "../main/allow-ssh.ts";
import { latestCodexRollout, remoteRolloutScript } from "./codex.ts";
import { heldRecord } from "./held-record.ts";
import { latestTranscript, projectSlug, remoteTranscriptTailScript } from "./transcript.ts";

// What each side's first prompt is: a bot's is its preamble, as the scheduler and a hand-opened bot session type it.
const preamble = (name: string) => `${botPreamble(name, botProfilePath("/work/app", name))} 오늘 할 일 정리`;
// Shaped after Claude Code 2.1 transcripts: hook output and a command's caveat come before the first prompt.
const claude = (prompt: string, said: string, ...more: string[]) =>
  [
    JSON.stringify({ type: "attachment", attachment: { type: "hook_success", content: "x".repeat(30_000) } }),
    JSON.stringify({ type: "user", message: { role: "user", content: "<local-command-caveat>Caveat</local-command-caveat>" }, isMeta: true }),
    JSON.stringify({ type: "user", message: { role: "user", content: prompt } }),
    ...more,
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: said }] } }),
  ].join("\n") + "\n";
/** A person asking to see what a bot was sent: the tool's output quotes the preamble, as Claude keeps it. */
const quoted = (name: string) =>
  JSON.stringify({ type: "user", message: { role: "user", content: [{ tool_use_id: "t1", type: "tool_result", content: preamble(name) }] }, toolUseResult: { stdout: preamble(name), stderr: "" } });
/** Files written in this order, each a minute newer than the one before. */
function write(dir: string, files: Array<[string, string]>): void {
  mkdirSync(dir, { recursive: true });
  files.forEach(([name, text], index) => {
    writeFileSync(join(dir, name), text);
    const at = new Date(Date.now() - (files.length - index) * 60_000);
    utimesSync(join(dir, name), at, at);
  });
}

test("in one folder a person's Claude record and each bot's read apart, whichever is newer", async () => {
  const home = mkdtempSync(join(tmpdir(), "lepons-owner-"));
  try {
    const dir = join(home, ".claude", "projects", projectSlug("/work/app"));
    write(dir, [
      ["a.jsonl", claude("로그인 버그 고쳐줘", "PERSON-OLD")],
      ["b.jsonl", claude(preamble("정리 봇"), "TIDY")],
      ["c.jsonl", claude("봇이 받은 지시 보여줘", "PERSON-NEW", quoted("정리 봇"))],
      // A whole paste keeps the text inside a tag in Claude's record, after two line breaks.
      ["d.jsonl", claude(`\n\n<pasted_content id="0851">\n${preamble('뉴스 "아침"')}</pasted_content>`, "NEWS")],
    ]);
    const read = (bot?: string) => latestTranscript("/work/app", home, bot);
    assert.match((await read()) ?? "", /PERSON-NEW/);
    assert.match((await read("정리 봇")) ?? "", /TIDY/);
    assert.match((await read('뉴스 "아침"')) ?? "", /NEWS/);
    assert.equal(await read("없는 봇"), undefined);

    // The person's newer than the bot's, then the bot's newer than the person's: each still gets its own.
    appendFileSync(join(dir, "a.jsonl"), JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "PERSON-LATEST" }] } }) + "\n");
    assert.match((await read()) ?? "", /PERSON-LATEST/);
    assert.match((await read("정리 봇")) ?? "", /TIDY/);

    // A bot's new file before its preamble is in reads as nobody's bot yet; once it is in, the bot's.
    writeFileSync(join(dir, "e.jsonl"), JSON.stringify({ type: "session-owner" }) + "\n");
    assert.match((await read("정리 봇")) ?? "", /TIDY/);
    appendFileSync(join(dir, "e.jsonl"), claude(preamble("정리 봇"), "TIDY-CLEARED"));
    assert.match((await read("정리 봇")) ?? "", /TIDY-CLEARED/);
    assert.match((await read()) ?? "", /PERSON-LATEST/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

const rollout = (cwd: string, prompt: string, said: string, ...more: string[]) =>
  [
    JSON.stringify({ timestamp: "t", type: "session_meta", payload: { cwd, source: "cli", base_instructions: { text: "x".repeat(20_000) } } }),
    JSON.stringify({ timestamp: "t", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "# AGENTS.md instructions" }] } }),
    JSON.stringify({ timestamp: "t", type: "event_msg", payload: { type: "item_completed", item: { type: "UserMessage", id: "u1", content: [{ type: "text", text: prompt }] } } }),
    ...more,
    JSON.stringify({ timestamp: "t", type: "event_msg", payload: { type: "item_completed", item: { type: "AgentMessage", content: [{ type: "Text", text: said }] } } }),
  ].join("\n") + "\n";

const codexQuoted = (name: string) =>
  JSON.stringify({ timestamp: "t", type: "event_msg", payload: { type: "item_completed", item: { type: "CommandExecution", command: ["sh", "-c", "cat"], aggregated_output: preamble(name) } } });

test("in one folder a person's Codex rollout and a bot's read apart", async () => {
  const home = mkdtempSync(join(tmpdir(), "lepons-owner-"));
  try {
    const repo = process.platform === "win32" ? "C:\\work\\app" : "/work/app";
    write(join(home, ".codex", "sessions", "2026", "11", "24"), [
      ["rollout-a.jsonl", rollout(repo, "로그인 버그 고쳐줘", "PERSON")],
      ["rollout-b.jsonl", rollout(repo, preamble("정리 봇"), "TIDY")],
      ["rollout-c.jsonl", rollout(repo, preamble("뉴스 봇"), "NEWS")],
    ]);
    // The person's older than the bots'.
    assert.match((await latestCodexRollout(repo, home)) ?? "", /PERSON/);
    assert.match((await latestCodexRollout(repo, home, false, undefined, "정리 봇")) ?? "", /TIDY/);
    assert.match((await latestCodexRollout(repo, home, false, undefined, "뉴스 봇")) ?? "", /NEWS/);
    // Then newer, and quoting a bot's preamble in a command's output: still the person's, and the bots keep theirs.
    const day = join(home, ".codex", "sessions", "2026", "11", "24");
    writeFileSync(join(day, "rollout-d.jsonl"), rollout(repo, "봇이 받은 지시 보여줘", "PERSON-NEW", codexQuoted("정리 봇")));
    assert.match((await latestCodexRollout(repo, home)) ?? "", /PERSON-NEW/);
    assert.match((await latestCodexRollout(repo, home, false, undefined, "정리 봇")) ?? "", /TIDY/);
    assert.match((await latestCodexRollout(repo, home, false, undefined, "뉴스 봇")) ?? "", /NEWS/);
    // The plan readout reads any folder's, anyone's.
    assert.match((await latestCodexRollout("", home, true)) ?? "", /PERSON-NEW/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// Over SSH a shell runs these; the Windows runners have it with Git.
const shell = process.platform === "win32" ? findGitBash() : "bash";
test("on another machine the same lookups pick the same records", { skip: !shell }, async () => {
  const home = mkdtempSync(join(tmpdir(), "lepons owner-")).replaceAll("\\", "/");
  try {
    const sh = (script: string) => spawnSync(shell!, ["-c", script], { encoding: "utf8", env: { ...process.env, HOME: home, LC_ALL: "en_US.UTF-8" } }).stdout;
    const dir = `${home}/.claude/projects/${projectSlug("/work/app")}`;
    write(dir, [
      ["a.jsonl", claude(preamble("정리 봇"), "TIDY")],
      ["b.jsonl", claude("봇이 받은 지시 보여줘", "PERSON", quoted("정리 봇"))],
      ["c.jsonl", claude(`\n\n<pasted_content id="3d2d">\n${preamble("뉴스 봇")}</pasted_content>`, "NEWS")],
    ]);
    assert.match(sh(remoteTranscriptTailScript("/work/app")), /PERSON/);
    assert.match(sh(remoteTranscriptTailScript("/work/app", "정리 봇")), /TIDY/);
    assert.match(sh(remoteTranscriptTailScript("/work/app", "뉴스 봇")), /NEWS/);
    assert.equal(sh(remoteTranscriptTailScript("/work/app", "없는 봇")), "");

    const held = (bot?: string) => heldRecord(dir, bot)(1_000_000, async (script) => sh(script));
    assert.match((await held())?.text ?? "", /PERSON/);
    assert.match((await held("정리 봇"))?.text ?? "", /TIDY/);

    write(`${home}/.codex/sessions/2026/11/24`, [
      ["rollout-a.jsonl", rollout("/work/app", preamble("정리 봇"), "TIDY")],
      ["rollout-b.jsonl", rollout("/work/app", "봇이 받은 지시 보여줘", "PERSON", codexQuoted("정리 봇"))],
      ["rollout-c.jsonl", rollout("/work/app", preamble("뉴스 봇"), "NEWS")],
    ]);
    assert.match(sh(remoteRolloutScript("/work/app")), /PERSON/);
    assert.match(sh(remoteRolloutScript("/work/app", "정리 봇")), /TIDY/);
    assert.doesNotMatch(sh(remoteRolloutScript("/work/app", "정리 봇")), /NEWS|PERSON/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("over SSH a night of bot runs does not hide an idle person's record", { skip: !shell }, async () => {
  const home = mkdtempSync(join(tmpdir(), "lepons owner-")).replaceAll("\\", "/");
  try {
    const sh = (script: string) => spawnSync(shell!, ["-c", script], { encoding: "utf8", env: { ...process.env, HOME: home, LC_ALL: "en_US.UTF-8" } }).stdout;
    write(`${home}/.claude/projects/${projectSlug("/work/app")}`, [
      ["person.jsonl", claude("로그인 버그 고쳐줘", "PERSON")],
      ...Array.from({ length: 12 }, (_, index): [string, string] => [`bot-${index}.jsonl`, claude(preamble("정리 봇"), `TIDY-${index}`)]),
    ]);
    assert.match(sh(remoteTranscriptTailScript("/work/app")), /PERSON/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

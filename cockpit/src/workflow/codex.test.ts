import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { findGitBash } from "../main/allow-ssh.ts";
import { cwdNeedle, headBytes, latestCodexRollout, parseCodexRollout, remoteRolloutScript } from "./codex.ts";

// Shaped after real Codex 0.154 rollouts; only the fields the parser reads.
const line = (type: string, payload: unknown, at = "2026-10-14T05:00:00.000Z") =>
  JSON.stringify({ timestamp: at, type, payload });
const done = (item: unknown, at?: string) => line("event_msg", { type: "item_completed", item }, at);

test("a Codex session reads as prompts, notes, pooled actions and subagents", () => {
  const jsonl = [
    line("session_meta", { cwd: "/home/me/app" }),
    done({ type: "UserMessage", content: [{ type: "text", text: "<recommended_plugins>…" }] }),
    done({ type: "UserMessage", content: [{ type: "text", text: "fix the login bug" }] }),
    done({ type: "CommandExecution", command: ["/bin/bash", "-lc", "npm test\nmore"] }),
    done({ type: "FileChange", changes: { "/home/me/app/src/login.ts": { type: "update" }, "/home/me/app/NOTES.md": { type: "add" } } }),
    done({ type: "McpToolCall", server: "lepons", tool: "read_file" }),
    done({ type: "Reasoning" }),
    done({ type: "AgentMessage", content: [{ type: "Text", text: "Fixed; tests pass." }] }),
    line("response_item", { type: "function_call", name: "spawn_agent", arguments: JSON.stringify({ task_name: "review", message: "check the diff" }) }),
    line("response_item", { type: "function_call", name: "spawn_agent", arguments: JSON.stringify({ task_name: "secret", message: "gAAAAABq…" }) }),
    done({ type: "SubAgentActivity", kind: "started", agent_thread_id: "t1", agent_path: "/root/review" }),
    done({ type: "SubAgentActivity", kind: "started", agent_thread_id: "t2", agent_path: "/root/secret" }),
    done({ type: "SubAgentActivity", kind: "completed", agent_thread_id: "t1", agent_path: "/root/review" }, "2026-10-14T05:01:00.000Z"),
    "not json",
  ].join("\n");

  const { events } = parseCodexRollout(jsonl);
  assert.deepEqual(events.map((event) => event.kind), ["prompt", "action", "note", "subagent", "subagent"]);
  assert.equal(events[0]!.kind === "prompt" && events[0]!.text, "fix the login bug");
  assert.equal(
    events[1]!.kind === "action" && events[1]!.text,
    "Shell · npm test  ·  Edit login.ts  ·  Write NOTES.md  ·  MCP lepons.read_file",
  );
  const [review, secret] = events.slice(3) as Array<WorkflowSub>;
  assert.equal(review!.description, "review");
  assert.equal(review!.instructions, "check the diff");
  assert.equal(review!.result, "");
  assert.equal(secret!.instructions, "");
  assert.equal(secret!.result, undefined);
});

type WorkflowSub = { description: string; instructions: string; result?: string };

test("the newest rollout for the folder is found, not a newer one for another", async () => {
  const home = mkdtempSync(join(tmpdir(), "lepons-codex-"));
  try {
    const day = join(home, ".codex", "sessions", "2026", "10", "14");
    mkdirSync(day, { recursive: true });
    const repo = process.platform === "win32" ? "C:\\work\\app" : "/work/app";
    const meta = (cwd: string) => line("session_meta", { id: "x", timestamp: "t", cwd });
    writeFileSync(join(day, "rollout-a.jsonl"), [meta(repo), done({ type: "AgentMessage", content: [{ text: "ours" }] })].join("\n"));
    writeFileSync(join(day, "rollout-b.jsonl"), [meta("/elsewhere"), done({ type: "AgentMessage", content: [{ text: "theirs" }] })].join("\n"));
    const found = await latestCodexRollout(repo.replaceAll("\\", "/"), home);
    assert.match(found ?? "", /ours/);
    assert.equal(await latestCodexRollout("/nowhere", home), undefined);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("the remote lookup matches the cwd exactly as Codex writes it", () => {
  assert.equal(cwdNeedle('/home/a "b"'), '"cwd":"/home/a \\"b\\""');
});

// A turn in the order Codex 0.166 writes it (row types counted across 64 local rollouts).
const turnOpens = [
  line("event_msg", { type: "thread_settings_applied" }),
  line("event_msg", { type: "task_started", turn_id: "t" }),
  line("response_item", { type: "message", role: "developer", content: [{ type: "input_text", text: "<permissions>" }] }),
  JSON.stringify({ timestamp: "2026-10-14T05:00:00.000Z", type: "world_state", payload: {} }),
  JSON.stringify({ timestamp: "2026-10-14T05:00:00.000Z", type: "turn_context", payload: {} }),
];
const asked = (text: string) => [
  ...turnOpens,
  line("response_item", { type: "message", role: "user", content: [{ type: "input_text", text }] }),
  done({ type: "UserMessage", content: [{ type: "text", text }] }),
];
const answered = (text: string) => [
  done({ type: "AgentMessage", content: [{ type: "Text", text }], phase: "final_answer" }),
  line("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text }], phase: "final_answer" }),
];
const stopped = [
  line("response_item", { type: "message", role: "developer", content: [{ type: "input_text", text: "<turn_aborted>" }] }),
  line("event_msg", { type: "turn_aborted", turn_id: "t", reason: "interrupted", started_at: 1, completed_at: 2, duration_ms: 1 }),
];
const finished = line("event_msg", { type: "task_complete", turn_id: "t", last_agent_message: "x" });
const story = (...rows: string[]) => parseCodexRollout(rows.join("\n"), true).events.map((e) => [e.kind, (e as { text?: string }).text, e.kind !== "prompt" && e.cancelled === true]);

test("a Codex prompt aborted before any answer goes; the corrected one stands alone", () => {
  assert.deepEqual(story(...asked("틀린 지시"), ...stopped, ...asked("고친 지시"), ...answered("네."), finished), [
    ["prompt", "고친 지시", false],
    ["note", "네.", false],
  ]);
});

test("what an aborted Codex turn did stays, marked; a turn aborted with nothing in it marks nothing", () => {
  const tool = done({ type: "CommandExecution", command: ["pwsh", "-c", "npm test"] });
  assert.deepEqual(story(...asked("돌려 줘"), tool, ...stopped), [["prompt", "돌려 줘", false], ["action", "Shell · npm test", true]]);
  assert.deepEqual(story(...asked("돌려 줘"), ...answered("보는 중."), ...stopped), [["prompt", "돌려 줘", false], ["note", "보는 중.", true]]);
  assert.deepEqual(story(...asked("먼저"), ...answered("끝."), finished, ...turnOpens, ...stopped), [["prompt", "먼저", false], ["note", "끝.", false]]);
  assert.deepEqual(story(line("session_meta", { cwd: "/w" }), ...stopped), [], "as a fresh session's first turn can");
});

test("tools the story leaves out are still work: the prompt stays, and thinking alone is none", () => {
  assert.deepEqual(story(...asked("봐 줘"), done({ type: "ImageView" }), ...stopped), [["prompt", "봐 줘", false], ["action", "ImageView", true]]);
  assert.deepEqual(story(...asked("봐 줘"), done({ type: "Reasoning" }), ...stopped), []);
  assert.deepEqual(story(...asked("먼저"), done({ type: "ImageView" }), finished, ...asked("다음"), ...stopped), [["prompt", "먼저", false]], "the work was the turn before");
});

// Over SSH a shell runs this; the Windows runners have it with Git.
const shell = process.platform === "win32" ? findGitBash() : "bash";
test("the remote lookup skips a subagent whose 4 KB head ends inside a character", { skip: !shell }, () => {
  const home = mkdtempSync(join(tmpdir(), "lepons-codex-"));
  try {
    const day = join(home, ".codex", "sessions", "2026", "11", "03");
    mkdirSync(day, { recursive: true });
    // A non-ASCII word across byte 4096: a UTF-8 grep prints "Binary file matches" for that line, not the line.
    const meta = (source: unknown) => {
      const open = JSON.stringify({ timestamp: "t", type: "session_meta", payload: { cwd: "/w", source, base_instructions: { text: "" } } });
      return open.replace('"text":""', `"text":"${"x".repeat(headBytes - open.length - 1)}한글 이어짐"`);
    };
    writeFileSync(join(day, "rollout-a.jsonl"), `${meta("cli")}\nthe session\n`);
    writeFileSync(join(day, "rollout-b.jsonl"), `${meta({ subagent: { thread_spawn: {} } })}\nthe subagent\n`);
    utimesSync(join(day, "rollout-b.jsonl"), new Date(), new Date(Date.now() + 60_000));
    const { stdout } = spawnSync(shell!, ["-c", remoteRolloutScript("/w")], { encoding: "utf8", env: { ...process.env, HOME: home.replaceAll("\\", "/"), LC_ALL: "en_US.UTF-8" } });
    assert.match(stdout, /the session/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a folder's rollout is the session's own, not the newer one of a subagent it sent out", async () => {
  const home = mkdtempSync(join(tmpdir(), "lepons-codex-"));
  try {
    const day = join(home, ".codex", "sessions", "2026", "11", "03");
    mkdirSync(day, { recursive: true });
    const repo = process.platform === "win32" ? "C:\\work\\app" : "/work/app";
    const meta = (source: unknown) => JSON.stringify({ timestamp: "t", type: "session_meta", payload: { session_id: "s", id: "i", timestamp: "t", cwd: repo, originator: "codex", cli_version: "0.166.0", source, model_provider: "openai", base_instructions: { text: "x".repeat(20_000) } } });
    writeFileSync(join(day, "rollout-a.jsonl"), [meta("cli"), ...asked("세션 쪽 지시")].join("\n"));
    writeFileSync(join(day, "rollout-b.jsonl"), [meta({ subagent: { thread_spawn: { parent_thread_id: "p", depth: 1 } } }), ...answered("하위 쪽 답")].join("\n"));
    utimesSync(join(day, "rollout-b.jsonl"), new Date(), new Date(Date.now() + 60_000));
    assert.match((await latestCodexRollout(repo, home)) ?? "", /세션 쪽 지시/);
    // The plan readout looks for numbers in any record, subagents' too.
    assert.match((await latestCodexRollout("", home, true)) ?? "", /하위 쪽 답/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

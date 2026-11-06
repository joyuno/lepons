import assert from "node:assert/strict";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { scratchDir } from "../scratch-dir.ts";
import { latestCodexRollout } from "./codex.ts";
import { latestTranscriptTail, projectSlug } from "./transcript.ts";
import { readTurn, turnEnd } from "./turn.ts";

// Fixtures in the shapes real records have, fields and order as counted across
// local Claude Code 2.1.287-2.1.317 and Codex 0.162-0.166 records; the words are made up.
const NOW = Date.parse("2026-11-03T07:00:00.000Z");
const stamp = (ago = 1000) => new Date(NOW - ago).toISOString();
const jsonl = (...rows: object[]) => rows.map((row) => JSON.stringify(row)).join("\n") + "\n";

const claudeRow = (type: string, message: object, extra: object = {}) => ({
  parentUuid: "p", isSidechain: false, userType: "external", entrypoint: "cli", cwd: "/repo", sessionId: "s", version: "2.1.317", gitBranch: "main",
  type, message, uuid: "u", timestamp: stamp(), ...extra,
});
const assistant = (stop: string | null, content: object[], extra?: object) =>
  claudeRow("assistant", { model: "claude-opus-5-5", id: "m", type: "message", role: "assistant", content, stop_reason: stop, stop_sequence: null }, extra);
const user = (content: unknown, extra?: object) => claudeRow("user", { role: "user", content }, extra);
const toolUse = (id: string, name: string) => ({ type: "tool_use", id, name, input: {} });
const toolResult = (id: string) => ({ tool_use_id: id, type: "tool_result", content: "ok" });
/** What Claude Code writes after a turn's last message. */
const bookkeeping = [
  { type: "attachment", attachment: { type: "x" }, timestamp: stamp() },
  { type: "system", subtype: "stop_hook_summary", timestamp: stamp() },
  { type: "system", subtype: "turn_duration", durationMs: 1000, timestamp: stamp() },
  { type: "last-prompt", lastPrompt: "x", sessionId: "s" },
  { type: "cost-state" },
];
const claude = (...rows: object[]) => turnEnd("claude", jsonl(user("do it"), ...rows), NOW, 60_000);

test("Claude: the last message ending the turn is finished, bookkeeping after it does not matter", () => {
  assert.equal(claude(assistant("end_turn", [{ type: "thinking", thinking: "" }]), assistant("end_turn", [{ type: "text", text: "All done." }]), ...bookkeeping), "finished");
});

test("Claude: a turn that ends on a question is the operator's", () => {
  assert.equal(claude(assistant("end_turn", [{ type: "text", text: "Which one should I keep?\n" }]), ...bookkeeping), "waiting");
  assert.equal(claude(assistant("end_turn", [{ type: "text", text: "어느 쪽으로 할까요？" }])), "waiting");
});

test("Claude: an open AskUserQuestion, or any call open under a quiet terminal, is waiting", () => {
  assert.equal(claude(assistant("tool_use", [toolUse("a", "AskUserQuestion")])), "waiting");
  assert.equal(claude(assistant("tool_use", [{ type: "text", text: "Running it." }]), assistant("tool_use", [toolUse("a", "Bash")])), "waiting");
  // Two at once, one answered.
  assert.equal(claude(assistant("tool_use", [toolUse("a", "Read")]), assistant("tool_use", [toolUse("b", "Bash")]), user([toolResult("a")])), "waiting");
});

test("Claude: every call answered and quiet is still its turn", () => {
  assert.equal(claude(assistant("tool_use", [toolUse("a", "Bash")]), user([toolResult("a")], { sourceToolAssistantUUID: "u" })), "busy");
});

test("Claude: stopped by the operator, either way it is written", () => {
  assert.equal(claude(assistant("tool_use", [{ type: "text", text: "Hm" }]), user([{ type: "text", text: "[Request interrupted by user]" }])), "stopped");
  assert.equal(claude(assistant("tool_use", [toolUse("a", "Bash")]), user([{ type: "tool_result", tool_use_id: "a", is_error: true, content: "x" }]), user([{ type: "text", text: "[Request interrupted by user for tool use]" }])), "stopped");
  assert.equal(claude(user("<local-command-stdout>Done</local-command-stdout>")), "stopped", "one of the CLI's own commands");
  assert.equal(claude(user("Summary", { isCompactSummary: true })), "stopped", "a /compact nothing followed");
});

test("Claude: a prompt alone under a quiet terminal was cancelled before its first word, which writes no mark", () => {
  assert.equal(claude(...bookkeeping), "stopped");
  assert.equal(claude(assistant("end_turn", [{ type: "text", text: "Done." }]), user("다시 해 줘"), ...bookkeeping), "stopped");
});

test("Claude: a call left open by a crash does not hang over the next prompt", () => {
  assert.equal(claude(assistant("tool_use", [toolUse("old", "Bash")]), user("try again")), "stopped");
  assert.equal(claude(assistant("tool_use", [toolUse("old", "Bash")]), user("try again"), assistant("end_turn", [{ type: "text", text: "Done." }])), "finished");
});

test("Claude: an API error's synthetic message leaves it to rhythm", () => {
  assert.equal(claude(assistant("stop_sequence", [{ type: "text", text: "API Error" }], { isApiErrorMessage: true, error: "unknown" })), "unknown");
  assert.equal(claude(assistant(null, [{ type: "text", text: "partial" }], { isAbortedMidStream: true })), "unknown");
});

test("Claude: a subagent's records are not the session's", () => {
  assert.equal(claude(assistant("end_turn", [{ type: "text", text: "Done." }]), assistant("tool_use", [toolUse("s", "Bash")], { isSidechain: true })), "finished");
});

const event = (payload: object, ago?: number) => ({ timestamp: stamp(ago), type: "event_msg", payload });
const started = event({ type: "task_started", turn_id: "t", root_turn_id: "t", started_at: 1, model_context_window: 1, collaboration_mode_kind: "default" });
const codexHead = [{ timestamp: stamp(), type: "session_meta", payload: { id: "i", cwd: "/repo" } }, started];
const codex = (...rows: object[]) => turnEnd("codex", jsonl(...codexHead, ...rows), NOW, 60_000);
const complete = (fields: object) => event({ type: "task_complete", turn_id: "t", root_turn_id: "t", started_at: 1, completed_at: 2, duration_ms: 1, ...fields });
const tokens = event({ type: "token_count", info: {} });

test("Codex: task_complete is finished, or waiting when it ends on a question", () => {
  assert.equal(codex(tokens, complete({ last_agent_message: "All done." })), "finished");
  assert.equal(codex(complete({ last_agent_message: "Shall I go on?" })), "waiting");
  assert.equal(codex(complete({ last_agent_message: null })), "finished");
});

test("Codex: a failed turn leaves it to rhythm; an aborted one is stopped", () => {
  assert.equal(codex(complete({ last_agent_message: null, error: { message: "m", codex_error_info: "x" } })), "unknown");
  assert.equal(codex(event({ type: "turn_aborted", turn_id: "t", root_turn_id: "t", reason: "interrupted", started_at: 1 })), "stopped");
});

test("Codex: an open turn is busy, as during a real approval prompt, whose rollout holds no request", () => {
  const exec = { timestamp: stamp(), type: "response_item", payload: { type: "custom_tool_call", name: "exec", call_id: "c", input: "x" } };
  assert.equal(codex(exec, { timestamp: stamp(), type: "token_usage_record", payload: {} }), "busy");
  assert.equal(codex(event({ type: "exec_approval_request" })), "waiting", "should a version write one");
});

test("a new turn after a finished one is judged on its own", () => {
  assert.equal(codex(complete({ last_agent_message: "Done." }), started), "busy");
});

test("a record older than the work was not written by it: connecting, or typing", () => {
  const old = 3_600_000;
  assert.equal(turnEnd("claude", jsonl(assistant("end_turn", [{ type: "text", text: "Done." }], { timestamp: stamp(old) })), NOW, 4000), "quiet");
  assert.equal(turnEnd("claude", jsonl(assistant("tool_use", [toolUse("a", "AskUserQuestion")], { timestamp: stamp(old) })), NOW, 4000), "quiet", "yesterday's open question");
  assert.equal(turnEnd("codex", jsonl(complete({ last_agent_message: "Done." }), { type: "x" }).replace(stamp(), stamp(old)), NOW, 4000), "quiet");
  // The prompt that started this work, written just before its output began.
  assert.equal(turnEnd("claude", jsonl(assistant("end_turn", [{ type: "text", text: "Done." }], { timestamp: stamp(8000) })), NOW, 4000), "finished");
});

test("a machine whose clock is hours off is judged by spans, not by this PC's time", () => {
  const off = NOW + 3 * 3_600_000;
  assert.equal(turnEnd("claude", jsonl(assistant("end_turn", [{ type: "text", text: "Done." }])), off, 60_000), "quiet", "the record's clock must be the machine's own");
  assert.equal(turnEnd("claude", jsonl(assistant("end_turn", [{ type: "text", text: "Done." }], { timestamp: new Date(off - 1000).toISOString() })), off, 60_000), "finished");
});

test("no record yet, or one with no turn in it, is no work; a tail too short to hold a turn cannot say", () => {
  assert.equal(turnEnd("claude", "", NOW, 4000), "quiet");
  assert.equal(turnEnd("codex", jsonl({ timestamp: stamp(), type: "session_meta", payload: {} }, event({ type: "thread_settings_applied" })), NOW, 4000), "quiet", "what `codex fork` writes on starting");
  assert.equal(turnEnd("claude", "{cut in two", NOW, 4000), "quiet");
  assert.equal(turnEnd("claude", jsonl({ type: "api-request-blob", blob: "x".repeat(500_000) }), NOW, 4000), "unknown");
  assert.equal(turnEnd("claude", jsonl(assistant("end_turn", [], { timestamp: undefined })), NOW, 4000), "unknown");
  assert.equal(turnEnd("claude", "", NOW, 600_000), "unknown", "ten minutes of output and no record: it is kept where this does not look");
  assert.equal(turnEnd("codex", "", NOW, 600_000), "unknown");
});

test("a read that fails or is not back in time leaves it to rhythm", async () => {
  assert.equal(await readTurn(async () => undefined, "claude", 1000), "unknown");
  assert.equal(await readTurn(() => Promise.reject(new Error("no")), "claude", 1000), "unknown");
  assert.equal(await readTurn(() => new Promise(() => {}), "claude", 1000, 5), "unknown");
  const tail = jsonl(assistant("end_turn", [{ type: "text", text: "Done." }]));
  assert.equal(await readTurn(async () => ({ tail, now: NOW }), "claude", 60_000), "finished");
});

test("the local tail is the newest record's end, and empty when there is none", async () => {
  const home = scratchDir("turn-home-");
  assert.equal(await latestTranscriptTail("/repo", home), "");
  const dir = join(home, ".claude", "projects", projectSlug("/repo"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "old.jsonl"), "old\n");
  utimesSync(join(dir, "old.jsonl"), new Date(1000), new Date(1000));
  writeFileSync(join(dir, "new.jsonl"), `${"x".repeat(600_000)}\nnew\n`);
  const tail = await latestTranscriptTail("/repo", home);
  assert.equal(tail.length, 500_000);
  assert.ok(tail.endsWith("\nnew\n"));
});

test("the Codex tail comes through the same lookup the board uses", async () => {
  const home = scratchDir("turn-home-");
  assert.equal(await latestCodexRollout("/repo", home), undefined);
  const dir = join(home, ".codex", "sessions", "2026", "11", "03");
  mkdirSync(dir, { recursive: true });
  const rollout = jsonl({ timestamp: stamp(), type: "session_meta", payload: { id: "i", cwd: "/repo" } }, started, complete({ last_agent_message: "Done." }));
  writeFileSync(join(dir, "rollout-a.jsonl"), rollout);
  assert.equal(turnEnd("codex", (await latestCodexRollout("/repo", home))!, NOW, 60_000), "finished");
});

import { test } from "node:test";
import assert from "node:assert/strict";

import { chatFrom, inlineRuns, markdownBlocks } from "./chat.ts";
import { parseTranscript } from "../workflow/transcript.ts";
import { parseCodexRollout } from "../workflow/codex.ts";

const at = (s: number) => `2026-10-22T08:00:${String(s).padStart(2, "0")}.000Z`;
const longReply = "Done. " + "The login timeout was the expiry check comparing seconds to milliseconds. ".repeat(6);

// A Claude Code session as its jsonl records it.
const claude = [
  { type: "user", timestamp: at(0), message: { content: "로그인이 가끔 실패해. 고쳐줘" } },
  { type: "assistant", timestamp: at(1), message: { content: [{ type: "text", text: "Looking at the auth code first." }] } },
  { type: "assistant", timestamp: at(2), message: { content: [{ type: "tool_use", id: "a", name: "Read", input: { file_path: "C:/w/auth.ts" } }] } },
  { type: "assistant", timestamp: at(3), message: { content: [{ type: "tool_use", id: "b", name: "Edit", input: { file_path: "C:/w/auth.ts" } }] } },
  { type: "assistant", timestamp: at(4), message: { content: [{ type: "tool_use", id: "c", name: "Edit", input: { file_path: "C:/w/auth.ts" } }] } },
  { type: "assistant", timestamp: at(5), message: { content: [{ type: "tool_use", id: "d", name: "Write", input: { file_path: "C:/w/auth.test.ts" } }] } },
  { type: "assistant", timestamp: at(6), message: { content: [{ type: "tool_use", id: "e", name: "Bash", input: { command: "npm test" } }] } },
  { type: "assistant", timestamp: at(7), message: { content: [{ type: "tool_use", id: "f", name: "Bash", input: { command: "npm run typecheck" } }] } },
  { type: "assistant", timestamp: at(8), message: { content: [{ type: "text", text: longReply }] } },
  { type: "user", timestamp: at(9), message: { content: "<command-name>/clear</command-name>" } },
].map((line) => JSON.stringify(line)).join("\n");

test("a Claude transcript becomes prompts, replies (whole) and one line per run of tools", () => {
  const chat = chatFrom(parseTranscript(claude, true).events);
  assert.deepEqual(chat.map((item) => item.kind), ["user", "agent", "tools", "agent"]);
  assert.deepEqual(chat[2], { kind: "tools", commands: 2, edits: 2, reads: 1, other: 0, at: Date.parse(at(2)) });
  assert.equal(chat[3]!.kind === "agent" && chat[3]!.text, longReply.trim(), "not clipped to the board's two lines");
  // The board still gets its short version.
  assert.ok(parseTranscript(claude).events.at(-1)!.kind === "note" && (parseTranscript(claude).events.at(-1) as { text: string }).text.length < 230);
});

// A Codex rollout, as 0.16x writes it.
const codex = [
  { timestamp: at(0), type: "event_msg", payload: { type: "item_completed", item: { type: "UserMessage", content: [{ text: "테스트 돌려줘" }] } } },
  { timestamp: at(1), type: "event_msg", payload: { type: "item_completed", item: { type: "CommandExecution", command: ["pwsh", "-c", "npm test"] } } },
  { timestamp: at(2), type: "event_msg", payload: { type: "item_completed", item: { type: "FileChange", changes: { "a.ts": { type: "update" }, "b.ts": { type: "add" } } } } },
  { timestamp: at(3), type: "event_msg", payload: { type: "item_completed", item: { type: "AgentMessage", content: [{ text: "All 12 tests pass." }] } } },
].map((line) => JSON.stringify(line)).join("\n");

test("a Codex rollout maps the same way", () => {
  assert.deepEqual(chatFrom(parseCodexRollout(codex, true).events), [
    { kind: "user", text: "테스트 돌려줘", at: Date.parse(at(0)) },
    { kind: "tools", commands: 1, edits: 2, reads: 0, other: 0, at: Date.parse(at(1)) },
    { kind: "agent", text: "All 12 tests pass.", at: Date.parse(at(3)) },
  ]);
});

test("a turn the operator stopped: its last row carries the mark, and tools keep their one line", () => {
  assert.deepEqual(chatFrom([
    { kind: "prompt", at: 1, text: "해 줘" },
    { kind: "note", at: 2, text: "보는 중." },
    { kind: "action", at: 3, text: "Bash", labels: ["Bash · ls"] },
    { kind: "action", at: 4, text: "Read a", labels: ["Read a"], cancelled: true },
    { kind: "prompt", at: 5, text: "다시" },
    { kind: "note", at: 6, text: "멈춤", cancelled: true },
  ]).map((item) => [item.kind, item.cancelled === true]), [["user", false], ["agent", false], ["tools", true], ["user", false], ["agent", true]]);
});

test("Markdown into blocks the page draws with textContent", () => {
  const blocks = markdownBlocks([
    "## 원인",
    "The check compared **seconds** to `ms`.",
    "",
    "- fixed `auth.ts`",
    "- added a test that",
    "  covers expiry",
    "1. run tests",
    "2. ship",
    "",
    "```ts",
    "if (now - created > TTL) {",
    "```",
    "> quoted <script>alert(1)</script>",
  ].join("\n"));
  assert.deepEqual(blocks, [
    { type: "h", text: "원인" },
    { type: "p", text: "The check compared **seconds** to `ms`." },
    { type: "list", ordered: false, items: ["fixed `auth.ts`", "added a test that covers expiry"] },
    { type: "list", ordered: true, items: ["run tests", "ship"] },
    { type: "code", text: "if (now - created > TTL) {" },
    { type: "quote", text: "quoted <script>alert(1)</script>" },
  ]);
  assert.deepEqual(inlineRuns("a `b` **c** <i>"), [
    { kind: "text", text: "a " }, { kind: "code", text: "b" }, { kind: "text", text: " " }, { kind: "bold", text: "c" }, { kind: "text", text: " <i>" },
  ]);
  // An unclosed fence keeps the rest as code rather than losing it.
  assert.deepEqual(markdownBlocks("```\nline"), [{ type: "code", text: "line" }]);
});

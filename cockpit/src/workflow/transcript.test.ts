import { test } from "node:test";
import assert from "node:assert/strict";

import { parseTranscript, projectSlug } from "./transcript.ts";

// The slug rule was read off the real directory Claude Code created for this
// very repository, not inferred from documentation.
test("a working directory maps to its transcript directory name", () => {
  assert.equal(projectSlug("C:\\Users\\admin\\projects\\lepons"), "C--Users-admin-projects-lepons");
  assert.equal(
    projectSlug("C:\\Users\\admin\\projects\\lepons\\.worktrees\\m0-probes"),
    "C--Users-admin-projects-lepons--worktrees-m0-probes",
  );
});

const line = (entry: unknown): string => JSON.stringify(entry);

const user = (content: unknown, extra: object = {}) => line({ type: "user", timestamp: "2026-08-04T01:00:00.000Z", message: { role: "user", content }, ...extra });
const says = (text: string) => line({ type: "assistant", timestamp: "2026-08-04T01:00:01.000Z", message: { content: [{ type: "text", text }] } });
const agent = (id: string) => line({ type: "assistant", timestamp: "2026-08-04T01:00:01.000Z", message: { content: [{ type: "tool_use", id, name: "Agent", input: { description: "scan" } }] } });
const back = (id: string, text: string) => user([{ type: "tool_result", tool_use_id: id, content: text }]);
const LAUNCH = "Async agent launched successfully. agentId: a1b2 (internal ID, do not mention)\noutput_file: x";

test('a background subagent read "Async agent launched successfully." as done: it runs until its notification', () => {
  const flow = (...rows: string[]) => parseTranscript([user("go"), agent("t1"), back("t1", LAUNCH), ...rows].join("\n")).events.at(1);
  assert.equal((flow() as { result?: string }).result, undefined, "launched is not finished");
  const byCall = flow(user("<task-notification><task-id>a1b2</task-id><tool-use-id>t1</tool-use-id><status>completed</status><summary>Agent done</summary><result>세 군데 찾았습니다.</result></task-notification>"));
  assert.deepEqual([(byCall as { result?: string }).result, typeof (byCall as { resultAt?: number }).resultAt], ["세 군데 찾았습니다.", "number"]);
  const byAgent = flow(user([{ type: "text", text: "<task-notification><task-id>a1b2</task-id><status>completed</status><result>찾았습니다.</result></task-notification>" }]));
  assert.equal((byAgent as { result?: string }).result, "찾았습니다.");
  const stopped = flow(user("<task-notification><task-id>a1b2</task-id><tool-use-id>t1</tool-use-id><status>killed</status><summary>Agent was stopped</summary></task-notification>"));
  assert.equal((stopped as { result?: string }).result, "Agent was stopped", "no result: what it says happened");
  const plain = flow(user("<task-notification><task-id>a1b2</task-id><status>completed</status><summary>Agent done</summary></task-notification>"));
  assert.equal((plain as { result?: string }).result, "", "finished, with nothing to say");
  const other = flow(user("<task-notification><task-id>zz</task-id><tool-use-id>t9</tool-use-id><result>not ours</result></task-notification>"));
  assert.equal((other as { result?: string }).result, undefined, "someone else's notification");
  assert.equal((parseTranscript([user("go"), agent("t1"), back("t1", "바로 끝났습니다.")].join("\n")).events.at(1) as { result?: string }).result, "바로 끝났습니다.", "one in the foreground comes back at once");
});

const queued = (prompt: unknown, origin: object | undefined) => line({ type: "attachment", timestamp: "2026-08-04T01:00:02.000Z", attachment: { type: "queued_command", prompt, ...(origin ? { origin } : {}) } });

test("what arrives while a turn runs is an attachment: a subagent read as running, and the goal stayed on the older ask", () => {
  const notification = "<task-notification><task-id>a1b2</task-id><status>completed</status><result>세 군데 찾았습니다.</result></task-notification>";
  const { events } = parseTranscript([user("go"), agent("t1"), back("t1", LAUNCH), queued(notification, { kind: "task-notification" }), says("끝.")].join("\n"));
  assert.equal((events.at(1) as { result?: string }).result, "세 군데 찾았습니다.");
  assert.deepEqual(events.map((e) => e.kind), ["prompt", "subagent", "note"], "a notification is no prompt");
  const asked = (...rows: string[]) => parseTranscript([user("옛 지시"), says("보고 있어요."), ...rows].join("\n")).events.filter((e) => e.kind === "prompt").map((e) => (e as { text: string }).text);
  assert.deepEqual(asked(queued("그거 말고 B로 해 줘", { kind: "human" })), ["옛 지시", "그거 말고 B로 해 줘"]);
  assert.deepEqual(asked(queued("다른 세션이 보낸 말", { kind: "peer" })), ["옛 지시"], "not the operator");
  assert.deepEqual(asked(line({ type: "attachment", attachment: { type: "todo_reminder" } })), ["옛 지시"]);
});

const PASTED = `<pasted_content id="p1">\n${"npm ERR! code 1\n".repeat(40)}</pasted_content id="p1">`;

test("what the operator said after a paste read as the paste, or went: the paste goes, and only a paste stays", () => {
  const prompt = (text: string, full = false) => (parseTranscript(user(text), full).events[0] as { text: string }).text;
  assert.equal(prompt(`${PASTED}\n\n이 오류 왜 나요?`), "이 오류 왜 나요?");
  assert.equal(prompt(`먼저 봐 줘\n${PASTED}\n그다음 고쳐 줘`), "먼저 봐 줘\n\n그다음 고쳐 줘");
  assert.ok(prompt(PASTED).startsWith('<pasted_content id="p1">\nnpm ERR!'), "only a paste: the paste, clipped");
  assert.ok(prompt(`${PASTED}\n\n이 오류 왜 나요?`, true).includes("npm ERR!"), "the phone's conversation keeps all of it");
});

test('the goal read "This session is being continued…" after a compaction: the summary is not a prompt', () => {
  const { events } = parseTranscript([user("장바구니 고쳐 줘"), user("This session is being continued from a previous conversation.", { isCompactSummary: true, isVisibleInTranscriptOnly: true }), says("고쳤습니다.")].join("\n"));
  assert.deepEqual(events.map((e) => [e.kind, (e as { text?: string }).text]), [["prompt", "장바구니 고쳐 줘"], ["note", "고쳤습니다."]]);
});

test("a slash command or a paste kept the last turn's goal: both are the operator speaking", () => {
  const prompts = (content: string) => parseTranscript([user("옛 지시"), says("끝."), user(content)].join("\n")).events.filter((e) => e.kind === "prompt").map((e) => (e as { text: string }).text);
  assert.deepEqual(prompts("<command-message>review</command-message>\n<command-name>/review</command-name>\n<command-args>src/cart.ts</command-args>"), ["옛 지시", "/review src/cart.ts"]);
  assert.deepEqual(prompts("<command-message>review</command-message>\n<command-name>/review</command-name>"), ["옛 지시", "/review"]);
  assert.deepEqual(prompts('<pasted_content id="p1">\nnpm ERR!'), ["옛 지시", '<pasted_content id="p1">\nnpm ERR!']);
  assert.deepEqual(prompts("<command-name>/model</command-name>\n<command-message>model</command-message>"), ["옛 지시"], "a local command stays out");
  assert.deepEqual(prompts("<local-command-stdout>ok</local-command-stdout>"), ["옛 지시"]);
});

test("a turn longer than the kept story still has its prompt", () => {
  const { events } = parseTranscript([user("긴 작업"), ...Array.from({ length: 100 }, (_, i) => says(`step ${i}.`))].join("\n"));
  assert.deepEqual([events[0]?.kind, (events[0] as { text?: string }).text, events.length], ["prompt", "긴 작업", 81]);
});

test("prompts, narration, and subagent dispatch/result come through in order", () => {
  const jsonl = [
    line({ type: "ai-title", aiTitle: "테스트 세션" }),
    line({
      type: "user",
      timestamp: "2026-08-04T01:00:00.000Z",
      message: { role: "user", content: "지도를 고쳐줘" },
    }),
    line({
      type: "assistant",
      timestamp: "2026-08-04T01:00:05.000Z",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "코드부터 읽겠습니다." },
          {
            type: "tool_use",
            id: "toolu_1",
            name: "Agent",
            input: { description: "QA 검증", prompt: "지도를 실제로 클릭해서 검증해라", subagent_type: "general-purpose" },
          },
        ],
      },
    }),
    line({
      type: "user",
      timestamp: "2026-08-04T01:02:00.000Z",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "검증 완료, 이상 없음" }],
      },
    }),
  ].join("\n");

  const flow = parseTranscript(jsonl);
  assert.equal(flow.title, "테스트 세션");
  assert.equal(flow.events.length, 3);

  const [prompt, note, agent] = flow.events;
  assert.deepEqual(prompt, { kind: "prompt", at: Date.parse("2026-08-04T01:00:00.000Z"), text: "지도를 고쳐줘" });
  assert.equal(note!.kind, "note");
  assert.equal((note as { text: string }).text, "코드부터 읽겠습니다.");
  assert.equal(agent!.kind, "subagent");
  const dispatched = agent as { description: string; instructions: string; agentType?: string; result?: string; resultAt?: number };
  assert.equal(dispatched.description, "QA 검증");
  assert.equal(dispatched.instructions, "지도를 실제로 클릭해서 검증해라");
  assert.equal(dispatched.agentType, "general-purpose");
  assert.equal(dispatched.result, "검증 완료, 이상 없음");
  assert.equal(dispatched.resultAt, Date.parse("2026-08-04T01:02:00.000Z"));
});

test("tag-shaped user entries and sidechain turns are not part of the story", () => {
  const jsonl = [
    line({ type: "user", message: { content: "<task-notification>...</task-notification>" } }),
    line({ type: "user", isSidechain: true, message: { content: "서브에이전트 내부 프롬프트" } }),
    line({
      type: "assistant",
      isSidechain: true,
      message: { content: [{ type: "text", text: "서브에이전트 내부 응답" }] },
    }),
    line({ type: "queue-operation", operation: "enqueue", content: "무관한 큐 항목" }),
  ].join("\n");

  assert.deepEqual(parseTranscript(jsonl).events, []);
});

test("a result arriving as text blocks is flattened; a missing result stays open", () => {
  const jsonl = [
    line({
      type: "assistant",
      timestamp: "2026-08-04T01:00:00.000Z",
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", id: "toolu_a", name: "Task", input: { description: "빌드", prompt: "빌드해라" } },
          { type: "tool_use", id: "toolu_b", name: "Task", input: { description: "테스트", prompt: "테스트해라" } },
        ],
      },
    }),
    line({
      type: "user",
      timestamp: "2026-08-04T01:01:00.000Z",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_a",
            content: [{ type: "text", text: "빌드 성공" }, { type: "text", text: "0 warnings" }],
          },
        ],
      },
    }),
  ].join("\n");

  const events = parseTranscript(jsonl).events as Array<{ description: string; result?: string }>;
  assert.equal(events.length, 2);
  assert.equal(events[0]!.result, "빌드 성공\n0 warnings");
  assert.equal(events[1]!.result, undefined);
});

test("tool calls pool into one action row, flushed when narration resumes", () => {
  const jsonl = [
    line({
      type: "assistant",
      timestamp: "2026-08-04T01:00:00.000Z",
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", id: "t1", name: "Edit", input: { file_path: "C:\\repo\\src\\map.ts" } },
          { type: "tool_use", id: "t2", name: "Bash", input: { command: "npm test", description: "테스트 실행" } },
          { type: "tool_use", id: "t3", name: "Edit", input: { file_path: "C:\\repo\\src\\map.ts" } },
          { type: "tool_use", id: "t4", name: "TaskUpdate", input: { taskId: 1 } },
        ],
      },
    }),
    line({
      type: "assistant",
      timestamp: "2026-08-04T01:01:00.000Z",
      message: { role: "assistant", content: [{ type: "text", text: "수정 완료." }] },
    }),
  ].join("\n");

  const events = parseTranscript(jsonl).events;
  assert.equal(events.length, 2);
  assert.deepEqual(events[0], {
    kind: "action",
    at: Date.parse("2026-08-04T01:00:00.000Z"),
    text: "Edit map.ts  ·  Bash · 테스트 실행",
    labels: ["Edit map.ts", "Bash · 테스트 실행", "Edit map.ts"],
  });
  assert.equal(events[1]!.kind, "note");
});

test("long text clips at a sentence boundary, not mid-word", () => {
  const first = "이 문장은 온전히 살아남아야 한다.";
  const jsonl = line({
    type: "assistant",
    timestamp: "2026-08-04T01:00:00.000Z",
    message: { role: "assistant", content: [{ type: "text", text: first + " " + "긴 설명 ".repeat(60) }] },
  });
  const note = parseTranscript(jsonl).events[0] as { text: string };
  assert.ok(note.text.startsWith(first), "the first full sentence survives");
  assert.ok(note.text.endsWith("…"));
  assert.ok(note.text.length <= 221);
});

test("malformed lines are skipped without losing the rest", () => {
  const jsonl = [
    "not json at all {",
    line({ type: "user", timestamp: "2026-08-04T01:00:00.000Z", message: { content: "정상 프롬프트" } }),
  ].join("\n");
  const flow = parseTranscript(jsonl);
  assert.equal(flow.events.length, 1);
  assert.equal((flow.events[0] as { text: string }).text, "정상 프롬프트");
});

test("metadata strings are not shown as user messages", () => {
  const at = "2026-08-04T01:00:00.000Z";
  const jsonl = [
    line({ type: "user", timestamp: at, isMeta: true, message: { content: "Automatically injected instructions" } }),
    line({ type: "user", timestamp: at, message: { content: "An actual user request" } }),
  ].join("\n");
  assert.deepEqual(parseTranscript(jsonl, true).events.map((e) => e.kind === "prompt" ? e.text : ""), ["An actual user request"]);
});

test("a prompt sent with an image starts a turn; tool results and interruptions do not", () => {
  const at = "2026-08-04T01:00:00.000Z";
  const jsonl = [
    line({ type: "user", timestamp: at, message: { content: [{ type: "image", source: {} }, { type: "text", text: "이 화면 고쳐 줘" }] } }),
    line({ type: "user", timestamp: at, message: { content: [{ type: "image", source: {} }] } }),
    line({ type: "user", timestamp: at, message: { content: [{ type: "text", text: "[Request interrupted by user]" }] } }),
    line({ type: "user", timestamp: at, isMeta: true, message: { content: [{ type: "text", text: "Caveat: meta" }] } }),
    line({ type: "user", timestamp: at, message: { content: [{ type: "tool_result", tool_use_id: "x", content: "ok" }] } }),
  ].join("\n");
  // The image-only prompt was cancelled before any answer: it goes.
  assert.deepEqual(parseTranscript(jsonl).events.map((e) => (e as { text: string }).text), ["이 화면 고쳐 줘"]);
});

// Rows in the order real records have them, as counted across local Claude Code
// 2.1.268-2.1.317 records (row types and fields only); the words are made up.
const row = (type: string, at: number, fields: object) => line({ parentUuid: "p", isSidechain: false, version: "2.1.317", type, timestamp: new Date(1_800_000_000_000 + at * 1000).toISOString(), ...fields });
const said = (at: number, text: string, fields: object = {}) => row("user", at, { message: { role: "user", content: text }, promptId: "x", origin: { kind: "human" }, promptSource: "typed", ...fields });
const mark = (at: number, text = "[Request interrupted by user]") => row("user", at, { message: { role: "user", content: [{ type: "text", text }] } });
const replied = (at: number, content: object[], stop = "end_turn") => row("assistant", at, { message: { role: "assistant", content, stop_reason: stop } });
const paperwork = (at: number) => [
  row("attachment", at, { attachment: { type: "x" } }),
  line({ type: "last-prompt", lastPrompt: "x", sessionId: "s" }),
  line({ type: "file-history-snapshot" }),
  line({ type: "api-request", id: "r", timestamp: new Date(1_800_000_000_000 + at * 1000).toISOString() }),
];
const texts = (jsonl: string) => parseTranscript(jsonl, true).events.map((e) => (e as { text: string }).text);

test("a prompt cancelled before any answer goes, and the corrected one stands alone", () => {
  assert.deepEqual(texts([said(0, "틀린 지시", { uuid: "a" }), ...paperwork(0), mark(2), line({ type: "cost-state" }), said(9, "고친 지시"), replied(12, [{ type: "text", text: "네." }])].join("\n")), ["고친 지시", "네."]);
  assert.deepEqual(texts([said(0, "틀린 지시"), replied(1, [{ type: "thinking", thinking: "" }], "tool_use"), mark(2)].join("\n")), [], "thinking is no answer");
});

test("tools the story leaves out are still work: the prompt stays, and the mark has a row to sit on", () => {
  const events = parseTranscript([
    said(0, "돌려 줘"),
    replied(1, [{ type: "tool_use", id: "t", name: "PowerShell", input: { command: "npm test" } }], "tool_use"),
    row("user", 2, { message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", is_error: true, content: "x" }] } }),
    mark(2, "[Request interrupted by user for tool use]"),
    said(3, "다시"),
  ].join("\n"), true).events;
  assert.deepEqual(events.map((e) => [e.kind, (e as { text: string }).text, e.kind !== "prompt" && e.cancelled === true]), [
    ["prompt", "돌려 줘", false], ["action", "PowerShell", true], ["prompt", "다시", false],
  ]);
  assert.deepEqual(texts([said(0, "먼저"), replied(1, [{ type: "tool_use", id: "t", name: "PowerShell", input: {} }], "tool_use"), said(2, "다음", { parentUuid: "t" }), mark(3)].join("\n")), ["먼저"], "the work was the turn before");
});

test("cancelled so soon that no mark is written: the next prompt takes the same parent, and the first goes", () => {
  const corrected = [said(0, "틀린 지시", { uuid: "a", parentUuid: "root" }), ...paperwork(0), said(7, "고친 지시", { parentUuid: "root" }), replied(9, [{ type: "text", text: "네." }])];
  assert.deepEqual(texts(corrected.join("\n")), ["고친 지시", "네."]);
  assert.deepEqual(texts([said(0, "첫 지시", { uuid: "a", parentUuid: null }), said(7, "고친 지시", { parentUuid: null })].join("\n")), ["고친 지시"], "the first of a session has no parent");
  assert.deepEqual(texts([said(0, "첫째", { uuid: "a", parentUuid: "root" }), said(7, "둘째", { parentUuid: "a" })].join("\n")), ["첫째", "둘째"], "one after the other: both were sent");
  assert.deepEqual(texts(said(0, "아직 답이 없는 지시", { parentUuid: "root" })), ["아직 답이 없는 지시"], "nothing after it yet");
});

test("what a cancelled turn did stays, marked on its last row; the turn before it is untouched", () => {
  const events = parseTranscript([
    said(0, "먼저"), replied(1, [{ type: "text", text: "끝났습니다." }]),
    said(2, "이어서"), replied(3, [{ type: "text", text: "보는 중." }], "tool_use"), mark(4),
    said(5, "다시"), replied(6, [{ type: "tool_use", id: "t", name: "Read", input: { file_path: "C:/a.ts" } }], "tool_use"),
    row("user", 7, { message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", is_error: true, content: "x" }] } }),
    mark(7, "[Request interrupted by user for tool use]"),
    said(8, "또"), replied(9, [{ type: "tool_use", id: "a", name: "Agent", input: { description: "조사", prompt: "해" } }], "tool_use"), mark(10),
  ].join("\n"), true).events;
  assert.deepEqual(events.map((e) => [e.kind, e.kind !== "prompt" && e.cancelled === true]), [
    ["prompt", false], ["note", false], ["prompt", false], ["note", true], ["prompt", false], ["action", true], ["prompt", false], ["subagent", true],
  ]);
});

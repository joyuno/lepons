import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { zstdCompressSync } from "node:zlib";

import { findGitBash } from "../main/allow-ssh.ts";
import { codexItemsFromDb, codexModelList, codexRecordFromDb, cwdNeedle, earlierOnly, headBytes, latestCodexRollout, outputOf, parseCodexRollout, remoteCodexRecord, remoteRolloutListScript, remoteRolloutScript, rolloutId } from "./codex.ts";
import { remoteCodexPastScript } from "./past.ts";
import { OUTPUT_MARK } from "./held-record.ts";

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

// The shape of a rollout on the owner's Mac (2026-11-28), every text made up: its cwd decomposed (NFD), as a Mac keeps
// a Korean folder's name, while the path Lepons holds is composed.
const macRollout = readFileSync(join(import.meta.dirname, "fixtures", "codex-mac-rollout.jsonl"), "utf8");
const macFolder = "/Users/me/Downloads/메모";

test("a Mac's rollout reads as its prompt, its work and both its replies", () => {
  assert.deepEqual(parseCodexRollout(macRollout).events.map((event) => [event.kind, (event as { text?: string }).text]), [
    ["prompt", "메모 폴더의 할 일 목록을 정리해 줘"],
    ["action", "Shell · ls -la"],
    ["note", "목록을 먼저 읽어 볼게요."],
    ["action", "MCP node_repl.js  ·  Shell · cat todo.md"],
    ["note", "할 일 두 개를 정리했어요."],
  ]);
  assert.equal(parseCodexRollout(macRollout).model, "gpt-6-astra");
});

test("a folder whose name a Mac keeps decomposed finds its rollout, there and on this PC", { skip: !shell }, async () => {
  assert.notEqual(macFolder.normalize("NFD"), macFolder);
  const home = mkdtempSync(join(tmpdir(), "lepons-codex-"));
  try {
    const day = join(home, ".codex", "sessions", "2026", "11", "28");
    mkdirSync(day, { recursive: true });
    writeFileSync(join(day, "rollout-2026-11-28T13-23-12-0f1a2b3c-0000-7000-8000-00000000aa01.jsonl"), macRollout);
    const env = { ...process.env, HOME: home.replaceAll("\\", "/"), LC_ALL: "en_US.UTF-8" };
    for (const folder of [macFolder, macFolder.normalize("NFD")]) {
      assert.match(spawnSync(shell!, ["-c", remoteRolloutScript(folder)], { encoding: "utf8", env }).stdout, /할 일 두 개를 정리했어요/);
      assert.match(spawnSync(shell!, ["-c", remoteRolloutListScript(folder)], { encoding: "utf8", env }).stdout, /rollout-2026-11-28T13-23-12/);
      assert.match(spawnSync(shell!, ["-c", remoteCodexPastScript(folder)], { encoding: "utf8", env }).stdout, /@@ .*rollout-2026-11-28T13-23-12/);
    }
    assert.equal(spawnSync(shell!, ["-c", remoteRolloutScript("/Users/me/Downloads/메")], { encoding: "utf8", env }).stdout, "", "another folder's name is not a match");
    assert.match((await latestCodexRollout(macFolder, home)) ?? "", /할 일 두 개를 정리했어요/);
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

const ran = [
  done({ type: "UserMessage", content: [{ type: "text", text: "go" }] }),
  done({ type: "CommandExecution", command: ["/bin/bash", "-lc", "npm test\nmore"], status: "failed", exit_code: 1 }, "2026-10-14T05:00:05.000Z"),
  done({ type: "CommandExecution", command: ["/bin/bash", "-lc", "ls"], exit_code: 2 }, "2026-10-14T05:00:06.000Z"),
  done({ type: "FileChange", changes: { "/a/b/c.ts": { type: "update" }, "/a/NOTES.md": { type: "add" } }, status: "completed" }, "2026-10-14T05:00:07.000Z"),
  done({ type: "McpToolCall", server: "lepons", tool: "read_file" }, "2026-10-14T05:00:08.000Z"),
  done({ type: "Reasoning" }),
].join("\n");

test("a full read keeps each tool call's kind, target and result", () => {
  const action = parseCodexRollout(ran, true).events.find((event) => event.kind === "action");
  const at = (second: number) => Date.parse(`2026-10-14T05:00:0${second}.000Z`);
  assert.deepEqual(action?.kind === "action" && action.steps, [
    { tool: "command", target: "npm test", result: "failed", endAt: at(5) },
    { tool: "command", target: "ls", result: "failed", endAt: at(6) },
    { tool: "edit", target: "c.ts", result: "done", endAt: at(7) },
    { tool: "edit", target: "NOTES.md", result: "done", endAt: at(7) },
    { tool: "other", target: "MCP lepons.read_file", result: "done", endAt: at(8) },
  ]);
});

test("a full read keeps what a command printed, capped, for the chat's preview", () => {
  const record = [
    done({ type: "UserMessage", content: [{ type: "text", text: "go" }] }),
    done({ type: "CommandExecution", command: ["sh", "-c", "ls"], aggregated_output: `a.ts\n${"y".repeat(5000)}\n`, exit_code: 0 }),
  ].join("\n");
  const action = parseCodexRollout(record, true).events.find((event) => event.kind === "action");
  assert.equal(action?.kind === "action" && action.steps?.[0]?.output, `a.ts\n${"y".repeat(3995)}…`);
  assert.equal(outputOf("\n\n  ✓ one\n  ✓ two  \n"), "  ✓ one\n  ✓ two", "its first line keeps its indent, as the rest do");
});

test("a board read has no steps", () => {
  const action = parseCodexRollout(ran).events.find((event) => event.kind === "action");
  assert.equal(action?.kind === "action" && "steps" in action, false);
});

test("a declined call failed, and a full read starts a run when its first call started", () => {
  const one = [
    done({ type: "UserMessage", content: [{ type: "text", text: "go" }] }),
    done({ type: "CommandExecution", command: ["sh", "-c", "rm -rf x"], status: "declined", duration_ms: 3_000 }, "2026-10-14T05:00:05.000Z"),
  ].join("\n");
  const action = parseCodexRollout(one, true).events.find((event) => event.kind === "action");
  assert.deepEqual(action?.kind === "action" && [action.at, action.steps?.[0]?.result], [Date.parse("2026-10-14T05:00:02.000Z"), "failed"]);
  assert.equal(parseCodexRollout(one).events.find((event) => event.kind === "action")?.at, Date.parse("2026-10-14T05:00:05.000Z"), "the board keeps its times");
});

test("asked for older events, a record read only from its end gives those it holds and no more", () => {
  const workflow = { events: [{ kind: "prompt" as const, at: 1, text: "a" }, { kind: "prompt" as const, at: 5, text: "b" }] };
  assert.deepEqual(earlierOnly(workflow, 5), { events: [{ kind: "prompt", at: 1, text: "a" }], more: false });
  assert.equal(earlierOnly(workflow, undefined), workflow);
});

// Codex 0.169+: a session's items in ~/.codex/thread_history_1.sqlite, its rollout a head alone (fixtures/codex-history.json).
type HistoryRow = { turn_id: string; rollout_ordinal: number; created_at_ms: number; completed_at_ms: number | null; item: { type: string; id: string } };
const history = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "codex-history.json"), "utf8")) as {
  thread: string;
  turns: Array<{ turn_id: string; rollout_ordinal: number; status: string; started_at: number; completed_at: number }>;
  items: HistoryRow[];
};
const head = (id: string, base?: { thread_id: string; end_ordinal_exclusive: number }) => [
  JSON.stringify({ timestamp: "2026-11-26T00:00:00.000Z", ordinal: 0, type: "session_meta", payload: { id, session_id: id, cwd: "/w/app", cli_version: "0.172.0", history_mode: "paginated", ...(base ? { forked_from_id: base.thread_id, history_base: { ...base, end_byte_offset: 1 } } : {}) } }),
  JSON.stringify({ timestamp: "2026-11-26T00:00:00.000Z", ordinal: 1, type: "event_msg", payload: { type: "thread_settings_applied" } }),
].join("\n");
/** A home with Codex's history database holding the fixture's thread, its rows stored out of order. `old`: thread_items as the owner's Mac has it, no started_at_ms/completed_at_ms. */
function historyHome(old = false): { home: string; db: string; day: string } {
  const home = mkdtempSync(join(tmpdir(), "lepons-codex-db-"));
  const day = join(home, ".codex", "sessions", "2026", "11", "26");
  mkdirSync(day, { recursive: true });
  const db = join(home, ".codex", "thread_history_1.sqlite");
  const write = new DatabaseSync(db);
  write.exec(
    `CREATE TABLE thread_items (thread_id TEXT, turn_id TEXT, item_id TEXT, rollout_ordinal INTEGER, created_at_ms INTEGER, item_json TEXT, item_type TEXT, updated_at_ordinal INTEGER${old ? "" : ", started_at_ms INTEGER, completed_at_ms INTEGER"});` +
      "CREATE TABLE thread_turns (thread_id TEXT, turn_id TEXT, rollout_ordinal INTEGER, status TEXT, error_json TEXT, started_at INTEGER, completed_at INTEGER, duration_ms INTEGER);",
  );
  const item = write.prepare(`INSERT INTO thread_items VALUES (?, ?, ?, ?, ?, ?, ?, ?${old ? "" : ", NULL, ?"})`);
  for (const row of [...history.items].reverse()) {
    const values = [history.thread, row.turn_id, row.item.id, row.rollout_ordinal, row.created_at_ms, JSON.stringify(row.item), row.item.type, row.rollout_ordinal];
    item.run(...values, ...(old ? [] : [row.completed_at_ms]));
  }
  const turn = write.prepare("INSERT INTO thread_turns VALUES (?, ?, ?, ?, NULL, ?, ?, ?)");
  for (const row of history.turns) turn.run(history.thread, row.turn_id, row.rollout_ordinal, row.status, row.started_at, row.completed_at, (row.completed_at - row.started_at) * 1000);
  write.close();
  return { home, db, day };
}
const rolloutName = (id: string) => `rollout-2026-11-26T00-00-00-${id}.jsonl`;
const readStory = (jsonl: string | undefined) =>
  parseCodexRollout(jsonl ?? "").events.map((e) => [e.kind, (e as { text?: string }).text, e.kind !== "prompt" && e.cancelled === true]);
const firstTurn = [
  ["prompt", "fix the login bug", false],
  ["action", "Shell · npm test  ·  Edit login.ts  ·  Write NOTES.md", false],
  ["note", "Fixed; tests pass.", false],
];

test("a 0.172 rollout with no items reads its thread from the history db", async () => {
  const { home, day } = historyHome();
  try {
    const rollout = head(history.thread);
    writeFileSync(join(day, rolloutName(history.thread)), rollout);
    assert.deepEqual(readStory(await codexRecordFromDb(rollout, home)), [...firstTurn, ["prompt", "now the signup page", false], ["action", "Shell · ls", true]]);
    assert.equal(await codexRecordFromDb(done({ type: "AgentMessage", content: [{ text: "x" }] }), home), undefined, "a rollout with items of its own is read as it is");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("an older history db, its items with no completed_at_ms, reads here and on a node", async (t) => {
  const { home, day } = historyHome(true);
  try {
    const rollout = head(history.thread);
    writeFileSync(join(day, rolloutName(history.thread)), rollout);
    const expected = [...firstTurn, ["prompt", "now the signup page", false], ["action", "Shell · ls", true]];
    assert.deepEqual(readStory(await codexRecordFromDb(rollout, home)), expected);
    if (!shell || spawnSync(shell, ["-c", "python3 -c 'import sqlite3'"]).status !== 0) return t.skip("the node half: no python3 here");
    const run = async (script: string) => spawnSync(shell!, ["-c", script], { encoding: "utf8", env: { ...process.env, HOME: home.replaceAll("\\", "/") } }).stdout;
    assert.deepEqual(readStory(await remoteCodexRecord(rollout, "pc::/w/old", run) as string), expected);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a resumed session reads the thread it continues, up to where it forked, from a packed rollout too", async () => {
  const { home, day } = historyHome();
  try {
    const fork = "0b000000-0000-4000-8000-000000000002";
    const resumed = head(fork, { thread_id: history.thread, end_ordinal_exclusive: 11 });
    writeFileSync(join(day, rolloutName(fork)), resumed);
    writeFileSync(join(day, `${rolloutName(history.thread)}.zst`), zstdCompressSync(head(history.thread)));
    assert.deepEqual(readStory(await codexRecordFromDb(resumed, home)), firstTurn);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("command as a string and changes as an array are read", async () => {
  const { home, db } = historyHome();
  try {
    const entries = await codexItemsFromDb(db, history.thread);
    const action = parseCodexRollout((entries ?? []).map((entry) => JSON.stringify(entry)).join("\n"), true).events.find((event) => event.kind === "action");
    assert.deepEqual(action?.kind === "action" && [action.at, action.labels, action.steps], [
      1795000002000,
      ["Shell · npm test", "Edit login.ts", "Write NOTES.md"],
      [
        { tool: "command", target: "npm test", result: "failed", endAt: 1795000005000, output: "1 failing" },
        { tool: "edit", target: "login.ts", result: "done", endAt: 1795000006000 },
        { tool: "edit", target: "NOTES.md", result: "done", endAt: 1795000006000 },
      ],
    ]);
    const board = parseCodexRollout(done({ type: "FileChange", changes: [{ path: "/w/a.ts", kind: { type: "add" } }] })).events[0];
    assert.deepEqual(board?.kind === "action" && [board.text, board.paths], ["Write a.ts", ["/w/a.ts"]]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("an unchanged db is not opened again, and a changed one is read again", async () => {
  const { home, db, day } = historyHome();
  try {
    const rollout = head(history.thread);
    writeFileSync(join(day, rolloutName(history.thread)), rollout);
    const first = await codexRecordFromDb(rollout, home);
    assert.ok(first);
    const holder = new DatabaseSync(db);
    holder.exec("BEGIN EXCLUSIVE");
    try {
      assert.equal(await codexRecordFromDb(rollout, home), first, "a locked db would read as nothing: this is the kept one");
    } finally {
      holder.exec("ROLLBACK");
    }
    holder.prepare("INSERT INTO thread_items (thread_id, turn_id, rollout_ordinal, created_at_ms, item_json, item_type) VALUES (?, 'u3', 20, 1795000200000, ?, 'userMessage')")
      .run(history.thread, JSON.stringify({ type: "userMessage", id: "i9", content: [{ type: "text", text: "one more thing" }] }));
    holder.close();
    assert.equal(readStory(await codexRecordFromDb(rollout, home)).at(-1)?.[1], "one more thing");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a chain of resumes that comes back on itself is read once", async () => {
  const { home, day } = historyHome();
  try {
    const fork = "0c000000-0000-4000-8000-000000000003";
    const resumed = head(fork, { thread_id: history.thread, end_ordinal_exclusive: 11 });
    writeFileSync(join(day, rolloutName(fork)), resumed);
    writeFileSync(join(day, rolloutName(history.thread)), head(history.thread, { thread_id: fork, end_ordinal_exclusive: 1000 }));
    assert.deepEqual(readStory(await codexRecordFromDb(resumed, home)), firstTurn);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// As over SSH: Git Bash with this PC's python3 standing in for a node's (sqlite3's CLI is not here), banner and all.
const python = shell !== undefined && spawnSync(shell, ["-c", "python3 -c 'import sqlite3'"]).status === 0;
test("on a node, a 0.172 session and the thread it continues are read from its history db, read-only, and not again while it stands", { skip: !python }, async () => {
  const { home, db, day } = historyHome();
  try {
    const fork = "0d000000-0000-4000-8000-000000000004";
    const resumed = head(fork, { thread_id: history.thread, end_ordinal_exclusive: 11 });
    writeFileSync(join(day, rolloutName(fork)), resumed);
    writeFileSync(join(day, rolloutName(history.thread)), head(history.thread));
    const scripts: string[] = [];
    const run = async (script: string) => {
      scripts.push(script);
      const ran = spawnSync(shell!, ["-c", script], { encoding: "utf8", env: { ...process.env, HOME: home.replaceAll("\\", "/") } });
      return `Welcome to the node\n${ran.stdout}`;
    };
    const before = readFileSync(db);
    assert.deepEqual(readStory(await remoteCodexRecord(resumed, "pc::/w/app", run) as string), firstTurn);
    assert.deepEqual(readStory(await remoteCodexRecord(head(history.thread), "pc::/w/app", run) as string).at(-1), ["action", "Shell · ls", true]);
    assert.ok(readFileSync(db).equals(before), "the db is never written");
    // Unchanged since: the script says so and nothing more comes.
    const again = await remoteCodexRecord(resumed, "pc::/w/app", run);
    assert.deepEqual(readStory(again as string), firstTurn);
    assert.match(scripts.at(-1)!, /SAME/);
    // A node with neither reader says so.
    assert.equal(await remoteCodexRecord(head("0e000000-0000-4000-8000-000000000005"), "pc::/w/app", async () => `banner\n${OUTPUT_MARK}\nNOREADER\n`), "no_reader");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("on a node, a changed db brings only the rows after the newest held, a turn's new state with them", { skip: !python }, async () => {
  const { home, db, day } = historyHome();
  let write: DatabaseSync | undefined;
  try {
    const rollout = head(history.thread);
    writeFileSync(join(day, rolloutName(history.thread)), rollout);
    const sent: string[] = [];
    const run = async (script: string) => {
      const ran = spawnSync(shell!, ["-c", script], { encoding: "utf8", env: { ...process.env, HOME: home.replaceAll("\\", "/") } });
      sent.push(ran.stdout);
      return ran.stdout;
    };
    const story = async () => readStory(await remoteCodexRecord(rollout, "pc::/w/inc", run) as string);
    assert.equal((await story()).length, 5);
    write = new DatabaseSync(db);
    const shellItem = history.items.find((row) => row.item.type === "commandExecution")!.item;
    write.prepare("INSERT INTO thread_turns VALUES (?, 'u3', 19, 'inProgress', NULL, 1795000200, NULL, NULL)").run(history.thread);
    const item = write.prepare("INSERT INTO thread_items VALUES (?, 'u3', ?, ?, ?, ?, ?, ?, NULL, ?)");
    item.run(history.thread, "i20", 20, 1795000200000, JSON.stringify({ type: "userMessage", id: "i20", content: [{ type: "text", text: "one more thing" }] }), "userMessage", 20, 1795000200000);
    item.run(history.thread, "i21", 21, 1795000201000, JSON.stringify({ ...shellItem, id: "i21" }), "commandExecution", 21, 1795000202000);
    const grown = await story();
    assert.deepEqual(grown.slice(0, 5), (await (async () => readStory(await codexRecordFromDb(rollout, home)))()).slice(0, 5), "what was held stays");
    assert.deepEqual(grown.slice(5).map((event) => event.slice(0, 2)), [["prompt", "one more thing"], ["action", "Shell · npm test"]]);
    assert.equal(grown.at(-1)![2], false, "still going");
    assert.doesNotMatch(sent.at(-1)!, /fix the login bug/, "the held rows did not come again");
    // Only the turn's state moved (stopped): the newest row comes again with it.
    write.prepare("UPDATE thread_turns SET status = 'interrupted', completed_at = 1795000210 WHERE turn_id = 'u3'").run();
    write.close();
    write = undefined;
    assert.equal((await story()).at(-1)![2], true, "the turn read as stopped");
    assert.equal((sent.at(-1)!.match(/"item_json"/g) ?? []).length, 1);
  } finally {
    write?.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("a broken item row is skipped and the rest are read", async () => {
  const { home, db } = historyHome();
  try {
    const write = new DatabaseSync(db);
    write.prepare("INSERT INTO thread_items (thread_id, turn_id, rollout_ordinal, created_at_ms, item_json, item_type) VALUES (?, 'u1', 6, 1795000001800, '{not json', 'agentMessage')").run(history.thread);
    write.close();
    const entries = await codexItemsFromDb(db, history.thread);
    assert.deepEqual(readStory((entries ?? []).map((entry) => JSON.stringify(entry)).join("\n")).slice(0, 3), firstTurn);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a missing or locked db leaves the record as it was", async () => {
  const { home, db, day } = historyHome();
  try {
    const rollout = head(history.thread);
    writeFileSync(join(day, rolloutName(history.thread)), rollout);
    assert.equal(await codexItemsFromDb(join(home, "nowhere.sqlite"), history.thread), undefined);
    const holder = new DatabaseSync(db);
    holder.exec("BEGIN EXCLUSIVE");
    try {
      assert.equal(await codexItemsFromDb(db, history.thread), undefined);
      assert.equal(await codexRecordFromDb(rollout, home), undefined);
    } finally {
      holder.exec("ROLLBACK");
      holder.close();
    }
    rmSync(db);
    assert.equal(await codexRecordFromDb(rollout, home), undefined);
    assert.deepEqual(parseCodexRollout(rollout).events, [], "as today: an empty record");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("the record names the model", () => {
  // Codex 0.154 writes a turn_context each turn; 0.171 a thread_settings_applied when the thread's settings are set (both read on this PC).
  assert.equal(parseCodexRollout([line("turn_context", { model: "gpt-5.5" }), line("turn_context", { model: "gpt-5.6" })].join("\n")).model, "gpt-5.6");
  assert.equal(parseCodexRollout(line("event_msg", { type: "thread_settings_applied", thread_settings: { model: "gpt-6.1-sol" } })).model, "gpt-6.1-sol");
  assert.equal("model" in parseCodexRollout(line("event_msg", { type: "task_started" })), false);
});

test("Codex's model list is its cache's listed models, in its own order", () => {
  const cache = JSON.stringify({
    fetched_at: "2026-11-27T15:51:05Z",
    models: [
      { slug: "gpt-6.1-sol", display_name: "GPT-6.1-Sol", visibility: "list", priority: 5 },
      { slug: "gpt-reserve", display_name: "GPT-Reserve", visibility: "hide", priority: 4 },
      { slug: "gpt-6.2-sol", display_name: "GPT-6.2-Sol", visibility: "list", priority: 1 },
      { slug: "odd name; rm -rf /", display_name: "Bad", visibility: "list", priority: 2 },
      { slug: "-x", display_name: "A flag", visibility: "list", priority: 3 },
      { slug: "gpt-6-luna", visibility: "list", priority: 8 },
    ],
  });
  assert.deepEqual(codexModelList(cache), [
    { slug: "gpt-6.2-sol", name: "GPT-6.2-Sol" },
    { slug: "gpt-6.1-sol", name: "GPT-6.1-Sol" },
    { slug: "gpt-6-luna", name: "gpt-6-luna" },
  ], "hidden ones out, a slug no command line can take out, by priority, the slug when it has no name");
  assert.equal(codexModelList("{not json"), undefined);
  assert.equal(codexModelList(JSON.stringify({ models: [] })), undefined, "none listed: the terminal's picker, as before");
});

test("a rollout's thread id is its session_meta's, when its first line is whole", () => {
  const id = "01a21dd3-4915-7eb3-82ae-3f3996a3b25f";
  const meta = JSON.stringify({ timestamp: "2026-11-26T00:00:00.000Z", type: "session_meta", payload: { id, cwd: "/w/app" } });
  assert.equal(rolloutId(`${meta}\n{"type":"event_msg"}`), id);
  // Codex 0.172 names the thread on each item it completes: a tail that cut the first line still has those.
  const item = (thread: string) => JSON.stringify({ type: "event_msg", payload: { type: "item_completed", thread_id: thread, turn_id: "t" } });
  const other = "11111111-2222-4333-8444-555555555555";
  assert.equal(rolloutId(`ion_meta","payload":{"id":"${id}"}}\n${item(id)}\n{"type":"event_msg","payload":{"type":"x","agent_thread_id":"${other}"}}`), id);
  assert.equal(rolloutId(`ion_meta","payload":{"id":"${id}"}}\n{"type":"event_msg"}`), undefined, "a cut first line and nothing naming the thread");
  assert.equal(rolloutId(JSON.stringify({ type: "session_meta", payload: { id: "not-an-id" } })), undefined);
});

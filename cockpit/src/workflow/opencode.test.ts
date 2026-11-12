import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { parseOpencodeExport, pickOpencodeSession } from "./opencode.ts";
import { turnEnd, turnOver } from "./turn.ts";

// Real `opencode export` output (OpenCode 1.19.5), see fixtures/.
const fixture = (name: string) => readFileSync(join(import.meta.dirname, "fixtures", `opencode-${name}.json`), "utf8");
/** Each fixture's newest time, as the machine's clock when it was taken. */
const BUSY_AT = 1794362593341;
const ASKING_AT = 1794362647288;
const FINISHED_AT = 1794362675826;

test("OpenCode: a command running and reporting output is busy, not asking", () => {
  assert.equal(turnEnd("opencode", fixture("busy"), BUSY_AT, 30_000), "busy");
  assert.equal(turnOver("opencode", fixture("busy")), false);
  // Its epoch-ms stamp is read as a time: long before this work, it is not this work's.
  assert.equal(turnEnd("opencode", fixture("busy"), BUSY_AT + 3_600_000, 30_000), "quiet");
});

test("OpenCode: a call left running with nothing reported under a quiet is a permission prompt", () => {
  assert.equal(turnEnd("opencode", fixture("asking"), ASKING_AT, 30_000), "waiting");
  assert.equal(turnOver("opencode", fixture("asking")), false);
});

/** A record's newest message time, as the clock when it was taken. */
const takenAt = (text: string): number => {
  const time = (JSON.parse(text) as { messages: Array<{ info: { time: { created: number; completed?: number } } }> }).messages.at(-1)!.info.time;
  return (time.completed ?? time.created) + 1000;
};

test("OpenCode, live records: a silent command runs, a command's prompt asks, Esc on it stops", () => {
  // Start-Sleep prints nothing, yet its running call already holds metadata { output: "" }.
  assert.equal(turnEnd("opencode", fixture("busy-silent"), takenAt(fixture("busy-silent")), 120_000), "busy");
  // A bash call held for permission has no metadata at all.
  assert.equal(turnEnd("opencode", fixture("asking-bash"), takenAt(fixture("asking-bash")), 120_000), "waiting");
  assert.equal(turnEnd("opencode", fixture("rejected"), takenAt(fixture("rejected")), 120_000), "stopped");
  assert.equal(turnOver("opencode", fixture("rejected")), true);
});

test("OpenCode: a last step finished with stop ends the turn", () => {
  assert.equal(turnEnd("opencode", fixture("finished"), FINISHED_AT, 30_000), "finished");
  assert.equal(turnOver("opencode", fixture("finished")), true);
});

test("OpenCode: the other ways a turn ends", () => {
  const session = (...messages: object[]) => JSON.stringify({ info: {}, messages });
  const at = { created: FINISHED_AT };
  const said = (text: string) => ({ info: { role: "assistant", time: at }, parts: [{ type: "text", text }, { type: "step-finish", reason: "stop" }] });
  const judge = (tail: string) => turnEnd("opencode", tail, FINISHED_AT, 30_000);
  assert.equal(judge(session(said("Which one should I keep?"))), "waiting");
  assert.equal(judge(session({ info: { role: "user", time: at }, parts: [{ type: "text", text: "do it" }] })), "stopped");
  assert.equal(judge(session({ info: { role: "assistant", time: at }, parts: [{ type: "step-finish", reason: "tool-calls" }] })), "busy");
  const aborted = session({ info: { role: "assistant", time: at, error: { name: "MessageAbortedError", data: {} } }, parts: [] });
  assert.equal(judge(aborted), "stopped");
  assert.equal(turnOver("opencode", aborted), true);
  assert.equal(judge(session({ info: { role: "assistant", time: at, error: { name: "APIError" } }, parts: [] })), "unknown");
  const refused = { type: "tool", tool: "edit", state: { status: "error", input: {}, error: "The user rejected permission to use this specific tool call." } };
  assert.equal(judge(session({ info: { role: "assistant", time: at }, parts: [refused, { type: "step-finish", reason: "tool-calls" }] })), "stopped");
  assert.equal(judge("not json"), "quiet");
  assert.equal(judge(session()), "quiet");
});

test("OpenCode: a session reads as prompts, notes, pooled actions with the files changed", () => {
  const { title, events } = parseOpencodeExport(fixture("finished"));
  assert.equal(title, "Ping localhost with 25 packets");
  assert.deepEqual(events.map((event) => event.kind), ["prompt", "note", "action", "note", "prompt", "action", "note"]);
  assert.equal(events[0]!.kind === "prompt" && events[0]!.text, "Run the shell command: ping -n 25 127.0.0.1");
  assert.equal(events[2]!.kind === "action" && events[2]!.text, "Bash · ping -n 25 127.0.0.1");
  const edits = events[5]!;
  assert.equal(edits.kind === "action" && edits.text, "Read a.txt  ·  Edit a.txt");
  assert.ok(edits.kind === "action" && edits.paths?.includes("C:\\work\\demo\\a.txt"));
  // The phone's whole read: no paths, long replies kept.
  const whole = parseOpencodeExport(fixture("finished"), true).events;
  assert.ok(whole.every((event) => event.kind !== "action" || event.paths === undefined));
});

test("OpenCode: a subagent carries its brief and its answer", () => {
  const sub = parseOpencodeExport(fixture("subagent")).events.find((event) => event.kind === "subagent");
  assert.ok(sub?.kind === "subagent");
  assert.equal(sub.description, "Count lines in a.txt");
  assert.equal(sub.agentType, "general");
  assert.match(sub.instructions, /^Read the file a\.txt/);
  assert.equal(sub.result, "2");
  assert.equal(typeof sub.resultAt, "number");
  // The child session reads like any other.
  assert.equal(parseOpencodeExport(fixture("subagent-child")).events.at(-1)?.kind, "note");
});

test("OpenCode: a question tool session shows the prompt and the questions", () => {
  const { events } = parseOpencodeExport(fixture("question"));
  assert.equal(events[0]!.kind, "prompt");
  assert.match(events[0]!.kind === "prompt" ? events[0]!.text : "", /^Use the question tool now/);
  assert.equal(events[1]!.kind === "action" && events[1]!.text, "Question · What is your favorite color?  ·  Question · Which sizes do you want?");
  const reply = events.at(-1)!;
  assert.equal(reply.kind === "note" && reply.text, "Favorite color: Green; Sizes: L");
});

test("OpenCode: what is not an export reads as an empty session", () => {
  assert.deepEqual(parseOpencodeExport("not json"), { events: [] });
  assert.deepEqual(parseOpencodeExport("null"), { events: [] });
  assert.deepEqual(parseOpencodeExport('{"messages":[null,5,{"info":"x","parts":{}}]}'), { events: [] });
});

test("OpenCode: the newest session in the folder, however the folder is spelled", () => {
  const list = JSON.stringify([
    { id: "ses_newOther", updated: 300, directory: "C:\\work\\other" },
    { id: "ses_old", updated: 100, directory: "C:\\work\\demo" },
    { id: "ses_new", updated: 200, directory: "C:\\Work\\Demo\\" },
    { id: "ses_tmp", updated: 50, directory: "/private/tmp/app" },
    { id: "ses_x; rm -rf ~", updated: 999, directory: "/home/me/app" },
    { id: "ses_ok", updated: 1, directory: "/home/me/app" },
    { id: "ses_case", updated: 1, directory: "/Home/me/app" },
  ]);
  assert.equal(pickOpencodeSession(list, "c:/work/demo"), "ses_new");
  assert.equal(pickOpencodeSession(list, "C:\\work\\demo\\"), "ses_new");
  assert.equal(pickOpencodeSession(list, "/tmp/app/"), "ses_tmp");
  assert.equal(pickOpencodeSession(JSON.stringify([{ id: "ses_a", updated: 1, directory: "/tmp/app" }]), "/private/tmp/app"), "ses_a");
  assert.equal(pickOpencodeSession(list, "/home/me/app"), "ses_ok", "an id that is not OpenCode's shape never goes onto a command line");
  assert.equal(pickOpencodeSession(list, "/home/me/nothing"), undefined);
  assert.equal(pickOpencodeSession("not json", "/home/me/app"), undefined);
  assert.equal(pickOpencodeSession('{"id":"ses_a"}', "/home/me/app"), undefined);
});

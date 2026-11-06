import assert from "node:assert/strict";
import { test } from "node:test";

import { newActivity, onOutput, onTick } from "../renderer/pet.ts";
import { sessionStatus } from "../shared/status.ts";
import { turnEnd, turnOver } from "./turn.ts";

const START = Date.parse("2026-11-04T01:00:00.000Z");
const stamp = (seconds: number) => new Date(START + seconds * 1000).toISOString();

/** A real record's shape while a workflow runs (masked from this PC's own, Claude Code 2.1): the main chain ended its turn, and only bookkeeping and sidechains follow. */
const workflowRunning = [
  { type: "user", timestamp: stamp(0), message: { content: "go" } },
  { type: "assistant", timestamp: stamp(1), message: { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "Workflow" }] } },
  { type: "user", timestamp: stamp(2), message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "started" }] } },
  { type: "assistant", timestamp: stamp(3), message: { stop_reason: "end_turn", content: [{ type: "text", text: "It runs in the background." }] } },
  { type: "attachment", timestamp: stamp(3), attachment: { type: "hook_success" } },
  { type: "system", subtype: "turn_duration", timestamp: stamp(3) },
  { type: "queue-operation", timestamp: stamp(4) },
  { type: "assistant", isSidechain: true, timestamp: stamp(5), message: { stop_reason: "tool_use", content: [{ type: "tool_use", id: "s1", name: "Bash" }] } },
].map((row) => JSON.stringify(row)).join("\n");

test("only background work runs: the main AI's turn is over, yet the status says working, as the terminal keeps redrawing", () => {
  const activity = newActivity();
  for (let now = START; now <= START + 30_000; now += 500) {
    onOutput(activity, now);
    assert.equal(onTick(activity, now), false, "output with no quiet: the record is never asked");
  }
  const now = START + 30_000;
  assert.equal(sessionStatus({ kind: "ready" } as never, activity), "working");
  assert.equal(turnEnd("claude", workflowRunning, now, now - activity.workSince), "finished", "what the record would have said");
  assert.equal(turnOver("claude", workflowRunning), true);
});

test("the main AI is on it: a running call, a call just answered, a prompt in flight", () => {
  const rows = workflowRunning.split("\n");
  assert.equal(turnOver("claude", rows.slice(0, 2).join("\n")), false, "its open call");
  assert.equal(turnOver("claude", rows.slice(0, 3).join("\n")), false, "the call answered, its reply to come");
  const again = JSON.stringify({ type: "user", timestamp: stamp(9), message: { content: "next" } });
  assert.equal(turnOver("claude", `${workflowRunning}\n${again}`), false, "a prompt after the turn ended");
  assert.equal(turnOver("claude", ""), false);
});

test("Codex: a finished or stopped turn is over; one in progress is not", () => {
  const row = (type: string) => JSON.stringify({ type: "event_msg", timestamp: stamp(1), payload: { type } });
  assert.equal(turnOver("codex", row("task_started")), false);
  assert.equal(turnOver("codex", [row("task_started"), row("task_complete")].join("\n")), true);
  assert.equal(turnOver("codex", [row("task_started"), row("turn_aborted")].join("\n")), true);
  assert.equal(turnOver("codex", [row("task_complete"), row("task_started")].join("\n")), false);
});

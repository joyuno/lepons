import { test } from "node:test";
import assert from "node:assert/strict";
import { chatFrom } from "./chat.ts";
import { toolDoing, toolLabels } from "./tool-labels.ts";
import type { WorkflowItem } from "./types.ts";

test("one list of calls per folded tools line, lined up with chatFrom", () => {
  const events: WorkflowItem[] = [
    { kind: "prompt", at: 1, text: "fix it" },
    { kind: "action", at: 2, text: "Read a.ts", labels: ["Read a.ts", "Bash npm test"] },
    { kind: "action", at: 3, text: "Edit a.ts" },
    { kind: "note", at: 4, text: "done?" },
    { kind: "action", at: 5, text: "Bash npm test", labels: ["Bash npm test"] },
  ];
  assert.deepEqual(toolLabels(events), [["Read a.ts", "Bash npm test", "Edit a.ts"], ["Bash npm test"]]);
  assert.equal(chatFrom(events).filter((item) => item.kind === "tools").length, toolLabels(events).length);
});

test("toolDoing names the kinds the chat's summary line counts", () => {
  assert.equal(toolDoing("Edit src/cart.ts"), "edit");
  assert.equal(toolDoing("Write a.md"), "edit");
  assert.equal(toolDoing("Read src/db.ts"), "read");
  assert.equal(toolDoing("Grep discount"), "read");
  assert.equal(toolDoing("Bash · npm test"), "run");
  assert.equal(toolDoing("Shell ls"), "run");
  assert.equal(toolDoing("WebSearch lepons"), undefined);
  assert.equal(toolDoing(undefined), undefined);
});

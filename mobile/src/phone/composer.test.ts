import { test } from "node:test";
import assert from "node:assert/strict";
import { composerAction, menuRows, menuQuestion } from "./composer.ts";

test("a menu's question is the text right above its first option", () => {
  const menu = [" 1. Yes", " 2. No"];
  assert.equal(menuQuestion(["● Fixing it", "", " Do you want to make this edit to cart.ts?", " ❯ 1. Yes", "   2. No"]), "Do you want to make this edit to cart.ts?");
  assert.equal(menuQuestion(["│ Which one?          │", "│                     │", "│ ❯ 1. A              │", "│   2. B              │"]), "Which one?");
  // The last "1." wins, past rules; nothing near it is no title.
  assert.equal(menuQuestion(["1. old list", "Ask", "────", ...menu]), "Ask");
  assert.equal(menuQuestion(["far away", "", "", "", ...menu]), undefined);
  assert.equal(menuQuestion(menu), undefined);
});

test("show stop only for an empty draft while the agent is working", () => {
  assert.equal(composerAction("working", ""), "stop");
  assert.equal(composerAction("working", "  "), "stop");
  assert.equal(composerAction("working", "next instruction"), "send");
  assert.equal(composerAction("waiting", ""), "send");
  assert.equal(composerAction("done", ""), "send");
  assert.equal(composerAction("working", "", true), "send", "the box a send just emptied: a second tap must not stop the agent");
  assert.equal(composerAction("idle", ""), "send");
});

test("only background work runs: send, as the main AI can answer", () => {
  assert.equal(composerAction("working", "", false, true), "send");
  assert.equal(composerAction("working", "", false, false), "stop", "the main AI's own turn");
  assert.equal(composerAction("working", "", false, undefined), "stop", "a PC too old to say");
  assert.equal(composerAction("done", "", false, true), "send");
});

test("with a menu's text field open only that row stays: a digit would land in the answer", () => {
  const options = [{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4, freeText: true }, { n: 5 }];
  assert.deepEqual(menuRows(options, false), options);
  assert.deepEqual(menuRows(options, true), [{ n: 4, freeText: true }]);
});

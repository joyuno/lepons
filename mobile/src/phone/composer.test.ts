import { test } from "node:test";
import assert from "node:assert/strict";
import { composerAction, formAnswered, formAnswers, menuKeys } from "./composer.ts";
import { menuQuestion } from "./menu.ts";

test("a menu's question is the text right above its first option", () => {
  const menu = [" 1. Yes", " 2. No"];
  assert.equal(menuQuestion(["● Fixing it", "", " Do you want to make this edit to cart.ts?", " ❯ 1. Yes", "   2. No"]), "Do you want to make this edit to cart.ts?");
  assert.equal(menuQuestion(["│ Which one?          │", "│                     │", "│ ❯ 1. A              │", "│   2. B              │"]), "Which one?");
  // The last "1." wins, past rules; nothing near it is no title.
  assert.equal(menuQuestion(["1. old list", "Ask", "────", ...menu]), "Ask");
  assert.equal(menuQuestion(["far away", "", "", "", ...menu]), undefined);
  assert.equal(menuQuestion(menu), undefined);
  // A question over several lines is whole.
  assert.equal(menuQuestion(["", "Which fruits should go", "into the smoothie?", "", "❯ 1. Apple", "  2. Pear"]), "Which fruits should go into the smoothie?");
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

test("with a menu's text field open a row leaves it first: a digit would land in the answer", () => {
  assert.deepEqual(menuKeys({ n: 2 }, false), ["2"]);
  assert.deepEqual(menuKeys({ n: 1, key: "enter" }, false), ["enter"]);
  assert.deepEqual(menuKeys({ n: 4, freeText: true }, true), ["up"], "the typing row only leaves");
  assert.deepEqual(menuKeys({ n: 2 }, true), ["up", "2"], "another row leaves, then picks");
});

test("an unnumbered picker's row sends its arrows and Enter, in turn", () => {
  assert.deepEqual(menuKeys({ n: 2, keys: ["down", "enter"] }, false), ["down", "enter"]);
  assert.deepEqual(menuKeys({ n: 1, keys: ["enter"] }, false), ["enter"]);
});

test("a whole question set goes to the PC as its answers, one per question: picks, or a single-select's words", () => {
  assert.deepEqual(formAnswers(3, [{ picks: [2, 0] }, { picks: [], text: "  Medium " }, { picks: [1] }]), [{ picks: [2, 0] }, { text: "Medium" }, { picks: [1] }]);
  assert.deepEqual(formAnswers(2, [{ picks: [0], text: " " }]), [{ picks: [0] }, { picks: [] }], "blank words are no words; a missing answer sends none");
  assert.equal(formAnswered(undefined), false);
  assert.equal(formAnswered({ picks: [] }), false);
  assert.equal(formAnswered({ picks: [], text: " " }), false);
  assert.equal(formAnswered({ picks: [0] }), true);
  assert.equal(formAnswered({ picks: [], text: "Medium" }), true);
});

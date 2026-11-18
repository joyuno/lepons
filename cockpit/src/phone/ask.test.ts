import { test } from "node:test";
import assert from "node:assert/strict";

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { askForm, askHookListing, formFits, hookForm, phoneAsk } from "./ask.ts";
import { menuFrom } from "./menu.ts";

const captured = (name: string) => readFileSync(join(import.meta.dirname, "fixtures", name), "utf8").split("\n");

test("the phone's ask: the menu read off the screen, the question and tabs off the scrollback over it", () => {
  const lines = captured("claude-ask-long-multi.txt");
  // The screen shows only the options: the question and the tab line have scrolled off.
  const screen = lines.slice(lines.findIndex((line) => line.startsWith("❯ 1.")));
  const menu = menuFrom(screen)!;
  const ask = phoneAsk(lines, menu, () => 1);
  assert.match(ask.id, /^[0-9a-f]{8}$/);
  assert.ok(ask.question?.startsWith("Which fruits should go into the smoothie"));
  assert.deepEqual(ask.tabs?.map((tab) => tab.label), ["Fruits", "Size", "Submit"]);
  assert.equal(ask.tab, 1);
  assert.deepEqual(ask.options[0], { n: 1, label: "Apple", detail: "Crisp and mildly tart, a clean base that blends smoothly.", checked: false });
  assert.equal(ask.options[3]?.freeText, true);
});

test("the ask's id follows what is asked, ticked and the tab; a tab out of range is none", () => {
  const lines = captured("claude-ask-ticked.txt");
  const menu = menuFrom(lines)!;
  const ask = phoneAsk(lines, menu);
  assert.equal(ask.tab, undefined);
  assert.equal(phoneAsk(lines, menu).id, ask.id, "the same screen, the same id");
  assert.notEqual(phoneAsk(lines, menu.map((option) => (option.n === 2 ? { ...option, checked: true } : option))).id, ask.id, "a tick");
  assert.notEqual(phoneAsk(lines, menu, () => 0).id, ask.id, "the tab");
  assert.equal(phoneAsk(lines, menu, () => 7).tab, undefined);
});

test("an unnumbered picker keeps its keys; a lone question has no tabs", () => {
  const trust = captured("claude-trust.txt");
  const picker = phoneAsk(trust, menuFrom(trust)!);
  assert.deepEqual(picker.options.map((option) => option.keys), [["enter"], ["down", "enter"]]);
  const moved = trust.map((line) => line.replace("❯ No, exit", "  No, exit").replace("  Yes, I trust", "❯ Yes, I trust"));
  assert.notEqual(phoneAsk(moved, menuFrom(moved)!).id, picker.id, "the cursor moved: the same labels, other keys");
  const question = captured("claude-ask-question.txt");
  const lone = phoneAsk(question, menuFrom(question)!, () => 0);
  assert.equal(lone.tabs, undefined);
  assert.equal(lone.tab, undefined);
  assert.equal(lone.question, "Which color do you like?");
});

test("the whole question set: the last AskUserQuestion without an answer, and only while it is the set on screen", () => {
  const asked = (id: string, questions: unknown) => JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id, name: "AskUserQuestion", input: { questions } }] } });
  const answered = (id: string) => JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] } });
  const two = [
    { header: "Fruits", question: "Which fruits?", multiSelect: true, options: [{ label: "Apple", description: "Crisp" }, { label: "Banana", description: "Sweet" }] },
    { header: "Size", question: "Which size?", multiSelect: false, options: [{ label: "Small" }, { label: "Large" }] },
  ];
  const jsonl = ["{cut line", asked("toolu_old", [two[1]]), answered("toolu_old"), asked("toolu_01", two), ""].join("\n");
  const form = askForm(jsonl)!;
  assert.equal(form.id, "toolu_01");
  assert.deepEqual(form.questions[0], { header: "Fruits", question: "Which fruits?", multiSelect: true, options: [{ label: "Apple", description: "Crisp" }, { label: "Banana", description: "Sweet" }] });
  assert.deepEqual(form.questions[1]!.options, [{ label: "Small" }, { label: "Large" }]);
  assert.equal(askForm(`${jsonl}\n${answered("toolu_01")}`), undefined, "answered: nothing pending");
  assert.equal(askForm(asked("toolu_02", [{ ...two[0], options: ["A", "B", "C", "D", "E"].map((label) => ({ label })) }])), undefined, "more options than the digits can follow");
  assert.equal(askForm(asked("toolu_03", [{ question: "No header?", options: [{ label: "A" }] }])), undefined);
  // Only the set on screen, told by its question, a header among the tabs, or its review; no tab line needed.
  const ask = (question: string | undefined, tabs?: string[], options = ["Small", "Large"]) =>
    ({ id: "0", ...(question ? { question } : {}), options: options.map((label, i) => ({ n: i + 1, label })), ...(tabs ? { tabs: tabs.map((label) => ({ label, done: false })) } : {}) });
  assert.equal(formFits(form, ask("Which size?")), true);
  assert.equal(formFits(form, ask("Plan 여러개 Submit Which size?")), true, "wrapped tab labels over a short question");
  assert.equal(formFits(form, ask(undefined, ["Fruits", "Size", "Submit"])), true);
  assert.equal(formFits(form, ask(undefined, undefined, ["Submit answers", "Cancel"])), true);
  assert.equal(formFits(form, ask("Which colour?", ["Colors", "Submit"])), false, "another set");
});

test("the hook's saved set: the newest asked in this folder, its slashes and (on Windows) case aside", () => {
  const questions = [{ header: "Size", question: "Which size?", options: [{ label: "Small" }, { label: "Large" }] }];
  const saved = (cwd: string, id: string, extra = {}) =>
    JSON.stringify({ session_id: "s", cwd, hook_event_name: "PreToolUse", tool_name: "AskUserQuestion", tool_input: { questions }, tool_use_id: id, ...extra });
  const listing = [
    `==> 200-2.json\n${saved("C:\\tmp\\Other", "toolu_other")}`,
    `==> 150-9.json\n${saved("C:\\tmp\\Work\\", "toolu_new")}`,
    `==> 100-1.json\n${saved("C:/tmp/work", "toolu_old")}`,
    "==> ../../etc/passwd\nroot",
    "",
  ].join("\n");
  const files = askHookListing(listing);
  assert.deepEqual(files.map((file) => file.name), ["200-2.json", "150-9.json", "100-1.json"], "only the hook's own names");
  const picked = hookForm(files, "C:/tmp/work", true)!;
  assert.equal(picked.name, "150-9.json");
  assert.equal(picked.form.id, "toolu_new");
  assert.deepEqual(picked.form.questions, [{ header: "Size", question: "Which size?", multiSelect: false, options: [{ label: "Small" }, { label: "Large" }] }]);
  assert.equal(hookForm(files, "C:/tmp/work", false)?.name, "100-1.json", "a POSIX PC's folders differ by case");
  assert.equal(hookForm(files, "/home/me", false), undefined, "asked elsewhere");
  assert.equal(hookForm([{ name: "1-1.json", text: saved("/w", "toolu_x", { tool_name: "Bash" }) }], "/w", false), undefined);
  assert.equal(hookForm([{ name: "1-1.json", text: "{cut" }, { name: "0-1.json", text: saved("/w", "toolu_y") }], "/w", false)?.form.id, "toolu_y", "a half-written file is passed over");
});

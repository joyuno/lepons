import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { setLocale, t } from "../i18n/i18n.ts";
import type { WorkflowItem } from "../shared/ipc.ts";
import { answerLink } from "./chat-view.ts";
import { chatLine, chatStop } from "./tmux-bar.ts";
import { composerAction, cutRows, STOP_WAIT_MS, stopState, stoppedEnd } from "./chat-view.ts";
import { skillRows, suggestAsk as askOf } from "./chat-view.ts";

test("\"$\" asks for Codex's skills anywhere a word starts with it, and its row puts `$<name> ` in that word's place", () => {
  assert.deepEqual(askOf("$"), { skill: "" });
  assert.deepEqual(askOf("use $Fig"), { skill: "fig" });
  assert.equal(askOf("costs 5$"), undefined, "inside a word: a letter");
  const listed = [{ name: "/model", description: "m" }, { name: "$figma:figma-use", description: "f" }, { name: "$imagegen", description: "i" }];
  assert.deepEqual(skillRows(listed, "use $fig", "fig"), [{ insert: "use $figma:figma-use ", label: "$figma:figma-use", detail: "f" }]);
  assert.deepEqual(skillRows(listed, "$", "").map((row) => row.label), ["$figma:figma-use", "$imagegen"], "no \"/\" command in it");
});
import { cardNoteStale, focusChat, handoffStep } from "./chat-view.ts";

test("a handed-back handoff goes in only over a plain prompt: a menu holds it, past the wait a note", () => {
  const plain = { menu: false, working: false, up: true };
  assert.equal(handoffStep(plain, 0, 20_000), "type");
  assert.equal(handoffStep({ ...plain, menu: true }, 30_000, 20_000), "hold", "never into a menu, however long: its card is on screen");
  assert.equal(handoffStep({ ...plain, working: true }, 1000, 20_000), "wait");
  assert.equal(handoffStep({ ...plain, working: true }, 20_000, 20_000), "stuck");
  assert.equal(handoffStep({ ...plain, up: false }, 20_000, 20_000), "stuck", "the AI gone: a shell is no prompt for it");
});

test("a card's \"check the terminal\" goes once that card changes or goes; answer-first goes with the question", () => {
  setLocale("ko");
  for (const key of ["chat.ask.stuck", "chat.ask.moved"]) {
    assert.equal(cardNoteStale(t(key), true), true, `${key}: another card`);
    assert.equal(cardNoteStale(t(key), false), true, `${key}: no card`);
  }
  assert.equal(cardNoteStale(t("chat.answerFirst"), false), true);
  assert.equal(cardNoteStale(t("chat.answerFirst"), true), false, "still a question to answer");
  assert.equal(cardNoteStale(t("chat.stopFailed"), false), false, "not the card's");
  assert.equal(cardNoteStale("", false), false);
});
import { cardFocus, newQuestion } from "./chat-view.ts";

test("a card that comes to show another question (the next of a set, the review, one back after none) waits; its cursor moving does not", () => {
  const card = (question: string, tab: number, cursor = 1) => ({ id: `${question}${tab}${cursor}`, kind: "menu" as const, question, tab, cursor, options: [{ n: 1, label: "a" }, { n: 2, label: "b" }] });
  const first = card("Dinner?", 0);
  assert.equal(newQuestion(undefined, first), true, "the first card, or one back after its card went");
  assert.equal(newQuestion(first, card("Dinner?", 0, 2)), false, "the same question, its cursor moved");
  assert.equal(newQuestion(first, card("Season?", 1)), true, "the next question of the set");
  assert.equal(newQuestion(first, card("Dinner?", 2)), true, "another tab");
});

test("the keyboard on a card drawn again: its words, else its first row -- on the review its title, never 제출", () => {
  const rows = { id: "q", kind: "menu" as const, question: "Season?", options: [{ n: 1, label: "봄" }, { n: 2, label: "Chat about this", chat: true as const }] };
  assert.equal(cardFocus(rows, true), "words");
  assert.equal(cardFocus(rows, false), "row");
  assert.equal(cardFocus({ ...rows, review: true, options: [{ n: 1, label: "Submit answers" }, { n: 2, label: "Cancel" }] }, false), "title");
  assert.equal(cardFocus({ ...rows, options: [{ n: 1, label: "Chat about this", chat: true }] }, false), "button", "only the chat button: no row to go to");
});
import { pastedFiles, withAttached } from "./chat-view.ts";
import { settlesOnSend } from "./chat-view.ts";
import { canTypeModel, chatAgent, chatRows, chipLabel, composerKey, dropChat, durationWords, fileRows, slashRows, suggestAsk, suggestKey, leaveTerminal, linkAt, liveLine, menuMove, mergeEvents, modelMenu, olderEvents, outputPreview, askedStep, heldOnScreen, promptParts, readAfterSwitch, runningSubs, settlePending, shownModel, subState, typeLine, workSummary, type ChatRow, type ChatView, type WorkRow } from "./chat-view.ts";

test("a press in the pane leaves the keyboard where the chat already has it: an open menu or list is not closed by it", () => {
  let focused = 0;
  const list = { focus: () => void focused++ };
  const inside = new Set<unknown>(["menu item", "composer"]);
  const view = { contains: (node: unknown) => inside.has(node) };
  focusChat(view, list, "menu item");
  focusChat(view, list, "composer");
  assert.equal(focused, 0, "focus inside the chat stays where it is");
  focusChat(view, list, "terminal");
  focusChat(view, list, null);
  assert.equal(focused, 2, "from outside it the list takes it");
});

test("a paste that carries files or a picture is attached; plain text is the field's own", () => {
  let asked = 0;
  const copied = (path: string) => () => (asked++, path);
  assert.equal(pastedFiles([], "hello", copied("C:/x.txt")), undefined, "text pastes as text");
  assert.equal(asked, 0, "the clipboard is not asked for a file then");
  assert.deepEqual(pastedFiles([{ path: "C:/a.png", type: "image/png" }], "", copied("")), { paths: ["C:/a.png"], pictures: [] });
  assert.deepEqual(pastedFiles([{ path: "", type: "image/png" }, { path: "", type: "image/jpeg" }], "", copied("")), { paths: [], pictures: [0, 1] }, "a copied picture has no file");
  assert.deepEqual(pastedFiles([], "", copied("C:/copied.pdf")), { paths: ["C:/copied.pdf"], pictures: [] }, "a file copied in Explorer");
  assert.equal(pastedFiles([], "", copied("")), undefined);
  assert.equal(pastedFiles([{ path: "", type: "text/plain" }], "", copied("")), undefined, "no path and no picture: nothing to attach");
  // Excel cells, a Word or OneNote copy: their words and a picture of them. The words go in, as the terminal's paste does.
  assert.equal(pastedFiles([{ path: "", type: "image/png" }], "A\tB\n1\t2", copied("")), undefined);
  assert.deepEqual(pastedFiles([{ path: "C:/a.pdf", type: "application/pdf" }], "a.pdf", copied("")), { paths: ["C:/a.pdf"], pictures: [] }, "a file is attached whatever names it");
});

test("what is sent: the attachments' typed paths, then the words", () => {
  assert.equal(withAttached([], "hi"), "hi");
  assert.equal(withAttached(["/tmp/a.png ", "'/tmp/b c.txt' "], "look"), "/tmp/a.png '/tmp/b c.txt' look");
  assert.equal(withAttached(["/tmp/a.png "], ""), "/tmp/a.png");
});

test("a \"/\" command sent from the composer stops showing as 보내는 중 once it is typed: a local one never reaches the record", () => {
  for (const line of ["/model sonnet", "/compact", "/codex:rescue fix it", "/mcp__fakep__greet"]) assert.equal(settlesOnSend(line), true, line);
  for (const line of ["hello", "look at /tmp/a.png", "$imagegen a cat", "/", "/tmp/a.png 이거 봐"]) assert.equal(settlesOnSend(line), false, line);
});

test("mergeEvents keeps what slid out and takes the newest read as it is", () => {
  const p = (at: number, text: string): WorkflowItem => ({ kind: "prompt", at, text });
  const kept = [p(1, "a"), p(2, "b"), p(3, "c")];
  // The newest read starts at 2 and has c finished differently: from 2 on it is taken whole.
  assert.deepEqual(mergeEvents(kept, [p(2, "b"), p(3, "c2"), p(4, "d")]), [p(1, "a"), p(2, "b"), p(3, "c2"), p(4, "d")]);
  assert.deepEqual(mergeEvents([], [p(4, "d")]), [p(4, "d")]);
  assert.deepEqual(mergeEvents(kept, []), kept, "an empty read takes nothing away");
});

test("olderEvents puts an older read in front and drops what the view already has", () => {
  const p = (at: number, text: string): WorkflowItem => ({ kind: "prompt", at, text });
  assert.deepEqual(olderEvents([p(5, "e"), p(6, "f")], [p(3, "c"), p(4, "d"), p(5, "e")]), [p(3, "c"), p(4, "d"), p(5, "e"), p(6, "f")]);
  assert.deepEqual(olderEvents([p(5, "e")], []), [p(5, "e")]);
  assert.deepEqual(olderEvents([], [p(1, "a")]), [p(1, "a")]);
});

test("tool runs between two answers fold into one row; a subagent is a row of its own", () => {
  const events: WorkflowItem[] = [
    { kind: "prompt", at: 1, text: "go [Image #1]", images: ["data:image/png;base64,AA=="] },
    { kind: "note", at: 2, text: "looking" },
    { kind: "action", at: 3, text: "Bash · ls", steps: [{ tool: "command", target: "ls", result: "done", endAt: 4 }] },
    { kind: "action", at: 4, text: "Read b.ts", steps: [{ tool: "read", target: "b.ts" }] },
    { kind: "subagent", at: 5, description: "review", instructions: "check", result: "ok", resultAt: 9 },
    { kind: "action", at: 10, text: "Read a.ts", cancelled: true, steps: [{ tool: "read", target: "a.ts" }] },
    { kind: "note", at: 11, text: "done" },
  ];
  assert.deepEqual(chatRows(events), [
    { kind: "user", at: 1, text: "go [Image #1]", images: ["data:image/png;base64,AA=="] },
    { kind: "agent", at: 2, text: "looking" },
    { kind: "work", at: 3, steps: [{ tool: "command", target: "ls", result: "done", endAt: 4 }, { tool: "read", target: "b.ts" }] },
    { kind: "sub", at: 5, description: "review", instructions: "check", result: "ok", resultAt: 9 },
    { kind: "work", at: 10, cancelled: true, steps: [{ tool: "read", target: "a.ts" }] },
    { kind: "agent", at: 11, text: "done" },
  ]);
});

test("a subagent runs until its result, unless stopped or a later prompt came; the running ones are listed", () => {
  const rows = chatRows([
    { kind: "prompt", at: 1, text: "go" },
    { kind: "subagent", at: 2, description: "old", instructions: "" },
    { kind: "prompt", at: 3, text: "again" },
    { kind: "subagent", at: 4, description: "a", instructions: "" },
    { kind: "subagent", at: 5, description: "b", instructions: "", result: "ok", resultAt: 6 },
    { kind: "subagent", at: 7, description: "c", instructions: "", cancelled: true },
  ]);
  assert.deepEqual(rows.map((row, i) => row.kind === "sub" ? subState(rows, i, false) : ""), ["", "stopped", "", "running", "done", "stopped"]);
  assert.deepEqual(runningSubs(rows, false).map((row) => row.description), ["a"]);
  // At work, a later prompt is a line typed meanwhile: the one under it goes on.
  assert.deepEqual(runningSubs(rows, true).map((row) => row.description), ["old", "a"]);
});

test("a call's output shows two lines, the rest behind 더 보기", () => {
  assert.deepEqual(outputPreview("a\nb"), { preview: "a\nb", more: false });
  assert.deepEqual(outputPreview("a\nb\nc"), { preview: "a\nb", more: true });
  assert.deepEqual(outputPreview(`${"x".repeat(500)}`), { preview: `${"x".repeat(300)}…`, more: true }, "a long line is cut too");
});

test("linkAt finds the address or path under a click, as the terminal's Ctrl+click does", () => {
  const text = "see https://example.com/a/b. then\nedit src/app.ts:12:3 or ./docs/\nnothing here";
  assert.deepEqual(linkAt(text, text.indexOf("example")), { url: "https://example.com/a/b" });
  assert.deepEqual(linkAt(text, text.indexOf("app.ts")), { path: "src/app.ts" });
  assert.deepEqual(linkAt(text, text.indexOf("docs")), { path: "./docs", folder: true });
  assert.equal(linkAt(text, text.indexOf("nothing")), undefined);
  // Broken at a box's side, as a TUI prints it: joined, as in the terminal.
  const boxed = "│ https://example.com/very/long/pa │\n│ th/to/page                       │";
  assert.deepEqual(linkAt(boxed, boxed.indexOf("th/to")), { url: "https://example.com/very/long/path/to/page" });
});

test("an answer's link to a share or device opens nothing; a file's and a web address's do", () => {
  for (const href of ["file:////attacker/share/a.md", "file:///%5C%5Cattacker/s/a.md", "file:///%2F%2Fattacker/a.md", "file:///%5C%5C%3F%5CC:%5Ca.md", "file:///%5C%5C.%5Cpipe%5Cx", "javascript:alert(1)", "smb://attacker/s"]) {
    assert.equal(answerLink(href), undefined, href);
  }
  assert.deepEqual(answerLink("file:///C:/work/a.md"), { path: "C:/work/a.md" });
  assert.deepEqual(answerLink("file://pc/home/u/a.md"), { path: "/home/u/a.md" });
  assert.deepEqual(answerLink("https://example.com/a"), { url: "https://example.com/a" });
});

test("a sent line waits as 보내는 중 until a prompt newer than the last at its send comes; a failed one stays", () => {
  const pending = [{ id: 1, text: "a", after: 10 }, { id: 2, text: "b", after: 10 }, { id: 3, text: "c", after: 10, failed: true as const }];
  assert.deepEqual(settlePending(pending, [5, 10]).map((one) => one.id), [1, 2, 3]);
  assert.deepEqual(settlePending(pending, [5, 10, 12]).map((one) => one.id), [2, 3], "one newer prompt: the first sent is in");
  assert.deepEqual(settlePending(pending, [12, 13]).map((one) => one.id), [3]);
});

test("OpenCode is no chat: only Claude's and Codex's records draw one", () => {
  assert.deepEqual((["claude", "codex", "opencode", "grok"] as const).map(chatAgent), [true, true, false, false]);
});

const row = (steps: WorkRow["steps"], at = 1_000): WorkRow => ({ kind: "work", at, steps });

test("counts commands and distinct files", () => {
  const sum = workSummary(row([
    { tool: "read", target: "a.ts" },
    { tool: "read", target: "a.ts" },
    { tool: "edit", target: "b.ts" },
    { tool: "command", target: "npm test" },
    { tool: "other", target: "MCP x.y" },
  ]), false, 0);
  assert.deepEqual([sum.commands, sum.files], [1, 2]);
});

test("duration runs from the first call to the last result", () => {
  assert.equal(workSummary(row([{ tool: "command", target: "a", endAt: 30_400 }, { tool: "read", target: "b", endAt: 12_000 }]), false, 0).seconds, 29);
});

test("no result time, no duration", () => {
  assert.equal(workSummary(row([{ tool: "command", target: "a" }]), false, 99_000).seconds, undefined);
  assert.equal(workSummary(row([{ tool: "command", target: "a", endAt: 500 }]), false, 0).seconds, undefined, "a time before the start is no time");
  assert.equal(workSummary(row([{ tool: "command", target: "a", endAt: 1_000 }]), false, 0).seconds, undefined, "ended as it started: only the end was written");
});

test("running counts from the first call to now", () => {
  assert.equal(workSummary(row([{ tool: "command", target: "a", endAt: 2_000 }]), true, 46_000).seconds, 45);
});

test("durationWords", () => {
  setLocale("ko");
  assert.equal(durationWords(45, t), "45초");
  assert.equal(durationWords(75, t), "1분 15초");
});

test("composerKey sends on Enter and breaks the line on Shift+Enter", () => {
  assert.equal(composerKey({ key: "Enter", shiftKey: false, isComposing: false, keyCode: 13 }), "send");
  assert.equal(composerKey({ key: "Enter", shiftKey: true, isComposing: false, keyCode: 13 }), "newline");
  assert.equal(composerKey({ key: "a", shiftKey: false, isComposing: false }), "none");
});

test("the composer suggests commands after a lone /word and files after @, inside the session's folder", () => {
  assert.deepEqual(suggestAsk("/"), { slash: "" });
  assert.deepEqual(suggestAsk("/Comp"), { slash: "comp" });
  assert.equal(suggestAsk("/compact now"), undefined);
  assert.equal(suggestAsk("say /compact"), undefined);
  assert.deepEqual(suggestAsk("look at @"), { folder: "", typed: "" });
  assert.deepEqual(suggestAsk("@src/ma"), { folder: "src/", typed: "ma" });
  assert.equal(suggestAsk("mail me@"), undefined);
  assert.equal(suggestAsk("@../x"), undefined);
  assert.equal(suggestAsk("@/etc/"), undefined);
  assert.equal(suggestAsk("hello"), undefined);
});

test("command rows: those that start with the word first, inserted with a space after", () => {
  const commands = [{ name: "/recompact", description: "r" }, { name: "/compact", description: "c" }, { name: "/plugin:compact-it", description: "p" }, { name: "/model", description: "m" }];
  assert.deepEqual(slashRows(commands, "compact").map((row) => row.label), ["/compact", "/recompact", "/plugin:compact-it"]);
  assert.deepEqual(slashRows(commands, "")[0], { insert: "/recompact ", label: "/recompact", detail: "r" });
  assert.equal(slashRows(Array.from({ length: 300 }, (_, at) => ({ name: `/c${at}`, description: "" })), "").length, 300, "all of them, the list scrolls");
});

test("file rows: a folder goes into it, a file ends the word", () => {
  const entries = [{ name: "src", directory: true }, { name: "main.ts", directory: false }, { name: "README.md", directory: false }];
  assert.deepEqual(fileRows(entries, "see @", "", ""), [
    { insert: "see @src/", label: "@src/" },
    { insert: "see @main.ts ", label: "@main.ts" },
    { insert: "see @README.md ", label: "@README.md" },
  ]);
  assert.deepEqual(fileRows(entries, "@src/MA", "src/", "MA"), [{ insert: "@src/main.ts ", label: "@src/main.ts" }]);
});

test("suggestion keys: arrows move, Enter or Tab picks, Esc closes, and none of it while an IME composes", () => {
  const key = (name: string, extra = {}) => suggestKey({ key: name, shiftKey: false, isComposing: false, ...extra });
  assert.equal(key("ArrowDown"), "down");
  assert.equal(key("ArrowUp"), "up");
  assert.equal(key("Enter"), "pick");
  assert.equal(key("Tab"), "pick");
  assert.equal(key("Escape"), "close");
  assert.equal(key("Enter", { shiftKey: true }), undefined);
  assert.equal(key("Tab", { shiftKey: true }), undefined);
  assert.equal(key("a"), undefined);
  assert.equal(key("Enter", { isComposing: true }), undefined);
  assert.equal(key("ArrowDown", { keyCode: 229 }), undefined);
});

test("composerKey ignores Enter while composing", () => {
  // The Enter that ends a Korean word's composition must not send the half-typed word.
  assert.equal(composerKey({ key: "Enter", shiftKey: false, isComposing: true, keyCode: 229 }), "none");
  assert.equal(composerKey({ key: "Enter", shiftKey: false, isComposing: false, keyCode: 229 }), "none");
  assert.equal(composerKey({ key: "Enter", shiftKey: true, isComposing: true }), "none");
});

test("an AI without a verified command gets no same-AI list", () => {
  assert.equal(modelMenu("codex", ["claude", "codex"]).same, undefined);
  assert.equal(modelMenu("opencode", ["opencode"]).same, undefined);
  const claude = modelMenu("claude", ["claude"]).same;
  assert.ok(claude && claude.models.includes("opus"));
  assert.equal(claude.line("opus"), "/model opus");
});

test("other AIs leave out the current one and mark terminal-only ones", () => {
  assert.deepEqual(modelMenu("claude", ["claude", "codex", "grok", "opencode", "agent"]).others, [
    { kind: "codex", terminalOnly: false },
    { kind: "grok", terminalOnly: true },
    { kind: "opencode", terminalOnly: true },
    { kind: "agent", terminalOnly: true },
  ]);
  assert.deepEqual(modelMenu("claude", ["claude"]).others, []);
  assert.deepEqual(modelMenu("codex", ["claude", "codex"]).others, [{ kind: "claude", terminalOnly: false }], "Codex: only carrying the talk on");
});

test("a model line is typed only into a prompt waiting for words", () => {
  const ask = { id: "m", kind: "menu" as const, options: [{ n: 1, label: "Yes" }] };
  assert.equal(canTypeModel(true, undefined, "idle"), true);
  assert.equal(canTypeModel(true, undefined, "done"), true);
  assert.equal(canTypeModel(false, undefined, "idle"), false, "the session takes no typing");
  assert.equal(canTypeModel(true, undefined, "working"), false, "the AI is at work");
  assert.equal(canTypeModel(true, ask, "idle"), false, "a question read off the screen");
  assert.equal(canTypeModel(true, undefined, "waiting"), false, "a question nobody could read: 터미널에서 답해 주세요");
});

test("Claude's model list says the pick becomes the default for new sessions too", () => {
  assert.equal(modelMenu("claude", []).same?.alsoDefault, true);
});

test("menuMove wraps, and Up from the menu itself goes to the last item", () => {
  assert.equal(menuMove("ArrowDown", 0, 3), 1);
  assert.equal(menuMove("ArrowDown", 2, 3), 0);
  assert.equal(menuMove("ArrowUp", 0, 3), 2);
  assert.equal(menuMove("ArrowUp", -1, 3), 2);
  assert.equal(menuMove("ArrowDown", -1, 3), 0);
  assert.equal(menuMove("Home", 1, 3), 0);
  assert.equal(menuMove("End", 0, 3), 2);
  assert.equal(menuMove("a", 0, 3), undefined);
  assert.equal(menuMove("ArrowDown", -1, 0), undefined);
});

test("the chip drops a model read for another AI", () => {
  assert.equal(shownModel({ kind: "claude", model: "claude-opus-5-5" }, "claude"), "claude-opus-5-5");
  assert.equal(shownModel({ kind: "claude", model: "claude-opus-5-5" }, "grok"), undefined, "carried on to Grok: its name only");
  assert.equal(shownModel(undefined, "claude"), undefined);
});

test("chipLabel shows the model only when known", () => {
  assert.equal(chipLabel("claude", "claude-opus-5-5"), "Claude · claude-opus-5-5");
  assert.equal(chipLabel("codex", undefined), "Codex");
});

/** Claude Code's own screens (src/phone/fixtures): its Bash permission question, and its trust question at a start. */
const fixture = (name: string) => readFileSync(join(import.meta.dirname, "..", "phone", "fixtures", name), "utf8");
const work = (steps: WorkRow["steps"], cancelled?: true): ChatRow => ({ kind: "work", at: 1, steps, ...(cancelled ? { cancelled } : {}) });
const asking = { tool: "command" as const, target: 'node -e "console.log(1+1)"', command: 'node -e "console.log(1+1)"' };
const other = { tool: "command" as const, target: "npm run lint", command: "npm run lint" };
const read = { tool: "read" as const, target: "app.ts", result: "done" as const };

test("askedStep: the one unfinished call, and only while the question on screen shows it", () => {
  const permission = fixture("claude-permission-bash.txt");
  assert.deepEqual(askedStep([work([read, asking])], permission), asking);
  assert.equal(askedStep([work([asking, other])], permission), undefined, "two at once: which one is asked is not known");
  assert.equal(askedStep([work([asking, read, other])], permission), undefined, "two at once, an ended one between");
  assert.equal(askedStep([work([asking])], fixture("claude-trust.txt")), undefined, "a call left from an earlier run, under the start's trust question");
  assert.equal(askedStep([work([asking]), { kind: "agent", at: 2, text: "ok" }], permission), undefined, "an answer came after it");
  assert.equal(askedStep([work([asking], true)], permission), undefined, "a cancelled turn waits on nothing");
  assert.equal(askedStep([], permission), undefined);
  // The screen wraps a long command anywhere (Claude's box has no side borders: claude-permission-bash.txt): spaces
  // and line breaks do not count.
  const wrapped = { tool: "command" as const, target: "npm run build -- --watch", command: "npm run build -- --watch\nnpm test" };
  assert.deepEqual(askedStep([work([wrapped])], " npm run build -- \n   --watch\n npm test\n Do you want to proceed?"), wrapped);
});

test("heldOnScreen: the turn is still at work while one of its unfinished calls is the question on screen", () => {
  const permission = fixture("claude-permission-bash.txt");
  assert.equal(heldOnScreen([work([asking, other])], permission), true, "two at once: it is held all the same");
  assert.equal(heldOnScreen([work([asking])], fixture("claude-trust.txt")), false, "an earlier run's call does not come back to life");
  assert.equal(heldOnScreen([work([read])], permission), false);
});

/** typeLine's terminal: what it was given, and the 300 ms wait run by hand. */
const fakeTerminal = (bracketed: boolean, menus: boolean[]) => {
  const typed: string[] = [];
  let wait: (() => void) | undefined;
  const io = {
    blocked: () => menus.shift() ?? false,
    bracketed,
    paste: (text: string) => typed.push(`paste:${text}`),
    enter: () => typed.push("enter"),
    later: (run: () => void) => { wait = run; },
  };
  return { io, typed, wait: () => wait?.() };
};

test("typeLine sends nothing over a menu: its Enter would pick the highlighted choice", () => {
  const up = fakeTerminal(true, [true]);
  assert.equal(typeLine("하지 마", up.io), false);
  up.wait();
  assert.deepEqual(up.typed, []);
  const clear = fakeTerminal(true, [false, false]);
  assert.equal(typeLine("go on", clear.io), true);
  clear.wait();
  assert.deepEqual(clear.typed, ["paste:go on", "enter"]);
});

test("typeLine leaves Enter unpressed when a menu came up while the paste landed", () => {
  const late = fakeTerminal(true, [false, true]);
  assert.equal(typeLine("go on", late.io), true);
  late.wait();
  assert.deepEqual(late.typed, ["paste:go on"]);
});

test("a line whose Enter a menu held back is told apart from one never typed: sending it again would type it twice", async () => {
  const run = (menus: boolean[]) => {
    const typed: string[] = [];
    // As main.ts sendFromChat wires it: Enter tells "sent"; the wait's end tells "typed", heard only when no Enter went.
    const result = chatLine(undefined, (entered) => typeLine("go on", {
      blocked: () => menus.shift() ?? false,
      bracketed: true,
      paste: (text) => typed.push(`paste:${text}`),
      enter: () => (typed.push("enter"), entered("sent")),
      later: (next) => setTimeout(() => (next(), entered("typed")), 0),
    }));
    return result.then((how) => ({ how, typed }));
  };
  assert.deepEqual(await run([false, false]), { how: "sent", typed: ["paste:go on", "enter"] });
  assert.deepEqual(await run([false, true]), { how: "typed", typed: ["paste:go on"] });
  assert.deepEqual(await run([true]), { how: "notSent", typed: [] });
  assert.equal(await chatLine(async () => false, () => assert.fail("typed while in copy mode")), "notSent");
  // Held in the prompt, it leaves once the person's Enter there puts it in the record.
  assert.deepEqual(settlePending([{ id: 1, text: "go on", after: 10, typed: true }], [11]), []);
});

test("typeLine folds line breaks into spaces when the terminal takes no bracketed paste", () => {
  // Without it each line break is an Enter (xterm's paste turns them into \r): folded as the phone folds them.
  const plain = fakeTerminal(false, []);
  typeLine("one\ntwo\r\n\nthree", plain.io);
  plain.wait();
  assert.deepEqual(plain.typed, ["paste:one two three", "enter"]);
  const bracketed = fakeTerminal(true, []);
  typeLine("one\ntwo", bracketed.io);
  assert.deepEqual(bracketed.typed, ["paste:one\ntwo"]);
});

test("dropChat lets the old view go, so a session opened again reads its talk afresh", () => {
  const disposed: string[] = [];
  const view = (name: string) => ({ dispose: () => disposed.push(name) }) as unknown as ChatView;
  const views = new Map([["a", view("a")], ["b", view("b")]]);
  dropChat(views, "a");
  dropChat(views, "none");
  assert.deepEqual([...views.keys()], ["b"]);
  assert.deepEqual(disposed, ["a"]);
});

test("main.ts hands no DOM global over as a method: called on another object, Chromium throws Illegal invocation", () => {
  // `{ later: setTimeout }.later(...)` throws in the renderer (Node's setTimeout does not care, so a fake would not see it).
  const main = readFileSync(join(import.meta.dirname, "main.ts"), "utf8");
  const bare = /\w+\s*:\s*(?:window\.)?(?:setTimeout|clearTimeout|setInterval|clearInterval|requestAnimationFrame|cancelAnimationFrame|fetch|queueMicrotask)\s*[,}\r\n]/g;
  assert.deepEqual(main.match(bare) ?? [], []);
});

test("liveLine reads the CLI's own line for what it does now off the screen, and nothing else", () => {
  assert.equal(liveLine(fixture("claude-thinking.txt")), "Mulling… (2s)");
  assert.equal(liveLine(fixture("claude-working.txt")), "Gallivanting… (Tracking ponytail mode...…)");
  assert.equal(liveLine(fixture("codex-working.txt")), "Working (5s)");
  assert.equal(liveLine(fixture("claude-idle.txt")), undefined, "a prompt waiting: no line");
  assert.equal(liveLine(fixture("codex-idle-dots.txt")), undefined, "Codex at rest, dots around its prompt");
  assert.equal(liveLine(fixture("claude-permission-bash.txt")), undefined, "a question, its \"⎿ Waiting…\" a tool's result");
  const idle = fixture("claude-idle.txt");
  assert.equal(liveLine(`● Searching for 1 pattern… (ctrl+o to expand)\n\n✶ Onioning… (17s · ↓ 1.2k tokens · thinking )\n${idle}`), "Onioning… (17s)", "the spinner over a tool line");
  assert.equal(liveLine(`● Searching for 1 pattern…\n${idle}`), "Searching for 1 pattern…", "a tool still at work, no spinner");
  assert.equal(liveLine(`● Searched for 1 pattern (ctrl+o to expand)\n● 다 찾았어요.\n${idle}`), undefined, "done");
});

test("promptParts shows a picture sent with the prompt as a part of its own", () => {
  assert.deepEqual(promptParts("[image]"), [{ photo: true }]);
  assert.deepEqual(promptParts("[Image #1] 이거 봐 줘 [Image #2]"), [{ photo: true }, " 이거 봐 줘 ", { photo: true }]);
  assert.deepEqual(promptParts("배열 [image] 아님? a[image]"), ["배열 ", { photo: true }, " 아님? a", { photo: true }]);
  assert.deepEqual(promptParts("그냥 글"), ["그냥 글"]);
});

test("leaveTerminal: back to the chat only once the question is gone and the person has stopped typing", () => {
  const quiet = { menuNow: false, menuSeen: true, working: false, workSince: 0, quietMs: 5000 };
  assert.equal(leaveTerminal(quiet), true, "the menu answered there has left the screen");
  assert.equal(leaveTerminal({ ...quiet, menuNow: true }), false, "a menu still on the screen");
  assert.equal(leaveTerminal({ ...quiet, quietMs: 200 }), false, "a key just now: one keypress never flips the pane");
  assert.equal(leaveTerminal({ ...quiet, menuSeen: false }), false, "a question no card could read, the AI not at work yet");
});

test("leaveTerminal: for a question no card could read, only work begun after the person's Enter counts", () => {
  // Entered at 10 s; the person's typing echoes as output, which the lamp reads as work after 2.5 s.
  const unread = { menuNow: false, menuSeen: false };
  assert.equal(leaveTerminal({ ...unread, working: true, workSince: 11_000, quietMs: 2000 }), false,
    "typing for 4 s, pause 2 s, no Enter: stays in the terminal");
  assert.equal(leaveTerminal({ ...unread, working: true, workSince: 16_500, sentAt: 16_000, quietMs: 2000 }), true,
    "Enter, then the AI's output: back to the chat");
  assert.equal(leaveTerminal({ ...unread, working: true, workSince: 11_000, sentAt: 16_000, quietMs: 2000 }), false,
    "work that began before the Enter (the typing's echo) is not the answer taken");
  assert.equal(leaveTerminal({ ...unread, working: true, workSince: 3000, quietMs: 3000 }), false,
    "entered with a stale working: stays");
  assert.equal(leaveTerminal({ ...unread, working: true, workSince: 16_500, sentAt: 16_000, quietMs: 1499 }), false);
});

test("the send button stops the AI while it works, takes back a line not typed yet first, and sends otherwise; Esc in an empty composer does the same", () => {
  assert.equal(composerAction(false, undefined), "send");
  assert.equal(composerAction(false, "Onioning… (3s)"), "stop", "the CLI's own working line is up");
  assert.equal(composerAction(false, "Onioning… (3s)", true), "send", "a question is the card's");
  assert.equal(composerAction(true, "Onioning… (3s)"), "cancel", "a line still waiting to be typed is taken back before the AI is stopped");
  assert.equal(composerAction(true, undefined), "cancel");
  const esc = { key: "Escape", shiftKey: false, isComposing: false, keyCode: 27 };
  assert.equal(composerKey(esc, true), "stop");
  assert.equal(composerKey(esc, false), "none", "words in the field: Esc is not a stop");
  assert.equal(composerKey(esc), "none", "a card's words field never stops");
  assert.equal(composerKey({ ...esc, isComposing: true }, true), "none", "the IME's Esc");
});

test("the stop key is the CLI's own interrupt (Esc for Claude Code and Codex 0.172), typed only out of copy mode and never over a question", async () => {
  const run = async (asks: boolean[], leave?: () => Promise<boolean>) => {
    const pressed: string[] = [];
    const how = await chatStop(leave, { asking: () => asks.shift() ?? false, working: () => true, press: (key) => pressed.push(key) });
    return { how, pressed };
  };
  assert.deepEqual(await run([false, false]), { how: "stopped", pressed: ["\x1b"] });
  assert.deepEqual(await run([true], () => assert.fail("left copy mode for a question")), { how: "asking", pressed: [] });
  assert.deepEqual(await run([false], async () => false), { how: "notSent", pressed: [] }, "still in copy mode: Esc would only leave it");
  assert.deepEqual(await run([false, true], async () => true), { how: "asking", pressed: [] }, "a question came up while copy mode was left");
});

test("a line taken back before its first key is never typed; once typed it is too late to take back", async () => {
  const typed: string[] = [];
  let wanted = true;
  let out!: () => void;
  const left = new Promise<boolean>((done) => (out = () => done(true)));
  const line = chatLine(() => left, (entered) => (typed.push("go on"), entered("sent"), true), () => wanted);
  wanted = false;
  out();
  assert.equal(await line, "notSent");
  assert.equal(typed.length, 0);
  // With nothing to wait for, `typing` is asked before chatLine returns: chat-view's sendLine draws a local line as on its way.
  let asked = false;
  const local = chatLine(undefined, (entered) => (typed.push("go on"), entered("sent"), true), () => (asked = true));
  assert.equal(asked, true);
  assert.equal(await local, "sent");
  assert.deepEqual(typed, ["go on"]);
});

test("the lamp lit past a turn's end is no work to stop: the button sends, and a stop then types no Esc", async () => {
  // The lamp stays "working" 3 s after the last output (pet.ts QUIET_MS) while the screen shows the prompt at rest.
  assert.equal(composerAction(false, liveLine(fixture("claude-idle.txt"))), "send");
  const pressed: string[] = [];
  assert.equal(await chatStop(undefined, { asking: () => false, working: () => false, press: (key) => pressed.push(key) }), "idle");
  assert.deepEqual(pressed, [], "the turn ended between the button and the press: read again, nothing typed");
});

test("a stop waits for the CLI's working line to go, gives up when it stays, and ends when the line comes back", () => {
  const asked = { asked: true, over: false, at: 1000 };
  assert.deepEqual(stopState(asked, true, 2000), { asked: true, over: false }, "the Esc on its way");
  assert.deepEqual(stopState(asked, false, 2500), { asked: false, over: true, ended: true }, "the line went: 멈췄어요, its turn's lines let go");
  assert.deepEqual(stopState(asked, true, 1000 + STOP_WAIT_MS + 1), { asked: false, over: false, failed: true }, "the CLI took no Esc: said, and a stop can be pressed again");
  assert.deepEqual(stopState({ asked: false, over: true, at: 1000 }, false, 9000), { asked: false, over: true });
  assert.deepEqual(stopState({ asked: false, over: true, at: 1000 }, true, 9000), { asked: false, over: false }, "at work again: the end mark goes");
});

test("멈췄어요 goes under the row the record cut short, or at the end once a stop pressed here ended the work and the record marks no row", () => {
  const prompt: ChatRow = { kind: "user", at: 1, text: "go" };
  const answer: ChatRow = { kind: "agent", at: 2, text: "half", cancelled: true };
  const none = new Set<string>();
  assert.equal(stoppedEnd([prompt, answer], true, none), false, "the answer's own row says it");
  assert.equal(stoppedEnd([{ kind: "agent", at: 0, text: "earlier" }], true, none), true, "stopped before its first word: the record dropped that prompt");
  assert.equal(stoppedEnd([prompt], false, none), false, "no stop pressed, or the work not over yet: nothing invented");
  // An earlier stop's row, marked before this press, is not this stop's: the prompt dropped after it still gets the end mark.
  assert.equal(stoppedEnd([prompt, answer], true, cutRows([prompt, answer])), true);
  assert.deepEqual([...cutRows([prompt, answer, { kind: "work", at: 3, steps: [], cancelled: true }])], ["agent:2", "work:3"]);
});

test("a chat moved to another AI shows none of that AI's older talk, and says it is starting while a handoff is on its way", () => {
  const old = { ok: true as const, workflow: { model: "gpt-6.1-sol", events: [{ kind: "prompt" as const, at: 50, text: "an older talk" }] } };
  const fresh = { ok: true as const, workflow: { events: [{ kind: "prompt" as const, at: 50, text: "an older talk" }, { kind: "prompt" as const, at: 120, text: "handed over" }] } };
  const move = { to: "codex" as const, at: 100, up: true, resume: false, typed: true };
  assert.deepEqual(readAfterSwitch(move, old, 200), { read: { ok: false, reason: "no_transcript", why: "starting" }, done: false });
  assert.deepEqual(readAfterSwitch({ ...move, typed: false }, old, 200), { read: { ok: true, workflow: { events: [] } }, done: false }, "nothing handed over: an empty talk");
  assert.deepEqual(readAfterSwitch(move, fresh, 200), { read: fresh, done: true }, "the new talk is written");
  assert.deepEqual(readAfterSwitch(move, old, 100 + 120_001), { read: old, done: true }, "given up on: another PC's clock may be behind");
});

test("a chat that goes back to an AI's own talk shows it at once, with a picked model until a turn names one", () => {
  const read = { ok: true as const, workflow: { model: "gpt-6.1-sol", events: [{ kind: "prompt" as const, at: 50, text: "its own talk" }] } };
  const move = { to: "codex" as const, at: 100, up: true, resume: true, typed: false };
  assert.deepEqual(readAfterSwitch(move, read, 200), { read, done: true });
  assert.deepEqual(readAfterSwitch({ ...move, model: "gpt-6.2-sol" }, read, 200), { read: { ok: true, workflow: { ...read.workflow, model: "gpt-6.2-sol" } }, done: false });
  const turned = { ok: true as const, workflow: { model: "gpt-6.2-sol", events: [...read.workflow.events, { kind: "prompt" as const, at: 150, text: "next" }] } };
  assert.deepEqual(readAfterSwitch({ ...move, model: "gpt-6.2-sol" }, turned, 200), { read: turned, done: true });
});

import { test } from "node:test";
import assert from "node:assert/strict";

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { menuFrom, menuQuestion, menuTabs, withoutSidebar } from "./menu.ts";

const screen = (text: string) => text.split("\n");
/** Screens captured from the real CLIs under node-pty (src/phone/fixtures). */
const captured = (name: string) => screen(readFileSync(join(import.meta.dirname, "fixtures", name), "utf8"));

test("Claude Code's boxed permission prompt", () => {
  const snapshot = screen(`● I'll run the tests.

╭──────────────────────────────────────────────────────────────╮
│ Bash command                                                 │
│                                                              │
│   npm test                                                   │
│   Run the test suite                                         │
│                                                              │
│ Do you want to proceed?                                      │
│ ❯ 1. Yes                                                     │
│   2. Yes, and don't ask again for npm test commands in       │
│      C:\\work\\api                                              │
│   3. No, and tell Claude what to do differently (esc)        │
╰──────────────────────────────────────────────────────────────╯
`);
  assert.deepEqual(menuFrom(snapshot), [
    { n: 1, label: "Yes" },
    { n: 2, label: "Yes, and don't ask again for npm test commands in", detail: "C:\\work\\api" },
    { n: 3, label: "No, and tell Claude what to do differently (esc)" },
  ]);
});

test("Claude Code 2.x prompt without a box, with its key-hint footer", () => {
  const snapshot = screen(` Edit file
 src/app.ts
 ───────────────────────────────
 Do you want to make this edit to app.ts?
 ❯ 1. Yes
   2. Yes, allow all edits during this session (shift+tab)
   3. No, and tell Claude what to do differently (esc)

 Esc to cancel · Tab to add additional instructions`);
  assert.deepEqual(menuFrom(snapshot)?.map((o) => `${o.n} · ${o.label}`), [
    "1 · Yes",
    "2 · Yes, allow all edits during this session (shift+tab)",
    "3 · No, and tell Claude what to do differently (esc)",
  ]);
});

test("Codex's approval prompt", () => {
  const snapshot = screen(`• Running npm test

  Would you like to run the following command?

  $ npm test

› 1. Yes, proceed (y)
  2. Yes, and don't ask again for this command (a)
  3. No, and tell Codex what to do differently (esc)

  Press enter to confirm or esc to cancel`);
  assert.deepEqual(menuFrom(snapshot)?.map((o) => o.n), [1, 2, 3]);
  assert.equal(menuFrom(snapshot)?.[0]?.label, "Yes, proceed (y)");
});

test("two options are a menu too; the cursor may sit on any of them", () => {
  assert.deepEqual(menuFrom(screen(" Trust this folder?\n   1. Yes, proceed\n ❯ 2. No, exit\n")), [
    { n: 1, label: "Yes, proceed" },
    { n: 2, label: "No, exit" },
  ]);
});

test("a numbered list in the agent's answer, with the input box below, is not a menu", () => {
  const claude = screen(`● Here is the plan:
  1. Fix the login timeout
  2. Add a test for it
  3. Update the changelog

╭──────────────────────────────────────────────╮
│ >                                            │
╰──────────────────────────────────────────────╯
  ? for shortcuts`);
  assert.equal(menuFrom(claude), undefined);
  const codex = screen(`• Steps:
  1. Read auth.ts
  2. Patch the expiry check

› Ask Codex to do anything

  ⏎ send   ⌃J newline   ⌃T transcript   ⌃C quit`);
  assert.equal(menuFrom(codex), undefined);
});

test("a list that ends the output is still not a menu unless it counts from 1 without a gap", () => {
  assert.equal(menuFrom(screen("Results:\n  2. second\n  3. third")), undefined);
  assert.equal(menuFrom(screen("  1. one\n  3. three")), undefined);
  assert.equal(menuFrom(screen("  1. only one")), undefined);
  assert.equal(menuFrom(screen("  1. one\n  2. two\nsome more output")), undefined);
});

test("screens with no menu at all", () => {
  assert.equal(menuFrom([]), undefined);
  assert.equal(menuFrom(screen("✻ Thinking… (12s · esc to interrupt)")), undefined);
  assert.equal(menuFrom(screen("PS C:\\work> npm test\n\n> api@1.0.0 test\n> node --test")), undefined);
});

test("Claude Code 2.1.308's question (AskUserQuestion), captured: descriptions, a rule, and the free-text option", () => {
  assert.deepEqual(menuFrom(captured("claude-ask-question.txt")), [
    { n: 1, label: "Red", detail: "Choose red" },
    { n: 2, label: "Green", detail: "Choose green" },
    { n: 3, label: "Blue", detail: "Choose blue" },
    { n: 4, label: "Type something.", freeText: true },
    { n: 5, label: "Chat about this" },
  ]);
  // After "4" and typing: the row holds the answer, and the menu is still there.
  assert.equal(menuFrom(captured("claude-ask-typed.txt"))?.[3]?.label, "purple");
});

test("a question in a named session in tmux: the bars below it are not part of the screen's text", () => {
  const menu = screen(
    "시험이에요?\n\n> 1. 버튼이 떠서 눌렀어요\n     폰에서 누른 거면 이 답이 바로 가요.\n  2. 내역만 보여요\n     대화 내역은 올라오는데 버튼이 없어요.\n  3. Type something.\n" +
    "────────────────────\n  4. Chat about this\n\nEnter to select · ↑/↓ to navigate · Esc to cancel\n",
  );
  const labels = (lines: readonly string[]) => menuFrom(lines)?.map((option) => option.label);
  const want = ["버튼이 떠서 눌렀어요", "내역만 보여요", "Type something.", "Chat about this"];
  assert.deepEqual(labels(menu), want);
  // Claude Code's bar under a session started with --name, as Lepons starts them (2.1.318, seen on a real screen).
  assert.deepEqual(labels([...menu, "──────────────────────────────── lepons ─"]), want);
  assert.deepEqual(labels([...menu, "──────── my-project ──"]), want);
  // tmux's status line, seen on the 58 and 97 sessions, cut at the terminal's width or not.
  assert.deepEqual(labels([...menu, '[lepons-sw] 0:bash*  "* sw" 13:50 05-11월-26']), want);
  assert.deepEqual(labels([...menu, "──── sw ─", '[lepons-ed] 0:bash*  "* my-project" 04:50 05-11']), want);
});

test("a numbered list above the input box stays no menu, with the same bars under it", () => {
  const list = screen("1. first\n2. second\n\n────────\n> \n────────");
  assert.equal(menuFrom([...list, "──────── lepons ─"]), undefined);
  assert.equal(menuFrom([...list, "──────── lepons ─", '[lepons-sw] 0:bash*  "* sw" 13:50 05-11']), undefined);
});

test("Codex 0.162's startup menu, captured", () => {
  assert.deepEqual(menuFrom(captured("codex-hooks-menu.txt"))?.map((o) => o.label), [
    "Review hooks", "Trust all and continue", "Continue without trusting (hooks won't run)",
  ]);
});

test("Claude idle at its prompt after answering, captured: no menu", () => {
  assert.equal(menuFrom(captured("claude-idle.txt")), undefined);
});

test("up to nine options", () => {
  const nine = Array.from({ length: 9 }, (_, i) => `${i === 0 ? "❯" : " "} ${i + 1}. option ${i + 1}`).join("\n");
  assert.equal(menuFrom(screen(nine))?.length, 9);
});

test("Claude's multi-select question: each row's box, the Next line dropped, and the questions' tabs (Claude Code 2.1.322)", () => {
  const lines = captured("claude-ask-multi.txt");
  assert.deepEqual(menuFrom(lines), [
    { n: 1, label: "Red", detail: "Red", checked: true },
    { n: 2, label: "Green", detail: "Green", checked: false },
    { n: 3, label: "Blue", detail: "Blue", checked: true },
    { n: 4, label: "Type something", freeText: true, checked: false },
    { n: 5, label: "Chat about this" },
  ]);
  assert.deepEqual(menuTabs(lines), [{ label: "Colors", done: true }, { label: "Size", done: false }, { label: "Submit", done: false }]);
});

test("the next question of several is a plain menu with the same tabs; the review asks to submit", () => {
  assert.equal(menuFrom(captured("claude-ask-next.txt"))?.some((option) => option.checked !== undefined), false);
  assert.deepEqual(menuTabs(captured("claude-ask-next.txt"))?.map((tab) => tab.label), ["Colors", "Size", "Submit"]);
  assert.deepEqual(menuFrom(captured("claude-ask-review.txt"))?.map((option) => option.label), ["Submit answers", "Cancel"]);
  assert.equal(menuTabs(captured("claude-ask-question.txt")), undefined, "a lone question has no tabs");
});

test("Windows' Claude Code draws the tabs and boxes in ASCII", () => {
  const lines = ["←  [ ] 재현  [×] 두번째  √ Submit  →", "", "Which?", "", "> 1. [×] Red", "  2. [ ] Blue", "", "Enter to select · Esc to cancel"];
  assert.deepEqual(menuTabs(lines), [{ label: "재현", done: false }, { label: "두번째", done: true }, { label: "Submit", done: false }]);
  assert.deepEqual(menuFrom(lines)?.map((option) => option.checked), [true, false]);
});

// OpenCode 1.19.5, captured under node-pty and a headless xterm (src/phone/fixtures/opencode-*).
test("OpenCode's question: numbered options with descriptions, its free-text row, the tab line", () => {
  const lines = captured("opencode-ask-question.txt");
  assert.deepEqual(menuFrom(lines), [
    { n: 1, label: "Red", detail: "Red color" },
    { n: 2, label: "Green", detail: "Green color" },
    { n: 3, label: "Blue", detail: "Blue color" },
    { n: 4, label: "Type your own answer", freeText: true },
  ]);
  assert.deepEqual(menuTabs(lines)?.map((tab) => tab.label), ["Favorite color", "Sizes", "Submit"]);
});

test("OpenCode's multi-select question: boxes ticked as on screen", () => {
  const menu = menuFrom(captured("opencode-ask-multi.txt"));
  assert.deepEqual(menu?.map(({ label, checked }) => [label, checked]), [["S", false], ["M", false], ["L", false], ["Type your own answer", false]]);
});

test("OpenCode's permission prompt is two keys, not digits; its review step is no menu", () => {
  assert.deepEqual(menuFrom(captured("opencode-permission.txt")), [
    { n: 1, label: "Allow once", detail: "→ Edit a.txt", key: "enter" },
    { n: 2, label: "Reject", key: "esc" },
  ]);
  assert.equal(menuFrom(captured("opencode-ask-review.txt")), undefined);
  for (const name of ["opencode-working.txt", "opencode-idle.txt"]) assert.equal(menuFrom(captured(name)), undefined, name);
});

test("OpenCode in a wide pane: its sidebar shares the rows, and is cut off before reading", () => {
  // Captured in a Lepons pane: the sidebar's folder and "• OpenCode 1.19.5" sit under and beside the buttons.
  assert.deepEqual(menuFrom(captured("opencode-permission-wide.txt")), [
    { n: 1, label: "Allow once", detail: "→ Edit a.txt", key: "enter" },
    { n: 2, label: "Reject", key: "esc" },
  ]);
  // A Hangul option takes two cells a letter, so the cut is counted in cells, not letters.
  const pad = (text: string, cells: number) => text + " ".repeat(cells - [...text].reduce((n, c) => n + (/[가-힣]/.test(c) ? 2 : 1), 0));
  const korean = [
    pad("  ┃  색을 고르세요", 92) + "Connect provider",
    pad("  ┃  1. 빨강", 92) + "/connect",
    pad("  ┃  2. 초록", 92) + "/C:\work\demo",
    pad("  ┃  ⇆ tab  ↑↓ select  enter confirm  esc dismiss", 92) + "",
    pad("  ┃", 92) + "• OpenCode 1.19.5",
  ];
  assert.deepEqual(menuFrom(korean)?.map((option) => option.label), ["빨강", "초록"]);
  assert.deepEqual(withoutSidebar(korean)[1], "  ┃  1. 빨강");
});

// Claude Code 2.1.327, captured under node-pty (src/phone/fixtures/claude-*).
test("Claude's permission prompts: the question over the menu, a wrapped label's rest as its detail", () => {
  const bash = captured("claude-permission-bash.txt");
  assert.deepEqual(menuFrom(bash)?.map((option) => option.label), ["Yes", "Yes, and don’t ask again for: node *", "Yes, and switch to auto mode · auto mode handles these prompts for you", "No"]);
  assert.equal(menuQuestion(bash), "Do you want to proceed?", "not the line over the blank one");
  assert.equal(menuTabs(bash), undefined);
  for (const [name, question] of [["claude-permission-write.txt", "Do you want to create a.txt?"], ["claude-permission-edit.txt", "Do you want to make this edit to a.txt?"]] as const) {
    const lines = captured(name);
    assert.deepEqual(menuFrom(lines)?.[1], { n: 2, label: "Yes, and switch to accept edits (auto-approve file edits and common file commands) for this", detail: "session (shift+tab)" }, name);
    assert.equal(menuFrom(lines)?.length, 3, name);
    assert.equal(menuQuestion(lines), question, name);
  }
});

test("Claude's plan approval: its ctrl+g footer, and the row that takes feedback is typed", () => {
  const lines = captured("claude-plan.txt");
  assert.deepEqual(menuFrom(lines), [
    { n: 1, label: "Yes, and use auto mode" },
    { n: 2, label: "Yes, manually approve edits" },
    { n: 3, label: "Tell Claude what to change", detail: "shift+tab to approve with this feedback", freeText: true },
  ]);
  assert.equal(menuQuestion(lines), "Claude has written up a plan and is ready to execute. Would you like to proceed?");
});

test("Claude's unnumbered pickers: the arrows from the cursor's row to the one picked, then Enter", () => {
  const trust = captured("claude-trust.txt");
  assert.deepEqual(menuFrom(trust), [
    { n: 1, label: "No, exit", keys: ["enter"] },
    { n: 2, label: "Yes, I trust this folder", keys: ["down", "enter"] },
  ]);
  const mcp = captured("claude-mcp.txt");
  assert.deepEqual(menuFrom(mcp), [
    { n: 1, label: "Use this MCP server", keys: ["up", "up", "enter"] },
    { n: 2, label: "Use this and all future MCP servers in this project", keys: ["up", "enter"] },
    { n: 3, label: "Continue without using this MCP server", keys: ["enter"] },
  ]);
  assert.equal(menuQuestion(mcp), "MCP servers may execute code or access system resources. All tool calls require approval. Learn more in the MCP documentation.");
  // Without its footer, with a row out of line, with no cursor or no blank line over it, it is no menu.
  const picker = ["Pick one", "", " ❯ No, exit", "   Yes, I trust this folder", "", " Enter to confirm · Esc to cancel"];
  assert.equal(menuFrom(picker)?.length, 2);
  assert.equal(menuFrom(picker.slice(0, 4)), undefined, "no footer");
  assert.equal(menuFrom(picker.with(3, "  Yes, I trust this folder")), undefined, "a row out of line");
  assert.equal(menuFrom(picker.with(2, "   No, exit")), undefined, "no cursor");
  assert.equal(menuFrom(picker.with(1, "text right above")), undefined, "no blank line over it");
  // Claude's input box between its rules, with a two-line draft, is no picker.
  assert.equal(menuFrom(["output", "────────", "❯ first line", "  second line", "────────", "  esc to interrupt"]), undefined);
});

test("a tall multi-select question: every line of it, its bars gone, and its tabs", () => {
  const lines = captured("claude-ask-long-multi.txt");
  assert.equal(menuQuestion(lines), "Which fruits should go into the smoothie this morning? Pick every fruit you would actually enjoy drinking, keeping in mind that some of them are sour and some are quite sweet, and that the blender is small.");
  assert.deepEqual(menuFrom(lines)?.map(({ label, checked, freeText }) => [label, checked, freeText]), [["Apple", false, undefined], ["Banana", false, undefined], ["Mango", false, undefined], ["Type something", false, true], ["Chat about this", undefined, undefined]]);
  assert.deepEqual(menuTabs(lines), [{ label: "Fruits", done: false }, { label: "Size", done: false }, { label: "Submit", done: false }]);
});

test("the questions after a pick: ticked, the second, the review", () => {
  const ticked = captured("claude-ask-ticked.txt");
  assert.deepEqual(menuFrom(ticked)?.map(({ label, checked }) => [label, checked]), [["Apple", true], ["Banana", false], ["Type something", false], ["Chat about this", undefined]]);
  assert.equal(menuQuestion(ticked), "Which fruits?");
  assert.deepEqual(menuTabs(ticked)?.map((tab) => tab.done), [true, false, false]);
  const second = captured("claude-ask-second.txt");
  assert.deepEqual(menuFrom(second)?.map((option) => option.label), ["Small", "Large", "Type something.", "Chat about this"]);
  assert.equal(menuQuestion(second), "Which size?");
  const review = captured("claude-ask-review2.txt");
  assert.deepEqual(menuFrom(review)?.map((option) => option.label), ["Submit answers", "Cancel"]);
  assert.equal(menuQuestion(review), "● Which fruits? → Apple ● Which size? → Small");
  assert.deepEqual(menuTabs(review), [{ label: "Fruits", done: true }, { label: "Size", done: true }, { label: "Submit", done: false }]);
});

test("a lone question's header chip is not its question; an older question's tabs over Claude's rule are not its tabs", () => {
  assert.equal(menuQuestion(captured("claude-ask-question.txt")), "Which color do you like?");
  const older = ["←  ☒ Colors  ☐ Size  ✔ Submit  →", "old question", "────────", "Do you want to proceed?", "❯ 1. Yes", "  2. No", "", "Esc to cancel"];
  assert.equal(menuTabs(older), undefined);
  assert.equal(menuQuestion(["1. old list", "Ask", "────", " 1. Yes", " 2. No"]), "Ask", "past a rule, and not into an older list");
  assert.equal(menuQuestion(["far away", "", "", "", " 1. Yes", " 2. No"]), undefined);
  assert.equal(menuQuestion(["│ Which one?          │", "│                     │", "│ ❯ 1. A              │", "│   2. B              │"]), "Which one?");
});

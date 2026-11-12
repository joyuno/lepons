import { test } from "node:test";
import assert from "node:assert/strict";

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { menuFrom, menuTabs, withoutSidebar } from "./menu.ts";

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

import { test } from "node:test";
import assert from "node:assert/strict";

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { statusFrom } from "./status.ts";

/** Screens captured from the real CLIs under node-pty (src/phone/fixtures). */
const captured = (name: string) => readFileSync(join(import.meta.dirname, "fixtures", name), "utf8").split("\n");

test("Claude Code's spinner line, without its glyph, above the input box and footer", () => {
  assert.equal(statusFrom(captured("claude-working.txt")), "Gallivanting… (Tracking ponytail mode...… · 0s)");
  assert.equal(statusFrom(captured("claude-thinking.txt")), "Mulling… (2s · thinking)");
});

test("Codex's working line, and its start-up line", () => {
  assert.equal(statusFrom(captured("codex-working.txt")), "Working (5s • esc to interrupt)");
  assert.equal(statusFrom(captured("codex-starting.txt")), "Starting MCP servers (9/10): playwright (2s • esc to interrupt) · Running hooks");
});

test("Claude's finished line is not a working line", () => {
  // No spinner verb: the fallback takes the last line of output instead.
  assert.equal(statusFrom(captured("claude-idle.txt")), "✻ Brewed for 6s · done 5:33 PM");
});

test("otherwise the last real line: ANSI stripped, box borders, rules and prompts skipped", () => {
  const screen = [
    "\x1b[32m$ npm test\x1b[0m",
    "\x1b[1m  ✔ 12 passed\x1b[0m   ",
    "│                    │",
    "──────────────────────",
    "❯ ",
    "  ? for shortcuts",
  ];
  assert.equal(statusFrom(screen), "✔ 12 passed");
  assert.equal(statusFrom(["", "  ", "────"]), undefined);
});

test("Claude Code's permission mode line under the box is never the summary", () => {
  for (const footer of ["⏵⏵ bypass permissions on (shift+tab to cycle)", "⏵⏵ bypass permissions on", ">> bypass permissions on", "⏸ plan mode on", "⏵⏵ accept edits on · 2 shells"]) {
    assert.equal(statusFrom(["Fixed the test.", "╭───╮", "│ > │", "╰───╯", footer]), "Fixed the test.", footer);
  }
});

test("the bar above Claude Code's footer is never the summary, however it is drawn", () => {
  for (const bar of ["------------", "────────────", "━━━━━━━━", "============", "╌╌╌╌╌╌╌╌", "──── lepons ────", "▔▔▔▔▔▔", "- - - -"]) {
    assert.equal(statusFrom(["Fixed the test.", bar, "⏵⏵ bypass permissions on"]), "Fixed the test.", bar);
  }
});

test("a line of output with a dash in it stays", () => {
  assert.equal(statusFrom(["- first item"]), "- first item");
  assert.equal(statusFrom(["npm run build -- --watch"]), "npm run build -- --watch");
});

test("tmux's status line is never the summary", () => {
  assert.equal(statusFrom(["Fixed the test.", '[lepons-sw] 0:bash*  "* sw" 13:50 05-11월-26']), "Fixed the test.");
});

test("output that only mentions a permission mode stays", () => {
  assert.equal(statusFrom(["plan mode needs a test"]), "plan mode needs a test");
});

test("a markdown bullet in the agent's output is not a spinner", () => {
  assert.equal(statusFrom(["* first item", "* second item"]), "* second item");
});

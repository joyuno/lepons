import { test } from "node:test";
import assert from "node:assert/strict";

import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { PhoneAnswer, PhoneAskForm } from "../shared/ipc.ts";
import { answersFit, askUserMenu, questionOf, screenRows, typeAnswers, typedLine, type AnswerTerm } from "./answer.ts";
import { reflow } from "./screen.ts";

const captured = (name: string) => readFileSync(join(import.meta.dirname, "fixtures", name), "utf8").split("\n");

const form: PhoneAskForm = {
  id: "toolu_01",
  questions: [
    { header: "Plan", question: "Which plan should we follow for the migration this week, given that the team is short of people and the release train leaves on Thursday?", multiSelect: false, options: [{ label: "Fast" }, { label: "Safe" }, { label: "Later" }] },
    { header: "여러개", question: "Which extras?", multiSelect: true, options: [{ label: "Logs" }, { label: "Metrics" }, { label: "Alerts" }, { label: "Docs" }] },
    { header: "Name", question: "What name?", multiSelect: false, options: [{ label: "Alpha" }, { label: "Beta" }] },
    { header: "Go", question: "Start now?", multiSelect: false, options: [{ label: "Yes" }, { label: "No" }] },
  ],
};

/**
 * Claude's question set as Windows' Claude Code draws it (ASCII boxes, "> " cursor, a long question's "│ " lines),
 * taking keys a moment after they are written, as a terminal does. `deaf`: keys that it ignores.
 */
function fakeClaude(set: PhoneAskForm, opts: { at?: number; ticked?: number[]; tabLine?: boolean; deaf?: string; blankMs?: number } = {}) {
  const count = set.questions.length;
  let tab = opts.at ?? 0;
  let cursor = 1;
  let typing: string | undefined;
  let state: "asking" | "done" | "cancelled" = "asking";
  const ticks = new Map<number, Set<number>>([[tab, new Set(opts.ticked ?? [])]]);
  const answered = new Map<number, string>();
  const pending: Array<{ at: number; data: string }> = [];
  const written: string[] = [];
  let clock = 0;
  let blankUntil = 0;
  const reviewing = () => count > 1 && tab === count;
  const apply = (data: string) => {
    if (opts.deaf !== undefined && data === opts.deaf) return;
    const question = set.questions[tab];
    if (reviewing()) {
      if (data === "1") state = "done";
      else if (data === "2") state = "cancelled";
      else if (data === "\x1b[D") tab -= 1;
      return;
    }
    if (!question) return;
    const next = () => {
      tab += 1;
      cursor = 1;
      typing = undefined;
      if (tab === count) blankUntil = clock + (opts.blankMs ?? 0);
      if (tab === count && count === 1) state = "done";
    };
    if (typing !== undefined) {
      if (data === "\r") {
        answered.set(tab, typing);
        next();
      } else typing += data;
      return;
    }
    if (data === "\x1b[D") tab = Math.max(0, tab - 1);
    else if (data === "\t" && question.multiSelect) {
      answered.set(tab, [...(ticks.get(tab) ?? [])].sort().map((i) => question.options[i]!.label).join(", "));
      next();
    } else if (/^\d$/.test(data)) {
      const n = Number(data);
      if (n <= question.options.length) {
        cursor = n;
        if (question.multiSelect) {
          const box = ticks.get(tab) ?? new Set<number>();
          if (box.has(n - 1)) box.delete(n - 1);
          else box.add(n - 1);
          ticks.set(tab, box);
        } else {
          answered.set(tab, question.options[n - 1]!.label);
          next();
        }
      } else if (n === question.options.length + 1) {
        cursor = n;
        typing = "";
      }
    }
  };
  const screen = (): string[] => {
    if (state !== "asking") return ["● Answered", "", "> ", "  ? for shortcuts"];
    if (clock < blankUntil) return ["> Ask me four things", "", "✻ Drawing…"];
    const lines = ["> Ask me four things", "─".repeat(60)];
    if (count > 1 && opts.tabLine !== false) {
      lines.push(`←  ${set.questions.map((q, i) => `[${answered.has(i) ? "×" : " "}] ${q.header}`).join("  ")}  √ Submit  →`);
    }
    if (reviewing()) {
      lines.push("Review your answers", ...set.questions.flatMap((q, i) => [` ● ${q.question}`, `   → ${answered.get(i) ?? ""}`]));
      lines.push("Ready to submit your answers?", "> 1. Submit answers", "  2. Cancel");
      return lines;
    }
    const question = set.questions[tab]!;
    const words = question.question.match(/.{1,40}(\s|$)/g)!.map((part) => part.trim());
    lines.push(...(words.length > 1 ? words.map((part) => `│ ${part}`) : words));
    question.options.forEach((option, i) => {
      const box = question.multiSelect ? `[${ticks.get(tab)?.has(i) ? "√" : " "}] ` : "";
      lines.push(`${cursor === i + 1 ? ">" : " "} ${i + 1}. ${box}${option.label}`, `     About ${option.label}`);
    });
    const free = question.options.length + 1;
    lines.push(`${cursor === free ? ">" : " "} ${free}. ${question.multiSelect ? "[ ] " : ""}${typing ? typing : question.multiSelect ? "Type something" : "Type something."}`);
    lines.push("─".repeat(60), `  ${free + 1}. Chat about this`, "Enter to select · Tab/Arrow keys to navigate · Esc to cancel");
    return lines;
  };
  const term: AnswerTerm = {
    write(data) {
      written.push(data);
      pending.push({ at: clock + 80, data });
    },
    screen,
    litTab: () => (count > 1 && opts.tabLine !== false && state === "asking" ? tab : undefined),
    async wait(ms) {
      clock += ms;
      while (pending[0] && pending[0].at <= clock) apply(pending.shift()!.data);
    },
  };
  return { term, written, answered, state: () => state };
}

const answers: PhoneAnswer[] = [{ picks: [1] }, { picks: [0, 2] }, { text: "Gamma 3" }, { picks: [0] }];

test("the PC types a whole question set: back to the first, each answer, then Submit", async () => {
  // On the second question already, with Metrics ticked at the desk: unticked, Logs and Alerts ticked.
  const claude = fakeClaude(form, { at: 1, ticked: [1] });
  assert.deepEqual(await typeAnswers(claude.term, form, answers), { ok: true });
  assert.equal(claude.state(), "done");
  assert.deepEqual(Object.fromEntries(claude.answered), { 0: "Safe", 1: "Logs, Alerts", 2: "Gamma 3", 3: "Yes" });
  assert.deepEqual(claude.written, ["\x1b[D", "2", "1", "2", "3", "\t", "3", "Gamma 3", "\r", "1", "1"]);
});

test("without a readable tab line (a narrow pane wraps it), the question is told by its text", async () => {
  const claude = fakeClaude(form, { at: 3, tabLine: false });
  assert.deepEqual(await typeAnswers(claude.term, form, answers), { ok: true });
  assert.deepEqual(Object.fromEntries(claude.answered), { 0: "Safe", 1: "Logs, Alerts", 2: "Gamma 3", 3: "Yes" });
});

test("a moment with no menu while the review draws is not the set gone: Submit is still pressed", async () => {
  const claude = fakeClaude(form, { blankMs: 600 });
  assert.deepEqual(await typeAnswers(claude.term, form, answers), { ok: true });
  assert.equal(claude.state(), "done");
  assert.equal(claude.written.at(-1), "1");
});

test("a key the screen does not take stops the typing there, saying which question", async () => {
  const claude = fakeClaude(form, { deaf: "\t" });
  assert.deepEqual(await typeAnswers(claude.term, form, answers), { ok: false, step: 1, reason: "stuck" });
  assert.equal(claude.state(), "asking");
  const elsewhere = fakeClaude({ ...form, questions: [{ ...form.questions[0]!, question: "Something else entirely?" }] });
  assert.deepEqual(await typeAnswers(elsewhere.term, { ...form, questions: [form.questions[2]!] }, [{ picks: [0] }]), { ok: false, step: 0, reason: "where" });
});

test("a lone question goes with its one pick: no review", async () => {
  const lone: PhoneAskForm = { id: "toolu_02", questions: [form.questions[2]!] };
  const claude = fakeClaude(lone);
  assert.deepEqual(await typeAnswers(claude.term, lone, [{ picks: [1] }]), { ok: true });
  assert.deepEqual(Object.fromEntries(claude.answered), { 0: "Beta" });
});

test("answers fit the form only as one per question, in range, words for a single-select", () => {
  assert.equal(answersFit(form, answers), true);
  assert.equal(answersFit(form, answers.slice(0, 3)), false);
  assert.equal(answersFit(form, [{ picks: [0, 1] }, ...answers.slice(1)]), false, "two picks on a single-select");
  assert.equal(answersFit(form, [answers[0]!, { picks: [] }, ...answers.slice(2)]), false, "no tick");
  assert.equal(answersFit(form, [answers[0]!, { text: "x" }, ...answers.slice(2)]), false, "words on a multi-select");
  assert.equal(answersFit(form, [{ picks: [3] }, ...answers.slice(1)]), false, "past the options");
  assert.equal(typedLine(" a\r\nb\x1b[2J "), "a b[2J");
});

test("Claude's question set is told by its footer and rows, or its review; other menus are not", () => {
  for (const name of ["claude-ask-question.txt", "claude-ask-multi.txt", "claude-ask-next.txt", "claude-ask-long-multi.txt", "claude-ask-typed.txt", "claude-ask-review.txt", "claude-ask-review2.txt"]) {
    assert.equal(askUserMenu(captured(name)), true, name);
  }
  for (const name of ["claude-plan.txt", "claude-permission-bash.txt", "claude-trust.txt", "claude-idle.txt", "opencode-ask-question.txt"]) {
    assert.equal(askUserMenu(captured(name)), false, name);
  }
});

test("a question read off the screen, whole or only its end, is the form's", () => {
  assert.equal(questionOf(form, "Which extras?"), 1);
  assert.equal(questionOf(form, "the team is short of people and the release train leaves on Thursday?"), 0);
  assert.equal(questionOf(form, "Which colour?"), undefined);
  assert.equal(questionOf(form, undefined), undefined);
});

test("a row xterm marks wrapped joins the one before only when that one reaches the right edge", () => {
  const cols = 20;
  const row = (text: string, isWrapped = false) => ({
    isWrapped, length: cols, translateToString: () => text.trimEnd(),
    getCell: (x: number) => ({ getWidth: () => 1, getChars: () => text[x] ?? "", isInverse: () => 0, getBgColorMode: () => 0 }),
  });
  // A real wrap; then Claude's own next option, left marked wrapped under a padded description row.
  const rows = [row("> 1. A label that is"), row("long", true), row("     about it        "), row("  2. Next", true)];
  const term = { rows: rows.length, cols, buffer: { active: { type: "normal", length: rows.length, getLine: (y: number) => rows[y] } } };
  assert.deepEqual(reflow(screenRows(term, 0)), ["> 1. A label that islong", "     about it", "  2. Next"]);
  assert.deepEqual(screenRows({ ...term, buffer: { active: { ...term.buffer.active, type: "alternate" } } }, 0).map((one) => one.wrapped), [false, false, false, false]);
});

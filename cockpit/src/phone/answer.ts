import type { PhoneAnswer, PhoneAnswerResult, PhoneAskForm } from "../shared/ipc.ts";
import { MAX_INPUT } from "./input.ts";
import { menuFrom, menuQuestion } from "./menu.ts";
import { reflow } from "./screen.ts";

/**
 * The phone's answers to a whole AskUserQuestion set, typed by the PC into the terminal that shows it: a key, then a
 * look at the screen until it moved as that key should move it, then the next. The phone only sends the answers
 * (POST /api/answer); over the relay each key would take a second to show, and the phone could not keep up.
 */

/** What the typing needs from a terminal: the renderer's xterm, or a headless one in a script or test. */
export interface AnswerTerm {
  write(data: string): void;
  /** The screen with some scrollback over it, wrapped rows joined (screen.ts reflow). */
  screen(): string[];
  /** Which tab the tab line lights: 0 for the first question, the questions' count for Submit; undefined when unread. */
  litTab(): number | undefined;
  wait(ms: number): Promise<void>;
}

/** What these read of an xterm (the renderer's, or @xterm/headless in a script): its rows and its active buffer's cells. */
export interface XtermLike {
  rows: number;
  cols: number;
  buffer: { active: {
    type: string;
    length: number;
    getLine(y: number): {
      isWrapped: boolean;
      length: number;
      translateToString(trimRight?: boolean): string;
      getCell(x: number): { getWidth(): number; getChars(): string; isInverse(): number; getBgColorMode(): number } | undefined;
    } | undefined;
  } };
}

/**
 * The rows from `from` down, as reflow takes them. A row xterm marks wrapped is joined to the one before only when
 * that one's text reaches the right edge: Claude Code's redraws leave the mark on rows it laid out itself (seen in a
 * 46-column pane: a description's last row glued to the next option, "… services.   2. [√] Metrics", and the menu
 * read as none). A full-screen app (OpenCode) on the alternate screen is marked nearly everywhere: never joined.
 */
export function screenRows(term: XtermLike, from: number): Array<{ text: string; wrapped: boolean }> {
  const buffer = term.buffer.active;
  const reachesEdge = (y: number) => {
    const line = buffer.getLine(y);
    for (let x = (line?.length ?? 0) - 1; line && x >= 0; x--) if (line.getCell(x)?.getChars().trim()) return x >= term.cols - 2;
    return false;
  };
  const rows: Array<{ text: string; wrapped: boolean }> = [];
  for (let y = from; y < buffer.length; y++) {
    const line = buffer.getLine(y);
    if (line) rows.push({ text: line.translateToString(true), wrapped: buffer.type === "normal" && line.isWrapped && reachesEdge(y - 1) });
  }
  return rows;
}

/** The screen with 60 rows of scrollback over it, where a tall question pushes its text and tab line; `from` is its first row. */
export function askLines(term: XtermLike): { lines: string[]; from: number } {
  const from = Math.max(0, term.buffer.active.length - term.rows - 60);
  return { lines: reflow(screenRows(term, from)), from };
}

/**
 * Which of the tabs ("←  ☒ Fruits  ☐ Size  ✔ Submit  →") is the question on screen: Claude only colours that one,
 * inverse or with a background, so it is read off the cells from row `from` down. None unless exactly one tab is lit.
 */
export function litTab(term: XtermLike, from: number, labels: readonly string[]): number | undefined {
  const buffer = term.buffer.active;
  for (let y = buffer.length - 1; y >= from; y--) {
    const line = buffer.getLine(y);
    if (!line || !/^\s*←.*→\s*$/.test(line.translateToString(true))) continue;
    // The row's text with each character's lit or not; a wide character's second cell holds nothing.
    let text = "";
    const lit: boolean[] = [];
    for (let x = 0; x < line.length; x++) {
      const cell = line.getCell(x);
      if (!cell || cell.getWidth() === 0) continue;
      const chars = cell.getChars() || " ";
      text += chars;
      for (let i = 0; i < chars.length; i++) lit.push(cell.isInverse() !== 0 || cell.getBgColorMode() !== 0);
    }
    const shown: number[] = [];
    let after = 0;
    labels.forEach((label, i) => {
      const at = text.indexOf(label, after);
      if (at < 0) return;
      after = at + label.length;
      if (lit.slice(at, after).some(Boolean)) shown.push(i);
    });
    return shown.length === 1 ? shown[0] : undefined;
  }
  return undefined;
}

const POLL_MS = 40;
/** How long one key may take to show on screen before the typing stops there. */
const STEP_MS = 1500;
const LEFT = "\x1b[D";

const squash = (text: string) => text.replace(/\s+/g, "");
const review = (lines: readonly string[]) => menuFrom(lines)?.some((option) => /^submit answers$/i.test(option.label)) ?? false;

/**
 * Which of the form's questions `said` (a question paragraph read off the screen, menuQuestion) is. A tall question's
 * paragraph is only its end, and a narrow pane's tab labels, wrapped under the tab line, can come before a short one.
 */
export function questionOf(form: PhoneAskForm, said: string | undefined): number | undefined {
  const read = said === undefined ? "" : squash(said);
  if (read === "") return undefined;
  const at = form.questions.findIndex(({ question }) => {
    const asked = squash(question);
    return asked.includes(read.slice(0, 30)) || asked.includes(read.slice(-30)) || read.includes(asked.slice(0, 30));
  });
  return at < 0 ? undefined : at;
}

/**
 * Claude's AskUserQuestion on screen, told by its footer ("Tab/Arrow keys to navigate", "↑/↓ to navigate") over a
 * "Chat about this" or "Type something" row, or by its review (Submit answers, Cancel). A permission or plan prompt
 * has neither.
 */
export function askUserMenu(lines: readonly string[]): boolean {
  const menu = menuFrom(lines);
  if (!menu) return false;
  if (review(lines) && menu.some((option) => /^cancel$/i.test(option.label))) return true;
  const tail = lines.filter((line) => line.trim() !== "").slice(-3).join(" ");
  return /(?:Tab\/Arrow keys|↑\/↓) to navigate/.test(tail) && menu.some((option) => option.freeText || /^chat about this$/i.test(option.label));
}

/** The form's question the screen shows, by the lit tab or else by its text; the questions' count for the review. */
function shownAt(form: PhoneAskForm, term: AnswerTerm): number | undefined {
  const lines = term.screen();
  if (!menuFrom(lines)) return undefined;
  if (review(lines)) return form.questions.length;
  return term.litTab() ?? questionOf(form, menuQuestion(lines));
}

/** The answers fit the form: one per question, a single-select's one pick or words, a multi-select's picks. */
export function answersFit(form: PhoneAskForm, answers: readonly PhoneAnswer[]): boolean {
  return answers.length === form.questions.length && form.questions.every((question, i) => {
    const answer = answers[i]!;
    if ("text" in answer) return !question.multiSelect;
    const inRange = answer.picks.every((pick) => pick < question.options.length);
    return inRange && (question.multiSelect ? answer.picks.length >= 1 : answer.picks.length === 1);
  });
}

/** Typed words as one line: no newline sends early, no control character reaches the agent. */
export const typedLine = (text: string) => text.replace(/[\r\n]+/g, " ").replace(/[\x00-\x1f\x7f]/g, "").trim();

/** POST /api/answer's answers as the phone sent them, all or nothing: four at most, each only `picks` (distinct, 0 to 3) or only `text`. */
export function answersOf(value: unknown): PhoneAnswer[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 4) return undefined;
  const answers: PhoneAnswer[] = [];
  for (const one of value as unknown[]) {
    if (typeof one !== "object" || one === null || Array.isArray(one) || Object.keys(one).length !== 1) return undefined;
    const { picks, text } = one as { picks?: unknown; text?: unknown };
    if (typeof text === "string") {
      if (text.length > MAX_INPUT || typedLine(text) === "") return undefined;
      answers.push({ text: typedLine(text) });
    } else if (Array.isArray(picks) && picks.length >= 1 && picks.length <= 4 && picks.every((pick) => Number.isInteger(pick) && pick >= 0 && pick <= 3) && new Set(picks).size === picks.length) {
      answers.push({ picks: [...(picks as number[])] });
    } else return undefined;
  }
  return answers;
}

/**
 * Types `answers` into the question set on screen: back to question 1 (Left), then each question -- a single-select's
 * digit; a multi-select's digits for the boxes to change, then Tab; typed words on the "Type something" row, then
 * Enter -- and "Submit answers" on the review. Each key waits for the screen to show it took. Stops at the first key
 * that did not: `step` is the question it stopped at, the questions' count for the review.
 */
export async function typeAnswers(term: AnswerTerm, form: PhoneAskForm, answers: readonly PhoneAnswer[]): Promise<PhoneAnswerResult> {
  const count = form.questions.length;
  const until = async (done: () => boolean): Promise<boolean> => {
    for (let waited = 0; ; waited += POLL_MS) {
      if (done()) return true;
      if (waited >= STEP_MS) return false;
      await term.wait(POLL_MS);
    }
  };
  /** The question set left the screen and stays gone for a few reads: not a frame caught mid-redraw. */
  const gone = async () => {
    for (let read = 0; read < 4; read++) {
      if (askUserMenu(term.screen())) return false;
      if (read < 3) await term.wait(100);
    }
    return true;
  };
  const stop = (step: number, reason: Extract<PhoneAnswerResult, { ok: false }>["reason"]): PhoneAnswerResult => ({ ok: false, step, reason });

  let at = shownAt(form, term);
  if (at === undefined) return stop(0, "where");
  for (let presses = 0; at > 0; presses++) {
    const from: number = at;
    if (presses > count) return stop(from, "stuck");
    term.write(LEFT);
    if (!(await until(() => (at = shownAt(form, term) ?? from) < from))) return stop(from, "stuck");
  }

  for (const [i, question] of form.questions.entries()) {
    const answer = answers[i]!;
    const option = (n: number) => menuFrom(term.screen())?.find((one) => one.n === n);
    if ("text" in answer) {
      const row = question.options.length + 1;
      term.write(String(row));
      const cursor = new RegExp(`^\\s*[>❯›]\\s*${row}[.)]`);
      if (!(await until(() => term.screen().some((line) => cursor.test(line))))) return stop(i, "stuck");
      const words = typedLine(answer.text);
      term.write(words);
      const shown = () => {
        const typed = option(row);
        return typed !== undefined && squash(`${typed.label}${typed.detail ?? ""}`).startsWith(squash(words).slice(0, 80));
      };
      if (!(await until(shown))) return stop(i, "typed");
      term.write("\r");
    } else if (question.multiSelect) {
      for (let pick = 0; pick < question.options.length; pick++) {
        const want = answer.picks.includes(pick);
        const box = () => option(pick + 1)?.checked;
        if (!(await until(() => box() !== undefined))) return stop(i, "stuck");
        if (box() === want) continue;
        term.write(String(pick + 1));
        if (!(await until(() => box() === want))) return stop(i, "stuck");
      }
      term.write("\t");
    } else term.write(String(answer.picks[0]! + 1));
    // On to the next question; after the last of several, the review. A lone question may send at once instead.
    if (!(await until(() => shownAt(form, term) === i + 1 || (count === 1 && !askUserMenu(term.screen()))))) return stop(i, "stuck");
  }

  // A blank frame while the review draws is not the set gone: Submit is pressed once the review shows.
  for (let look = 0; look < 2; look++) {
    const submit = menuFrom(term.screen())?.find((option) => /^submit answers$/i.test(option.label));
    if (submit) {
      term.write(String(submit.n));
      if (!(await until(() => !askUserMenu(term.screen())))) return stop(count, "submit");
    }
    if (await gone()) return { ok: true };
  }
  return stop(count, "submit");
}

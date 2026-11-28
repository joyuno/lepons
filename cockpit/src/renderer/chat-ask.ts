import type { PhoneAsk } from "../shared/ipc.ts";
import { typedLine } from "../phone/answer.ts";
import { phoneAsk } from "../phone/ask.ts";
import { keys } from "../phone/input.ts";
import { menuFrom, menuTabs, withoutSidebar } from "../phone/menu.ts";

/*
 * The chat's question card, read off the terminal's screen (phone/menu.ts is the phone's reading, and stays as the
 * phone has it): the phone's menu, made into a card the PC answers whole -- a multi-select's boxes sent with its own
 * Submit, a question set's tabs, a free-text row's words -- and a little more than the phone reads (a yes/no line, a
 * longer picker, OpenCode's review). Anything else with a key hint at the foot of the screen is a card of its lines
 * and the keys it shows. Every key typed for a card is typed only while the screen still shows what it was drawn for.
 */

/** The names a card may press: the phone's keys (phone/input.ts), a yes/no line's letters, and Backspace (a free-text field's). */
export const PC_KEYS: Record<string, string> = { ...keys, y: "y", n: "n", backspace: "\x7f" };

export type CardOption = PhoneAsk["options"][number] & {
  /** A yes/no line's letter, then its Enter while the line still waits with that letter typed. */
  typed?: "y" | "n";
  /**
   * Claude's "Chat about this" (AskUserQuestion, under its rule): no answer -- its digit ends the whole question set
   * as "the user wants to clarify", whatever was answered. The card shows it apart, as its own button.
   */
  chat?: true;
};

export interface ChatCard {
  /** What the card was drawn from: a press acts only while a read of the screen gives the same. */
  id: string;
  /** "menu": the phone's reading. "more": one only the PC reads. "raw": none could read it: the screen's lines, its keys. */
  kind: "menu" | "more" | "raw";
  question?: string;
  options: CardOption[];
  /**
   * A multi-select: its boxes are ticked on the card, then pressed and gone on with in one go. "tab": on to the next
   * question (Claude's and OpenCode's sets); "row": down to the row that submits, then Enter -- its number when it has
   * one (`row`), else the option it sits under (`after`).
   */
  multi?: { submit: "tab" | "row"; row?: number; after?: number };
  tabs?: PhoneAsk["tabs"];
  tab?: number;
  /** The key back to the question before: Left in Claude's sets, Shift+Tab in OpenCode's ("⇆ tab"). */
  back?: "left" | "backtab";
  /** The numbered row the screen's cursor is on, when it marks one. */
  cursor?: number;
  /** A lone multi-select's cursor is on its Submit row. */
  onSubmit?: boolean;
  /** Under the question: OpenCode's review lines; a raw card's lines as the screen has them. */
  lines?: string[];
  /** A raw card's keys: the arrows, Enter, Esc, and the digits (and y/n, Tab) the screen shows. */
  keys?: string[];
  /** A yes/no line's typed letter. */
  echo?: string;
  /** Claude's review of a question set's answers: `lines` what was answered, options 1 "Submit answers", 2 "Cancel". */
  review?: true;
}

const RULE = /^[\s─━═╌╍┄┅╭╮╰╯┌┐└┘├┤┬┴┼│┃║]*$/;
const solid = (text: string) => text !== "" && RULE.test(text);
/** A screen line without its box's side borders, and how far it is indented (menu.ts reads lines so too). */
function unboxed(line: string): { text: string; indent: number } {
  const inner = line.replace(/^\s*[│┃║]/, "").replace(/[│┃║]\s*$/, "").trimEnd();
  const text = inner.trimStart();
  return { text, indent: inner.length - text.length };
}
const FIRST = /^(?:[❯›>▶➜→*]\s*)?1[.)]\s+\S/;
const NUMBERED = /^(?:[❯›>▶➜→*]\s*)?(\d)[.)]\s+\S/;
/** A numbered row with the cursor on it: "❯ 2. Green", "› 1. Yes, proceed (y)". */
const MARKED = /^[❯›>▶➜→]\s*(\d)[.)]\s/;
/** The row a multi-select goes on with: "Next" between questions, "Submit" after a lone one. */
const GOES_ON = /^(?:[❯›>]\s*)?(?:Submit|Next)$/;
const GOES_ON_TAIL = /(?:^|\s)(?:[❯›>]\s*)?(?:Submit|Next)$/;
/** An unnumbered picker's cursor row: "❯ Dark". */
const CURSOR = /^[❯›>]\s+(\S.*)$/;
/** A key hint that asks for a choice: "Enter to confirm · Esc to cancel", "↑↓ select", "Press enter to continue". Not "esc to interrupt". */
const PROMPT_FOOTER = /\b(?:enter|return)\s+(?:to\s+)?(?:select|confirm|continue|submit|toggle|choose)\b|\besc(?:ape)?\s+(?:to\s+)?(?:cancel|skip|dismiss|exit|go back)\b|↑\s*\/?\s*↓/i;
const YES_NO = /^(.*?\S\s*[([](?:y\/n|yes\/no)[)\]])\s*:?\s*(\S{0,3})$/i;
const OPENCODE_TABS = /^(\S.*?\s{2,}\S.*?)\s{2,}Confirm$/;
const squash = (text: string) => text.replace(/\s+/g, "");
const flat = (text: string) => text.replace(/\s+/g, " ").trim();

/** The last row that is neither blank nor a drawn rule, from `end` up. */
const lastWords = (rows: ReadonlyArray<{ text: string }>, end = rows.length) => {
  let i = end - 1;
  while (i >= 0 && (rows[i]!.text === "" || solid(rows[i]!.text))) i -= 1;
  return i;
};

/**
 * The question the card asks: the phone's, unless it says nothing asked -- the trust picker's is its "Security
 * guide" link -- and a paragraph a little above the menu asks something ("…one you trust?").
 */
function cardQuestion(rows: ReadonlyArray<{ text: string }>, start: number, said: string | undefined): string | undefined {
  if (said === undefined || said.includes("?")) return said;
  let paragraph: string[] = [];
  for (let i = start - 1; i >= Math.max(0, start - 20); i--) {
    const { text } = rows[i]!;
    if (solid(text)) break;
    if (text !== "") {
      paragraph.unshift(text);
      continue;
    }
    if (paragraph.join(" ").includes("?")) break;
    paragraph = [];
  }
  const asked = flat(paragraph.join(" "));
  return asked.includes("?") ? asked.slice(0, 300) : said;
}

/** The phone's menu as a card: what goes on in a multi-select taken out of its options, and where the cursor is. */
function menuCard(rows: ReadonlyArray<{ text: string; indent: number }>, ask: PhoneAsk, cursorOnSubmit: boolean): ChatCard {
  const first = ask.options[0];
  const start = first?.keys || first?.key
    ? rows.findLastIndex(({ text }) => flat(text.replace(/^[❯›>]\s+/, "")).startsWith(first.label.slice(0, 40)))
    : rows.findLastIndex(({ text }) => FIRST.test(text));
  let cursor: number | undefined;
  let goesOn: { marked: boolean; after?: number } | undefined;
  let lastN: number | undefined;
  for (let i = Math.max(0, start); i < rows.length; i++) {
    const { text } = rows[i]!;
    const marked = MARKED.exec(text);
    if (marked) cursor = Number(marked[1]);
    const n = NUMBERED.exec(text);
    if (n) lastN = Number(n[1]);
    else if (GOES_ON.test(text)) goesOn = { marked: /^[❯›>]/.test(text), ...(lastN === undefined ? {} : { after: lastN }) };
  }
  let options: CardOption[] = ask.options.map((option) => option.checked === undefined && option.label === "Chat about this" ? { ...option, chat: true as const } : { ...option });
  let multi: ChatCard["multi"];
  if (options.some((option) => option.checked !== undefined)) {
    const row = options.find((option) => /^(?:submit|next)$/i.test(option.label));
    options = options.filter((option) => option !== row).map((option) => {
      if (!option.detail || !GOES_ON_TAIL.test(option.detail)) return option;
      const { detail, ...rest } = option;
      const kept = detail.replace(GOES_ON_TAIL, "").trim();
      return kept === "" ? rest : { ...rest, detail: kept };
    });
    multi = { submit: ask.tabs ? "tab" : "row", ...(row ? { row: row.n } : goesOn?.after === undefined ? {} : { after: goesOn.after }) };
  }
  const onSubmit = multi?.submit === "row" && (cursorOnSubmit || (multi.row !== undefined ? cursor === multi.row : goesOn?.marked === true));
  const question = cardQuestion(rows, Math.max(0, start), ask.question);
  return {
    id: JSON.stringify(["menu", ask.id, cursor, onSubmit]),
    kind: "menu",
    ...(question === undefined ? {} : { question }),
    options,
    ...(multi ? { multi } : {}),
    ...(ask.tabs ? { tabs: ask.tabs, back: rows.some(({ text }) => /⇆\s*tab/.test(text)) ? "backtab" as const : "left" as const } : {}),
    ...(ask.tab === undefined ? {} : { tab: ask.tab }),
    ...(cursor === undefined ? {} : { cursor }),
    ...(onSubmit ? { onSubmit } : {}),
  };
}

/** A line that ends asking yes or no: "Overwrite a.txt? (y/N)", maybe with the letter typed after it. */
function yesNo(rows: ReadonlyArray<{ text: string }>): ChatCard | undefined {
  const last = lastWords(rows);
  const match = last < 0 ? null : YES_NO.exec(rows[last]!.text);
  if (!match) return undefined;
  const question = flat(match[1]!).slice(0, 300);
  return {
    id: JSON.stringify(["yesno", rows[last]!.text]),
    kind: "more",
    question,
    options: [{ n: 1, label: "Yes", typed: "y" }, { n: 2, label: "No", typed: "n" }],
    ...(match[2] ? { echo: match[2] } : {}),
  };
}

/** OpenCode's review of its question set: what was answered, over "⇆ tab  enter submit  esc dismiss". */
function opencodeReview(rows: ReadonlyArray<{ text: string }>, lines: readonly string[]): ChatCard | undefined {
  const last = lastWords(rows);
  if (last < 0 || !/\benter submit\b/.test(rows[last]!.text)) return undefined;
  const top = rows.findLastIndex(({ text }) => OPENCODE_TABS.test(text));
  if (top < 0 || last - top > 30) return undefined;
  const said = rows.slice(top + 1, last).map(({ text }) => text).filter((text) => text !== "" && !solid(text));
  const tabs = menuTabs(lines);
  if (said.length === 0 || !tabs) return undefined;
  return {
    id: JSON.stringify(["review", said]),
    kind: "more",
    question: said[0]!.slice(0, 300),
    lines: said.slice(1).map((line) => line.slice(0, 300)),
    options: [{ n: 1, label: "Submit", key: "enter" }],
    tabs,
    tab: tabs.length - 1,
    back: "backtab",
  };
}

/**
 * Claude's review of its answers, as 2.1.332 draws it (AskUserQuestion's review step: the tab line, "Review your
 * answers", maybe "Some questions are unanswered", each question with "→ its answer", then its Submit answers /
 * Cancel pair, numbered, the cursor on the first) after a question set's last answer or a lone multi-select's Submit.
 * The pair is the screen's last words; no key hint is drawn under it. Its digits pick at once, Enter the cursor's row.
 */
function claudeReview(rows: ReadonlyArray<{ text: string }>, lines: readonly string[]): ChatCard | undefined {
  const last = lastWords(rows);
  if (last < 1 || !/^(?:[❯›>]\s*)?2[.)]\s+Cancel$/.test(rows[last]!.text) || !/^(?:[❯›>]\s*)?1[.)]\s+Submit answers$/.test(rows[last - 1]!.text)) return undefined;
  const title = rows.findLastIndex(({ text }, i) => i < last - 1 && text === "Review your answers");
  if (title < 0 || rows.slice(title, last - 1).some(({ text }) => solid(text))) return undefined;
  const said = rows.slice(title + 1, last - 1).map(({ text }) => text).filter((text) => text !== "").slice(0, 16).map((text) => text.slice(0, 300));
  const cursor = Number(MARKED.exec(rows[last - 1]!.text)?.[1] ?? MARKED.exec(rows[last]!.text)?.[1]) || undefined;
  const tabs = menuTabs(lines);
  return {
    id: JSON.stringify(["review", said, cursor]),
    kind: "more",
    review: true,
    question: "Review your answers",
    lines: said,
    options: [{ n: 1, label: "Submit answers" }, { n: 2, label: "Cancel" }],
    ...(tabs ? { tabs, tab: tabs.length - 1, back: "left" as const } : {}),
    ...(cursor === undefined ? {} : { cursor }),
  };
}

/**
 * A picker menu.ts leaves (it takes 2 to 6 bare rows): up to 12 rows over a key hint, one of them the cursor's, each
 * maybe with lines under it, set deeper; the question may sit right over them. Each row carries the arrows from the
 * cursor's row to its own, then Enter, as menu.ts's pickers do.
 */
function picker(rows: ReadonlyArray<{ text: string; indent: number }>): ChatCard | undefined {
  let end = rows.length;
  let hints = 0;
  while (end > 0) {
    const { text } = rows[end - 1]!;
    if (text === "" || solid(text)) end -= 1;
    else if (PROMPT_FOOTER.test(text) && hints < 2) {
      hints += 1;
      end -= 1;
    } else break;
  }
  if (hints === 0) return undefined;
  let start = end;
  while (start > 0 && end - start < 40 && rows[start - 1]!.text !== "" && !solid(rows[start - 1]!.text)) start -= 1;
  const block = rows.slice(start, end);
  const marked = block.filter(({ text }) => CURSOR.test(text));
  if (marked.length !== 1 || block.some(({ text }) => NUMBERED.test(text))) return undefined;
  const cursorRow = marked[0]!;
  const column = cursorRow.indent + cursorRow.text.length - CURSOR.exec(cursorRow.text)![1]!.length;
  const options: Array<{ label: string; detail?: string }> = [];
  let cursor = -1;
  const asked: string[] = [];
  for (const row of block) {
    const label = CURSOR.exec(row.text)?.[1] ?? row.text;
    const at = row.indent + row.text.length - label.length;
    if (at === column) {
      if (row === cursorRow) cursor = options.length;
      options.push({ label: flat(label).slice(0, 120) });
    } else if (at > column && options.length > 0) {
      const last = options.at(-1)!;
      last.detail = flat(`${last.detail ?? ""} ${row.text}`).slice(0, 200);
    } else if (options.length === 0) asked.push(row.text);
    else return undefined;
  }
  if (options.length < 2 || options.length > 12) return undefined;
  // The question: the lines right over the rows, else the paragraph over them.
  if (asked.length === 0) {
    for (let i = start - 1; i >= 0 && asked.length < 8; i--) {
      const { text } = rows[i]!;
      if (solid(text) || (text === "" && asked.length > 0)) break;
      if (text !== "") asked.unshift(text);
    }
  }
  const question = flat(asked.join(" ")).slice(0, 300);
  const card: CardOption[] = options.map(({ label, detail }, i) => ({
    n: i + 1,
    label,
    ...(detail ? { detail } : {}),
    keys: [...Array<string>(Math.abs(i - cursor)).fill(i > cursor ? "down" : "up"), "enter"],
  }));
  return { id: JSON.stringify(["pick", question, card]), kind: "more", ...(question ? { question } : {}), options: card };
}

/**
 * What nobody reads, under a key hint: the screen's last lines (up to a blank line, twelve at most, box borders and
 * drawn rules left out), and the keys a person would use -- the arrows, Enter, Esc, the digits it shows, y/n, Tab.
 */
function raw(rows: ReadonlyArray<{ text: string }>): ChatCard | undefined {
  const last = lastWords(rows);
  if (last < 0) return undefined;
  const tail = rows.slice(0, last + 1).filter(({ text }) => text !== "" && !solid(text)).slice(-3);
  if (!tail.some(({ text }) => PROMPT_FOOTER.test(text))) return undefined;
  const lines: string[] = [];
  for (let i = last; i >= 0 && lines.length < 12; i--) {
    const { text } = rows[i]!;
    if (text === "") {
      if (lines.length >= 2) break;
      continue;
    }
    if (!solid(text)) lines.unshift(text.slice(0, 300));
  }
  const all = lines.join("\n");
  const digits = new Set<string>();
  for (const line of lines) {
    const row = NUMBERED.exec(line);
    if (row) digits.add(row[1]!);
    for (const [, digit] of line.matchAll(/\[(\d)\]/g)) digits.add(digit!);
  }
  const named = ["up", "down", "enter", "esc", ...[...digits].sort(), ...(/[([]y\/n[)\]]/i.test(all) ? ["y", "n"] : []), ...(/\btab\b|⇆/i.test(all) ? ["tab"] : [])];
  return { id: JSON.stringify(["raw", lines]), kind: "raw", options: [], lines, keys: named };
}

/**
 * The card for the screen: `lines` are its rows (wrapped ones joined, screen.ts reflow), `ask` the phone's reading of
 * its menu, if any. `working`: the AI's own line for what it is doing shows (chat-view.ts liveLine) -- a key hint
 * then is no question. Undefined: nothing on screen asks.
 */
export function chatCard(lines: readonly string[], ask: PhoneAsk | undefined, working: boolean): ChatCard | undefined {
  const rows = withoutSidebar(lines).map(unboxed);
  // Before the phone's menu, which reads the review's pair too: this card shows what was answered as answers, not as a question.
  const review = claudeReview(rows, lines);
  if (review) return review;
  if (ask) return menuCard(rows, ask, false);
  // The cursor on a lone multi-select's Submit row may be drawn at the screen's edge, under no option: read without it.
  const onSubmit = rows.findIndex(({ text, indent }) => GOES_ON.test(text) && /^[❯›>]/.test(text) && indent < 2);
  if (onSubmit >= 0) {
    const cleaned = lines.map((line, i) => (i === onSubmit ? `${" ".repeat(9)}Submit` : line));
    const menu = menuFrom(cleaned);
    if (menu) return menuCard(withoutSidebar(cleaned).map(unboxed), phoneAsk(cleaned, menu), true);
  }
  return yesNo(rows) ?? opencodeReview(rows, lines) ?? picker(rows) ?? (working ? undefined : raw(rows));
}

/** Still the question the card was drawn for: the same kind, question, tab and number of options; a raw card's very lines. */
// A tab unread on one side is no other tab: a multi-select's cursor on its Submit row is read without the lit tab.
export const sameQuestion = (a: ChatCard, b: ChatCard): boolean =>
  a.kind === b.kind && a.question === b.question && (a.tab === b.tab || a.tab === undefined || b.tab === undefined) && a.options.length === b.options.length && (a.kind !== "raw" || a.id === b.id);

/** What a card answers through: the screen read now (as a card), one named key (PC_KEYS), typed words, a pause. */
export interface CardIo {
  read(): ChatCard | undefined;
  press(name: string): void;
  type(text: string): void;
  wait(ms: number): Promise<void>;
}

export type CardAction =
  | { do: "pick"; n: number }
  /** A multi-select's options to have ticked; then on to what comes next. */
  | { do: "ticks"; ticked: number[] }
  /** Words for a free-text row. */
  | { do: "write"; n: number; text: string }
  | { do: "tab"; to: number }
  /** A raw card's key, or a tab step (←/→) where the lit tab cannot be read. */
  | { do: "key"; name: string }
  /** A raw card's words, then Enter. */
  | { do: "line"; text: string };

/** "moved": the screen shows something else now, so nothing (more) was typed; "stuck": a key did not show. */
export type CardResult = "ok" | "moved" | "stuck";

const POLL_MS = 40;
const STEP_MS = 1500;

/**
 * Answers `drawn` as `action` says, a key at a time: each one only while the screen, read again, still shows the
 * question the card was drawn for, and the next only once the screen took the last (phone/answer.ts types a whole
 * question set so). The first key only while it shows the very screen the card was drawn from.
 */
export async function answerCard(io: CardIo, drawn: ChatCard, action: CardAction): Promise<CardResult> {
  const until = async (done: () => boolean): Promise<boolean> => {
    for (let waited = 0; ; waited += POLL_MS) {
      if (done()) return true;
      if (waited >= STEP_MS) return false;
      await io.wait(POLL_MS);
    }
  };
  const same = (card: ChatCard | undefined): card is ChatCard => card !== undefined && sameQuestion(drawn, card);
  /** The screen now, if it still shows the question. */
  const still = (): ChatCard | undefined => {
    const card = io.read();
    return same(card) ? card : undefined;
  };
  /** The screen moved off `from`: false when it did not in time. */
  const left = (from: ChatCard) => until(() => io.read()?.id !== from.id);
  /** The screen once it shows a card again, if still the question: a frame caught mid-redraw shows none (Ink's erase, then draw). */
  const drawnAgain = async (): Promise<ChatCard | undefined> => {
    let card: ChatCard | undefined;
    await until(() => (card = io.read()) !== undefined);
    return card;
  };
  const settled = async (): Promise<ChatCard | undefined> => {
    const card = await drawnAgain();
    return same(card) ? card : undefined;
  };
  /** Another question on the screen: not a frame mid-redraw, which shows none. */
  const other = () => {
    const card = io.read();
    return card !== undefined && !same(card);
  };
  /** The question went (answered): false when it stayed. */
  const gone = () => until(() => !same(io.read()));
  /**
   * The question's free-text row, where digits and Tab are words: the one read as such ("Type something.") when the
   * card was drawn; else, words being in it already (its label then), the row right over Claude's "Chat about this"
   * with no description under it. A question drawn with no free-text row (Claude's hideOtherRow) has a choice there,
   * which has its description: none then. (Long words wrapped under it read as a description: missed, a ceiling.)
   */
  const fieldRow = drawn.options.find((one) => one.freeText)?.n ?? (() => {
    const chat = drawn.options.find((one) => one.chat);
    const over = chat && drawn.options.find((one) => one.n === chat.n - 1);
    return over && over.detail === undefined && !over.typed ? over.n : undefined;
  })();
  /** The CLI's cursor in that row's field. */
  const inField = (card: ChatCard) => fieldRow !== undefined && card.cursor === fieldRow;
  const first = io.read();
  if (first?.id !== drawn.id) return "moved";

  if (action.do === "key" || action.do === "line") {
    if (action.do === "key") {
      if (!Object.hasOwn(PC_KEYS, action.name)) return "moved";
      io.press(action.name);
      await left(first);
      return "ok";
    }
    const words = typedLine(action.text);
    if (words === "") return "moved";
    io.type(words);
    await io.wait(300);
    const now = io.read();
    if (now?.kind !== drawn.kind) return "moved";
    io.press("enter");
    await left(now);
    return "ok";
  }

  if (action.do === "tab") {
    const labels = (card: ChatCard) => JSON.stringify(card.tabs?.map((tab) => tab.label));
    // In a field Tab and the arrows are the field's: up and out of it first.
    if (inField(first)) {
      io.press("up");
      if (!(await left(first))) return "stuck";
      if (!(await settled())) return "moved";
    }
    for (let step = 0; step < 8; step++) {
      const now = await drawnAgain();
      if (!now?.tabs || now.tab === undefined || labels(now) !== labels(drawn)) return "moved";
      if (now.tab === action.to) return "ok";
      io.press(now.tab < action.to ? "tab" : drawn.back ?? "left");
      if (!(await until(() => io.read()?.tab !== now.tab))) return "stuck";
    }
    return "stuck";
  }

  if (action.do === "pick") {
    const option = drawn.options.find((one) => one.n === action.n);
    if (!option) return "moved";
    if (option.typed) {
      io.press(option.typed);
      await left(first);
      // A line prompt shows the letter and waits for Enter; a key prompt has gone with it.
      const now = still();
      if (now?.echo === option.typed) {
        io.press("enter");
        await left(now);
      }
      return "ok";
    }
    if (option.keys) {
      for (let step = 0; step < 16; step++) {
        const now = await settled();
        const here = now?.options.find((one) => one.n === option.n && one.label === option.label);
        if (!now || !here?.keys) return "moved";
        const key = here.keys[0]!;
        io.press(key);
        if (!(await left(now))) return "stuck";
        if (key === "enter") return "ok";
      }
      return "stuck";
    }
    if (option.key) {
      io.press(option.key);
      return (await left(first)) ? "ok" : "stuck";
    }
    // A row some CLIs ask to be confirmed (Codex 0.172's hooks "Trust all and continue": require_explicit_confirmation)
    // takes only the cursor from its number, and Enter picks the cursor's row: with the cursor already there, Enter
    // alone picks it, in both CLIs -- one key, seen taken.
    let from: ChatCard = first;
    // In a free-text row's field (Claude's "Type something.") a digit is a word: up and out of it first.
    if (from.cursor !== option.n && inField(from)) {
      io.press("up");
      if (!(await left(from))) return "stuck";
      const now = await settled();
      if (!now) return "moved";
      from = now;
    }
    if (from.cursor === option.n) {
      io.press("enter");
      return (await left(from)) ? "ok" : "stuck";
    }
    io.press(String(option.n));
    let after: ChatCard | undefined;
    if (!(await until(() => (after = io.read())?.id !== from.id))) return "stuck";
    // Enter only on the same question, its cursor moved to that row by the number: in the first frame after it (a
    // menu the number picked at once shows something else then, even if one of the same shape comes next), and still
    // once things settle (a menu's last frame on its way out is no cursor waiting).
    if (!same(after) || after.cursor !== option.n) return "ok";
    await io.wait(300);
    const now = still();
    if (now?.cursor !== option.n) return "ok";
    io.press("enter");
    return (await left(now)) ? "ok" : "stuck";
  }

  if (action.do === "write") {
    const option = drawn.options.find((one) => one.n === action.n);
    const words = typedLine(action.text);
    if (!option || option.n !== fieldRow || words === "") return "moved";
    // Its field on screen: the cursor on its row, the question the same.
    const field = () => io.read()?.cursor === option.n && still() !== undefined;
    /** What the field holds now: "" while it shows its placeholder; undefined off the question. */
    const holds = (): string | undefined => {
      const row = still()?.options.find((one) => one.n === option.n);
      return row === undefined ? undefined : row.freeText ? "" : row.detail === undefined ? row.label : `${row.label} ${row.detail}`;
    };
    // A multi-select's digit only ticks the row (Claude 2.1.332's f8), and a single-select's, with words in the field
    // already, answers with them: its field is reached by the arrows then, a row at a time -- from Submit/Next (no
    // numbered row marked) or "Chat about this" (under it), up.
    if (drawn.multi || first.options.find((one) => one.n === option.n)?.freeText !== true) {
      for (let step = 0; step < 16 && !field(); step++) {
        const now = await settled();
        if (!now) return "moved";
        if (now.cursor === option.n) break;
        io.press(now.cursor !== undefined && now.cursor < option.n ? "down" : "up");
        if (!(await left(now))) return "stuck";
      }
    } else if (first.cursor !== option.n) io.press(String(option.n));
    // (With the cursor in the field already, its digit would be a word in it.)
    await until(() => field() || other());
    if (!field()) return still() ? "stuck" : "moved";
    const want = squash(words);
    const had = holds();
    if (had === undefined) return "moved";
    if (squash(had) !== want) {
      if (had !== "") {
        // Words there already (a try that stopped, a digit typed in): gone by its own Backspace, then written afresh --
        // only when the screen shows them whole (menu.ts cuts a label at 120, what is under it at 200).
        const row = still()?.options.find((one) => one.n === option.n);
        if (!row || row.label.length >= 120 || (row.detail?.length ?? 0) >= 200) return still() ? "stuck" : "moved";
        for (let i = 0; i <= [...had].length; i++) {
          io.press("backspace");
          await io.wait(10);
        }
        await until(() => holds() === "" || other());
        if (holds() !== "") return still() ? "stuck" : "moved";
      }
      // Still in the field (a Backspace past its start may have let go of it): words anywhere else are keys.
      if (!field()) return still() ? "stuck" : "moved";
      io.type(words);
      // The whole field, not its start: words of ours after a stray digit are no answer. Words longer than the screen
      // shows (menu.ts's cut) are taken as shown once a good part of them is there.
      const whole = () => {
        const now = holds();
        const seen = now === undefined ? "" : squash(now);
        return seen === want || (seen.length >= 100 && want.length > seen.length && want.startsWith(seen));
      };
      await until(() => whole() || other());
      if (!whole()) return still() ? "stuck" : "moved";
    }
    // A multi-select's words tick its row: the card's Submit goes on.
    if (drawn.multi) return "ok";
    io.press("enter");
    return (await gone()) ? "ok" : "stuck";
  }

  // Ticks, then on.
  if (!drawn.multi) return "moved";
  let out = false;
  for (const option of drawn.options) {
    if (option.checked === undefined || option.freeText) continue;
    const want = action.ticked.includes(option.n);
    const box = () => still()?.options.find((one) => one.n === option.n)?.checked;
    const now = await settled();
    if (!now) return "moved";
    if (box() === want) continue;
    // The cursor in a free-text row's field would take the digit as a word: up and out of it first.
    if (!out && inField(now)) {
      out = true;
      io.press("up");
      if (!(await left(now))) return "stuck";
      if (!(await settled())) return "moved";
    }
    io.press(String(option.n));
    await until(() => box() === want || other());
    if (box() !== want) return still() ? "stuck" : "moved";
  }
  if (drawn.multi.submit === "tab") {
    const now = await settled();
    if (!now) return "moved";
    // Tab in a free-text row's field stays in the question (2.1.332 switches tabs only outside a field): up and out first.
    if (inField(now)) {
      io.press("up");
      if (!(await left(now))) return "stuck";
      if (!(await settled())) return "moved";
    }
    io.press("tab");
    return (await gone()) ? "ok" : "stuck";
  }
  // Down to the row that submits. With no mark on it, it is where Down from the option over it lands and no row is marked.
  let downFrom: number | undefined;
  for (let step = 0; step < 16; step++) {
    const now = await settled();
    if (!now?.multi) return "moved";
    const after = now.multi.after;
    if (now.onSubmit || (now.cursor === undefined && after !== undefined && downFrom === after)) {
      io.press("enter");
      return (await gone()) ? "ok" : "stuck";
    }
    if (now.cursor === undefined) return "stuck";
    const target = now.multi.row ?? after;
    if (target === undefined) return "stuck";
    const down = now.multi.row !== undefined ? now.cursor < target : now.cursor <= target;
    downFrom = down ? now.cursor : undefined;
    io.press(down ? "down" : "up");
    if (!(await left(now))) return "stuck";
  }
  return "stuck";
}

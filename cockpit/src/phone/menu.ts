/**
 * The numbered choice an agent is waiting on, read off the bottom of its
 * screen: Claude Code's and Codex's approval prompts ("❯ 1. Yes", "  2. Yes,
 * and don't ask again …", "  3. No …") and Claude's questions, so the phone
 * can show one button per option instead of a keypad.
 *
 * Strict on purpose -- a wrong button sends a digit into the agent:
 * the menu has to be the last thing on screen (only blank lines, rules and
 * a key-hint footer may follow it), numbered 1, 2, 3… with no gap, at least
 * two options. A numbered list in ordinary output is followed by the
 * agent's input box or more output, and so is not a menu.
 */
export interface MenuOption {
  n: number;
  label: string;
  /** The lines under it: a question option's description, or the rest of a wrapped label. */
  detail?: string;
  /**
   * Claude's "Type something." -- its digit puts the cursor in a text field
   * on that row; the answer is then typed and sent with Enter (checked
   * against Claude Code 2.1.308).
   */
  freeText?: boolean;
  /**
   * A multi-select question's row, "[ ] Red" / "[✔] Red": whether it is ticked.
   * Absent on any other menu. Its digit ticks or unticks it; Tab goes on to the
   * next question (checked against Claude Code 2.1.322).
   */
  checked?: boolean;
  /**
   * Pressed as this key rather than its digit: OpenCode's permission prompt
   * reads no digits, only Enter on what is chosen ("Allow once" when it opens)
   * and Esc to reject (checked against OpenCode 1.19.5).
   */
  key?: "enter" | "esc";
  /**
   * Pressed as these keys in turn: an unnumbered picker (Claude's "trust this
   * folder", a new MCP server) moves its cursor with the arrows and takes
   * Enter, so a row is reached from where the cursor is now, e.g.
   * ["down", "down", "enter"] (checked against Claude Code 2.1.327).
   */
  keys?: string[];
}

/** One question of several (Claude's AskUserQuestion): its header, and whether it has an answer. The last one is Submit. */
export interface MenuTab { label: string; done: boolean }

/** "←  ☐ Colors  ☒ Size  ✔ Submit  →": the questions above a menu, when it is one of several. */
const tabsLine = /^←\s+(.+?)\s+→$/;

/** A character two cells wide on a terminal: Hangul, CJK, full-width forms. */
const wide = /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/;
/** The line up to `cells` columns, wide characters counted as two. */
function within(line: string, cells: number): string {
  let used = 0;
  let end = 0;
  for (const char of line) {
    used += wide.test(char) ? 2 : 1;
    if (used > cells) break;
    end += char.length;
  }
  return line.slice(0, end).trimEnd();
}

/**
 * The screen without OpenCode's sidebar: a wide pane gets a column on the
 * right (getting started, the folder, "• OpenCode 1.19.5" at its foot) whose
 * text shares rows with the conversation, so a menu would not be the last
 * thing on screen. Everything from the column the version line starts at goes.
 */
export function withoutSidebar(lines: readonly string[]): readonly string[] {
  const foot = lines.findLast((line) => /\s{4,}• OpenCode \d+\.\d+/.test(line));
  if (foot === undefined) return lines;
  const at = foot.indexOf("• OpenCode");
  const cells = [...foot.slice(0, at)].reduce((sum, char) => sum + (wide.test(char) ? 2 : 1), 0);
  return cells < 40 ? lines : lines.map((line) => within(line, cells));
}

/** OpenCode's "Favorite color   Sizes   Confirm": no marks, so which have answers is not on screen. */
const opencodeTabsLine = /^(\S.*?\s{2,}\S.*?)\s{2,}Confirm$/;

/**
 * The tab line of the questions a menu belongs to: above the menu, under the rule Claude draws over its whole
 * dialog, so an older question's tabs further up are not read. Undefined for a lone question.
 */
export function menuTabs(screen: readonly string[]): MenuTab[] | undefined {
  const lines = withoutSidebar(screen);
  for (let i = (menuAt(lines)?.start ?? lines.length) - 1; i >= 0; i--) {
    if (solidRule(unboxed(lines[i]!).text)) return undefined;
    const opencode = opencodeTabsLine.exec(unboxed(lines[i]!).text);
    if (opencode) return [...opencode[1]!.split(/\s{2,}/), "Submit"].map((label) => ({ label: label.trim().slice(0, 40), done: false }));
    const match = tabsLine.exec(unboxed(lines[i]!).text);
    if (!match) continue;
    // Windows' Claude Code draws them in ASCII: "[ ] Colors  [×] Size  √ Submit".
    const tabs = match[1]!.split(/\s{2,}/).map((part) => /^([☐☒✔√]|\[[^\]]\])\s*(.+)$/.exec(part.trim())).filter((tab): tab is RegExpExecArray => tab !== null)
      .map((tab) => ({ label: tab[2]!.slice(0, 40), done: tab[1] === "☒" || /^\[[^ \]]\]$/.test(tab[1]!) }));
    return tabs.length >= 2 ? tabs : undefined;
  }
  return undefined;
}

/** A multi-select row's box: "[ ]" or "[✔]" (or "[x]"), before its label. */
const box = /^\[([ ✔✓×xX√])\]\s*/;

const rule = /^[\s─━═╌╍┄┅╭╮╰╯┌┐└┘├┤┬┴┼│┃║]*$/;
/** A rule that is drawn, not a blank line. */
const solidRule = (text: string) => text !== "" && rule.test(text);
const option = /^((?:[❯›>▶➜→*]\s*)?)(\d)[.)]\s+(\S.*)$/;
/** "Esc to cancel · Tab to amend", "Enter to select · ↑/↓ to navigate", "enter confirm · esc skip", "ctrl+g to edit in Notepad · …". */
const footer = /\b(esc|enter|cancel|confirm|navigate)\b|↑|↓|\bctrl\+\w\b/i;
/** Claude Code's bar under a named session (`--name`): a rule with the name in it. */
const nameBar = /^[─━═╌╍┄┅-]{3,}\s+\S.*?(?:\s+[─━═╌╍┄┅-]+)?$/;
/** tmux's status line, which a session in tmux has under everything: `[name] 0:bash* "title" 13:50 05-Nov-26`. */
const tmuxBar = /^\[.*"[^"]*"\s+\d{1,2}:\d{2}\b/;
/** A row whose digit opens a text field: Claude's "Type something." and its plan's "Tell Claude what to change", OpenCode's. */
const freeText = /^(type something|something else|type your own answer|tell claude what to change|other|직접 입력|기타)\.?$/i;
/** OpenCode's permission prompt: a row of three buttons, the screen's last, under "△ Permission required". */
const permissionRow = /^Allow once\s{2,}Allow always\s{2,}Reject\b/;

/** A screen line without its box's side borders: the text, and how far it is indented. */
function unboxed(line: string): { text: string; indent: number } {
  const inner = line.replace(/^\s*[│┃║]/, "").replace(/[│┃║]\s*$/, "").trimEnd();
  const text = inner.trimStart();
  return { text, indent: inner.length - text.length };
}

/**
 * OpenCode's permission prompt as two buttons: once (Enter, as it opens on
 * it) and reject (Esc). "Allow always" asks again before it takes, and only
 * arrow keys reach it, so it stays the PC's. The request is the first line
 * under the title: "→ Edit a.txt", "# Shell command".
 */
function opencodePermission(rows: ReadonlyArray<{ text: string }>): { options: MenuOption[]; start: number } | undefined {
  const last = rows.findLastIndex(({ text }) => text !== "" && !rule.test(text));
  if (last < 0 || !permissionRow.test(rows[last]!.text)) return undefined;
  const title = rows.findLastIndex(({ text }) => /^△\s*Permission required$/.test(text));
  if (title < 0 || last - title > 30) return undefined;
  const request = rows.slice(title + 1, last).map(({ text }) => text).find((text) => text !== "" && !rule.test(text));
  return {
    options: [
      { n: 1, label: "Allow once", ...(request ? { detail: request.slice(0, 200) } : {}), key: "enter" },
      { n: 2, label: "Reject", key: "esc" },
    ],
    start: last,
  };
}

/** "❯ No, exit": the cursor's row of an unnumbered picker. */
const cursorRow = /^[❯>]\s+(\S.*)$/;

/**
 * Claude's unnumbered pickers ("❯ No, exit" / "  Yes, I trust this folder" over "Enter to confirm · Esc to
 * cancel"). Only with a key-hint footer under them (`end`: where that tail starts), as 2 to 6 rows right above it
 * with a blank line over them, one of them the cursor's, none numbered, every label starting in the same column.
 * Each option carries the arrows from the cursor's row to its own, then Enter.
 */
function cursorMenu(rows: ReadonlyArray<{ text: string; indent: number }>, end: number): { options: MenuOption[]; start: number } | undefined {
  let start = end;
  while (start > 0 && !rule.test(rows[start - 1]!.text)) start -= 1;
  const block = rows.slice(start, end);
  if (block.length < 2 || block.length > 6 || start === 0 || rows[start - 1]!.text !== "") return undefined;
  const cursor = block.findIndex(({ text }) => cursorRow.test(text));
  if (cursor < 0 || block.filter(({ text }) => cursorRow.test(text)).length !== 1 || block.some(({ text }) => option.test(text))) return undefined;
  const labels = block.map(({ text, indent }) => {
    const label = cursorRow.exec(text)?.[1] ?? text;
    return { label, column: indent + text.length - label.length };
  });
  if (labels.some(({ column }) => column !== labels[0]!.column)) return undefined;
  return {
    options: labels.map(({ label }, i) => ({
      n: i + 1,
      label: label.replace(/\s+/g, " ").slice(0, 120),
      keys: [...Array<string>(Math.abs(i - cursor)).fill(i > cursor ? "down" : "up"), "enter"],
    })),
    start,
  };
}

export function menuFrom(lines: readonly string[]): MenuOption[] | undefined {
  return menuAt(lines)?.options;
}

/** menuFrom's reading, with the row its first option is on (in withoutSidebar(lines)). */
function menuAt(lines: readonly string[]): { options: MenuOption[]; start: number } | undefined {
  const rows = withoutSidebar(lines).map(unboxed);
  const permission = opencodePermission(rows);
  if (permission) return permission;
  // The tail: blank lines, rules, what Lepons' own sessions have below everything, and at most two key-hint lines.
  let end = rows.length;
  let hints = 0;
  while (end > 0) {
    const { text } = rows[end - 1]!;
    if (text === "" || rule.test(text) || nameBar.test(text) || tmuxBar.test(text)) end -= 1;
    else if (!option.test(text) && footer.test(text) && hints < 2) {
      hints += 1;
      end -= 1;
    } else break;
  }
  // The last "1." above that, then everything down to the tail must be the menu.
  let start = -1;
  for (let i = end - 1; i >= 0; i--) {
    if (option.exec(rows[i]!.text)?.[2] === "1") {
      start = i;
      break;
    }
  }
  const numbered = start < 0 ? undefined : numberedMenu(rows, start, end);
  if (numbered) return { options: numbered, start };
  return hints > 0 ? cursorMenu(rows, end) : undefined;
}

function numberedMenu(rows: ReadonlyArray<{ text: string; indent: number }>, start: number, end: number): MenuOption[] | undefined {
  const options: MenuOption[] = [];
  let indent = 0;
  for (let i = start; i < end; i++) {
    const row = rows[i]!;
    const match = option.exec(row.text);
    if (match) {
      if (Number(match[2]) !== options.length + 1) return undefined;
      options.push({ n: Number(match[2]), label: match[3]!.trim() });
      indent = row.indent + match[1]!.length;
    } else if (row.text === "" || rule.test(row.text)) {
      // Claude sets its last options apart with a rule; a blank line may sit between options.
      continue;
    } else if (row.indent > indent && options.length > 0) {
      const last = options[options.length - 1]!;
      last.detail = last.detail === undefined ? row.text : `${last.detail} ${row.text}`;
    } else {
      return undefined;
    }
  }
  if (options.length < 2) return undefined;
  const multi = options.some(({ label }) => box.test(label));
  return options.map(({ n, label, detail }) => {
    const ticked = multi ? box.exec(label) : null;
    const name = (ticked ? label.slice(ticked[0].length) : label).trim();
    // Under a multi-select's last row: its "Next" line, which is no option's description.
    const said = multi && detail !== undefined ? detail.replace(/(?:^|\s)Next$/, "").trim() : detail;
    return {
      n,
      label: name.replace(/\s+/g, " ").slice(0, 120),
      ...(said === undefined || said === "" ? {} : { detail: said.replace(/\s+/g, " ").slice(0, 200) }),
      ...(freeText.test(name) ? { freeText: true } : {}),
      ...(ticked ? { checked: ticked[1] !== " " } : {}),
    };
  });
}

/**
 * What the menu at the foot of the screen asks: the paragraph right over its first option (up to two blank lines or
 * rules between), its lines joined. It ends at a blank line, a rule, a tab line or an older list's option, and holds
 * 8 lines at most, so Claude's header chip ("☐ Color", a blank line over the question) is no part of it.
 */
export function menuQuestion(screen: readonly string[]): string | undefined {
  const lines = withoutSidebar(screen);
  const found = menuAt(lines);
  if (!found) return undefined;
  const rows = lines.map(unboxed);
  let i = found.start - 1;
  for (let skipped = 0; i >= 0 && skipped < 2 && rule.test(rows[i]!.text); skipped++) i -= 1;
  const said: string[] = [];
  for (; i >= 0 && said.length < 8; i--) {
    const { text } = rows[i]!;
    if (rule.test(text) || tabsLine.test(text) || opencodeTabsLine.test(text) || option.test(text)) break;
    said.unshift(text);
  }
  const text = said.join(" ").replace(/\s+/g, " ").trim().slice(0, 300);
  return text === "" ? undefined : text;
}

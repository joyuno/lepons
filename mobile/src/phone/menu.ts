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
}

const rule = /^[\s─━═╌╍┄┅╭╮╰╯┌┐└┘├┤┬┴┼│┃║]*$/;
const option = /^((?:[❯›>▶➜→*]\s*)?)(\d)[.)]\s+(\S.*)$/;
/** "Esc to cancel · Tab to amend", "Enter to select · ↑/↓ to navigate", "enter confirm · esc skip". */
const footer = /\b(esc|enter|cancel|confirm|navigate)\b|↑|↓/i;
/** Claude Code's bar under a named session (`--name`): a rule with the name in it. */
const nameBar = /^[─━═╌╍┄┅-]{3,}\s+\S.*?(?:\s+[─━═╌╍┄┅-]+)?$/;
/** tmux's status line, which a session in tmux has under everything: `[name] 0:bash* "title" 13:50 05-Nov-26`. */
const tmuxBar = /^\[.*"[^"]*"\s+\d{1,2}:\d{2}\b/;
const freeText = /^(type something|something else|other|직접 입력|기타)\.?$/i;

/** A screen line without its box's side borders: the text, and how far it is indented. */
function unboxed(line: string): { text: string; indent: number } {
  const inner = line.replace(/^\s*[│┃║]/, "").replace(/[│┃║]\s*$/, "").trimEnd();
  const text = inner.trimStart();
  return { text, indent: inner.length - text.length };
}

export function menuFrom(lines: readonly string[]): MenuOption[] | undefined {
  const rows = lines.map(unboxed);
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
  if (start < 0) return undefined;
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
  return options.map(({ n, label, detail }) => ({
    n,
    label: label.replace(/\s+/g, " ").slice(0, 120),
    ...(detail === undefined ? {} : { detail: detail.replace(/\s+/g, " ").slice(0, 200) }),
    ...(freeText.test(label.trim()) ? { freeText: true } : {}),
  }));
}

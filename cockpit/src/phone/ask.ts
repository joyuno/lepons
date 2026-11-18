import type { PhoneAsk, PhoneAskForm } from "../shared/ipc.ts";
import { questionOf } from "./answer.ts";
import { menuQuestion, menuTabs, type MenuOption, type MenuTab } from "./menu.ts";

/** FNV-1a, 32 bits, as hex: a fingerprint to tell one menu from the next, not a secret. */
function fingerprint(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * A waiting session's menu for the phone. `menu` is read off the visible screen (menuFrom), as the PC's own uses
 * read it; `lines` is that screen with some scrollback over it, where a tall question's text and its tab line may
 * have gone. `tabOf` says which tab the terminal shows, when it can tell.
 */
export function phoneAsk(lines: readonly string[], menu: readonly MenuOption[], tabOf?: (tabs: MenuTab[]) => number | undefined): PhoneAsk {
  const question = menuQuestion(lines);
  const tabs = menuTabs(lines);
  const at = tabs && tabOf?.(tabs);
  const tab = at !== undefined && at >= 0 && at < tabs!.length ? at : undefined;
  const options = menu.slice(0, 9).map(({ n, label, detail, freeText, checked, key, keys }): PhoneAsk["options"][number] => ({
    n, label: label.slice(0, 120),
    ...(detail === undefined ? {} : { detail: detail.slice(0, 200) }),
    ...(freeText ? { freeText: true as const } : {}),
    ...(checked === undefined ? {} : { checked }),
    ...(key ? { key } : {}),
    ...(keys ? { keys } : {}),
  }));
  // Keys too: the cursor moved on an unnumbered picker (on the PC) makes every row's arrows another.
  const id = fingerprint(JSON.stringify([question, options.map(({ label, checked, keys }) => [label, checked, keys]), tabs, tab]));
  return { id, ...(question ? { question } : {}), options, ...(tabs ? { tabs } : {}), ...(tab === undefined ? {} : { tab }) };
}

const isObj = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const text = (value: unknown, max: number): value is string => typeof value === "string" && value.trim() !== "" && value.length <= max;

/**
 * The last AskUserQuestion in a Claude record that has no answer yet, for the phone to answer whole. Undefined when
 * there is none, or its shape is not one the phone can turn into keys: more than four questions or options (the
 * screen's digits follow the options' count, so none is cut), or a missing header, question or label.
 */
export function askForm(jsonl: string): PhoneAskForm | undefined {
  let last: { id: string; input: unknown } | undefined;
  for (const line of jsonl.split("\n")) {
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const content = isObj(entry) && isObj(entry.message) ? entry.message.content : undefined;
    if (!Array.isArray(content)) continue;
    for (const block of content as unknown[]) {
      if (!isObj(block)) continue;
      if (block.type === "tool_use" && block.name === "AskUserQuestion" && typeof block.id === "string") last = { id: block.id, input: block.input };
      else if (block.type === "tool_result" && block.tool_use_id === last?.id) last = undefined;
    }
  }
  return last && formOf(last.id, last.input);
}

/** An AskUserQuestion's input as the phone's form: undefined for a shape it cannot turn into keys (see askForm). */
function formOf(id: string, input: unknown): PhoneAskForm | undefined {
  if (!/^[\w-]{1,100}$/.test(id) || !isObj(input)) return undefined;
  const questions = input.questions;
  if (!Array.isArray(questions) || questions.length === 0 || questions.length > 4) return undefined;
  const form: PhoneAskForm = { id, questions: [] };
  for (const q of questions as unknown[]) {
    if (!isObj(q) || !text(q.header, 40) || !text(q.question, 2000) || !Array.isArray(q.options) || q.options.length === 0 || q.options.length > 4) return undefined;
    const options: PhoneAskForm["questions"][number]["options"] = [];
    for (const o of q.options as unknown[]) {
      if (!isObj(o) || !text(o.label, 500)) return undefined;
      options.push({ label: o.label.slice(0, 120), ...(text(o.description, 10_000) ? { description: o.description.slice(0, 200) } : {}) });
    }
    form.questions.push({ header: q.header, question: q.question.slice(0, 500), multiSelect: q.multiSelect === true, options });
  }
  return form;
}

/** A saved question set (agent/usage.ts claudeAskHookCommand), by its file name in ~/.lepons/asks. */
export interface AskHookFile {
  name: string;
  text: string;
}

/** Lists the newest few saved question sets on a POSIX PC, each under a "==> name" line (askHookListing). */
export const askHookScript = `cd ~/.lepons/asks 2>/dev/null && for f in $(ls -t | grep '^[0-9]*-[0-9]*[.]json$' | head -5); do echo "==> $f"; cat "$f"; echo; done`;
/** What askHookScript printed. A JSON line never starts with "==> ". */
export function askHookListing(output: string): AskHookFile[] {
  return output.split(/^==> /m).slice(1).flatMap((part) => {
    const at = part.indexOf("\n");
    const name = part.slice(0, at < 0 ? undefined : at).trim();
    return askHookName.test(name) ? [{ name, text: at < 0 ? "" : part.slice(at + 1) }] : [];
  });
}
export const askHookName = /^\d+-\d+\.json$/;

const folderKey = (path: string, windows: boolean): string => {
  const slashed = path.replaceAll("\\", "/").replace(/\/+$/, "");
  return windows ? slashed.toLowerCase() : slashed;
};

/**
 * The question set Claude is asking in this folder, from the hook's files (newest first): the newest one asked here,
 * with the file it came from. Undefined when none was, or its set is not one the phone can type (askForm).
 */
export function hookForm(files: readonly AskHookFile[], folder: string, windows: boolean): { form: PhoneAskForm; name: string } | undefined {
  for (const { name, text } of files) {
    let hook: unknown;
    try {
      hook = JSON.parse(text);
    } catch {
      continue;
    }
    if (!isObj(hook) || hook.tool_name !== "AskUserQuestion" || typeof hook.cwd !== "string" || typeof hook.tool_use_id !== "string") continue;
    if (folderKey(hook.cwd, windows) !== folderKey(folder, windows)) continue;
    const form = formOf(hook.tool_use_id, hook.tool_input);
    return form && { form, name };
  }
  return undefined;
}

/**
 * The form is the question set the menu shows: the menu's question is one of its questions, or a tab is one of its
 * headers, or it is the set's review. Neither needs the tab line, which a narrow pane wraps out of reading. A stale
 * record never drives keys.
 */
export function formFits(form: PhoneAskForm, ask: PhoneAsk): boolean {
  return questionOf(form, ask.question) !== undefined
    || (ask.tabs ?? []).some((tab) => form.questions.some((question) => question.header.slice(0, 40) === tab.label))
    || ask.options.some((option) => /^submit answers$/i.test(option.label));
}

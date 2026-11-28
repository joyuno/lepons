import type { Translate } from "../shared/approval.ts";
import type { SessionWorkflowResult, ToolStep, WorkflowItem } from "../shared/ipc.ts";
import type { SessionStatus } from "../shared/status.ts";
import { formatDate, t } from "../i18n/i18n.ts";
import { renderAnswer } from "./markdown.ts";
import { oneLine } from "../phone/input.ts";
import { sameQuestion, type CardAction, type CardResult, type ChatCard } from "./chat-ask.ts";
import { agents, type AgentKind } from "../agent/agents.ts";
import { agentLogos } from "./agent-logos.ts";
import { pathsAt, urlsAt } from "./wrapped-url.ts";
import { fileLinkPath } from "../shared/term-paths.ts";
import { remotePath } from "../shared/image-path.ts";
import type { SendResult } from "./tmux-bar.ts";

/** The tool calls between two answers, folded into one row. */
export type WorkRow = { kind: "work"; at: number; steps: ToolStep[]; cancelled?: true };
/** A subagent (Agent/Task call): what it was given and what it gave back, folded into a row of its own. */
export type SubRow = { kind: "sub" } & Omit<Extract<WorkflowItem, { kind: "subagent" }>, "kind">;
export type ChatRow = { kind: "user"; at: number; text: string; images?: string[] } | { kind: "agent"; at: number; text: string; cancelled?: true } | WorkRow | SubRow;

/** The AIs whose record the chat draws: Claude's and Codex's. OpenCode's is read for the board and the phone, but its session shows its terminal. */
export const chatAgent = (kind: AgentKind): boolean => agents[kind].can.transcript === "claude" || agents[kind].can.transcript === "codex";

/** A full read's events as the conversation's rows: actions in a run fold into one work row, each subagent is its own. */
export function chatRows(events: readonly WorkflowItem[]): ChatRow[] {
  const rows: ChatRow[] = [];
  for (const event of events) {
    if (event.kind === "prompt") {
      rows.push({ kind: "user", at: event.at, text: event.text, ...(event.images ? { images: event.images } : {}) });
      continue;
    }
    if (event.kind === "note") {
      rows.push({ kind: "agent", at: event.at, text: event.text, ...(event.cancelled ? { cancelled: true as const } : {}) });
      continue;
    }
    if (event.kind === "subagent") {
      const { kind: _kind, ...sub } = event;
      rows.push({ kind: "sub", ...sub });
      continue;
    }
    let work = rows.at(-1);
    if (work?.kind !== "work") rows.push((work = { kind: "work", at: event.at, steps: [] }));
    work.steps.push(...(event.steps ?? []));
    if (event.cancelled) work.cancelled = true;
  }
  return rows;
}

/**
 * A subagent's state: done once its result is in; stopped when the turn was cut short, or, the session not at work
 * (`working`), a later prompt came with no result (its session went away under it); running otherwise -- a background
 * one too while its turn is quiet, and one under a line typed meanwhile (Claude queues it as a prompt).
 */
export function subState(rows: readonly ChatRow[], index: number, working: boolean): "running" | "done" | "stopped" {
  const row = rows[index] as SubRow;
  if (row.result !== undefined) return "done";
  return row.cancelled || (!working && rows.slice(index + 1).some((later) => later.kind === "user")) ? "stopped" : "running";
}

/** The subagents at work now, for the line over the composer. */
export const runningSubs = (rows: readonly ChatRow[], working: boolean): SubRow[] =>
  rows.flatMap((row, index) => row.kind === "sub" && subState(rows, index, working) === "running" ? [row] : []);

/** A call's output folded: two lines, each cut at 300 characters, and whether there is more behind "더 보기". */
export function outputPreview(output: string): { preview: string; more: boolean } {
  const lines = output.split("\n");
  const shown = lines.slice(0, 2).map((line) => line.length > 300 ? `${line.slice(0, 300)}…` : line);
  return { preview: shown.join("\n"), more: lines.length > 2 || shown.some((line, i) => line !== lines[i]) };
}

/** What a click on an answer's own link opens: a web address, or a file:// one's path; nothing for one to a share or device (remotePath), or any other. */
export function answerLink(href: string): { url: string } | { path: string } | undefined {
  const path = fileLinkPath(href);
  if (path !== undefined) return remotePath(path) ? undefined : { path };
  return /^https?:\/\//i.test(href) ? { url: href } : undefined;
}

/**
 * The web address or file path at `offset` in a block of the chat's text, found as the terminal's Ctrl+click finds
 * them (wrapped-url.ts): its lines as rows, so one broken at a box's side is joined.
 */
export function linkAt(text: string, offset: number): { url: string } | { path: string; folder?: true } | undefined {
  const lines = text.split("\n");
  let row = 0;
  let col = offset;
  while (row < lines.length - 1 && col > lines[row]!.length) col -= lines[row++]!.length + 1;
  const rowAt = (index: number) => lines[index] === undefined ? undefined : { text: lines[index]!, wrapped: false };
  // The click's own row; at the end of a word is on it (a click on its last letter's right half).
  const hit = (parts: Array<{ row: number; index: number; length: number }>) =>
    parts.some((part) => part.row === row && part.index <= col && col <= part.index + part.length);
  // No terminal width: a line is broken only where a box's side says so.
  const url = urlsAt(rowAt, row, Infinity).find((match) => hit(match.parts))?.url;
  if (url !== undefined) return { url };
  const path = pathsAt(rowAt, row, Infinity).find((match) => hit(match.parts));
  return path && { path: path.path, ...(path.folder ? { folder: true as const } : {}) };
}

/** A line sent from the composer, shown until the record has it: `after`, the record's newest prompt then. */
/** `typed`: in the prompt with its Enter held back (a menu came up), so the record takes it once the person presses Enter there. */
/** `queued`: not one key of it typed yet (a remote pane leaving copy mode first): it can still be taken back. */
export type Pending = { id: number; text: string; after: number; failed?: true; typed?: true; queued?: true };

/** The sent lines still to show: each one not failed is taken by the first prompt newer than its `after` not taken yet. */
export function settlePending(pending: readonly Pending[], promptAts: readonly number[]): Pending[] {
  const taken = new Set<number>();
  return pending.filter((one) => {
    if (one.failed) return true;
    const at = promptAts.findIndex((when, i) => when > one.after && !taken.has(i));
    if (at < 0) return true;
    taken.add(at);
    return false;
  });
}

/** A work row's fold: how long it took (or has run), its commands and the distinct files it read or changed. */
export function workSummary(row: WorkRow, running: boolean, now: number): { seconds?: number; commands: number; files: number } {
  const commands = row.steps.filter((step) => step.tool === "command").length;
  const files = new Set(row.steps.filter((step) => step.tool === "read" || step.tool === "edit").map((step) => step.target)).size;
  const end = row.steps.reduce((last, step) => Math.max(last, step.endAt ?? -Infinity), -Infinity);
  const ms = (running ? now : end) - row.at;
  // Ended the instant it started: a record that wrote only the end (a Codex call with no duration), so no length is known.
  return { ...((running ? ms >= 0 : ms > 0) ? { seconds: Math.round(ms / 1000) } : {}), commands, files };
}

/** The last row's calls with no result yet: the turn's, if it has not ended. */
const openSteps = (rows: readonly ChatRow[]): ToolStep[] => {
  const last = rows.at(-1);
  return last?.kind === "work" && !last.cancelled ? last.steps.filter((step) => step.result === undefined) : [];
};

/**
 * Whether the terminal's screen shows this call now: its command's first line (or its file's name), spaces and line
 * breaks aside, as the screen wraps them anywhere. A call the record left unanswered by an earlier run is not on the
 * screen of this one -- its start's trust question, say -- and so is not waited on.
 */
const onScreen = (step: ToolStep, screen: string): boolean => {
  const flat = (text: string) => text.replace(/\s+/g, "");
  const key = flat((step.command ?? step.target).split("\n")[0] ?? "").slice(0, 40);
  return key !== "" && flat(screen).includes(key);
};

/**
 * The call a question on screen asks about, to show with it: the turn's one unfinished call, while the screen shows
 * it. Two at once (parallel calls) give none: the CLI asks about them in turn, and which turn it is cannot be told.
 */
export function askedStep(rows: readonly ChatRow[], screen: string): ToolStep | undefined {
  const open = openSteps(rows);
  return open.length === 1 && onScreen(open[0]!, screen) ? open[0] : undefined;
}

/** The turn is still at work while a question on screen holds one of its unfinished calls. */
export const heldOnScreen = (rows: readonly ChatRow[], screen: string): boolean => openSteps(rows).some((step) => onScreen(step, screen));

/** "45초", "1분 15초". */
export const durationWords = (seconds: number, t: Translate): string =>
  seconds < 60 ? t("chat.seconds", { n: seconds }) : t("chat.minutesSeconds", { m: Math.floor(seconds / 60), s: seconds % 60 });

/**
 * What the view holds after a read: a full read is the record's last stretch, so what slid out of it since is kept
 * from before, and from the newest read's first event on, that read is taken as it is.
 */
export function mergeEvents(kept: readonly WorkflowItem[], latest: readonly WorkflowItem[]): WorkflowItem[] {
  const from = latest[0]?.at;
  return from === undefined ? [...kept] : [...kept.filter((event) => event.at < from), ...latest];
}

/** An older read (`before` the view's first event) in front of what the view holds; what it holds already is not doubled. */
export function olderEvents(kept: readonly WorkflowItem[], older: readonly WorkflowItem[]): WorkflowItem[] {
  const first = kept[0]?.at ?? Infinity;
  return [...older.filter((event) => event.at < first), ...kept];
}

/**
 * What a key in the composer does: Enter sends, Shift+Enter breaks the line. Any key while an IME composes (Korean)
 * is the IME's -- the Enter that ends a word's composition must not send it half-typed. Chromium marks that Enter
 * with keyCode 229, sometimes without isComposing. Esc in a field left `empty` is the stop button's (composerAction).
 */
export function composerKey(event: { key: string; shiftKey: boolean; isComposing: boolean; keyCode?: number }, empty = false): "send" | "newline" | "stop" | "none" {
  if (event.isComposing || event.keyCode === 229) return "none";
  if (event.key === "Escape") return empty ? "stop" : "none";
  if (event.key !== "Enter") return "none";
  return event.shiftKey ? "newline" : "send";
}

/**
 * What the send button does: takes back the lines still waiting to be typed; else stops the AI while its CLI's own
 * working line is on screen (`line`, liveLine; the lamp stays lit seconds past a turn's end, and an Esc to a CLI at
 * rest is no stop); else sends. None of it over a question (`asking`): the card answers that.
 */
export const composerAction = (queued: boolean, line: string | undefined, asking = false): "cancel" | "stop" | "send" =>
  queued ? "cancel" : line !== undefined && !asking ? "stop" : "send";

/** How long a stop's Esc may go unanswered (its working line still up) before it is given up as not taken. */
export const STOP_WAIT_MS = 5000;

/**
 * A stop pressed here, as the CLI's working line (`working`) goes: `asked` until the line goes (`ended`: the work is
 * over, `over` from then), or given up when it stays past STOP_WAIT_MS (`failed`: the CLI did not take the Esc);
 * `over` until the line comes back (the AI at work again).
 */
export function stopState(state: { asked: boolean; over: boolean; at: number }, working: boolean, now: number): { asked: boolean; over: boolean; ended?: true; failed?: true } {
  if (state.asked && !working) return { asked: false, over: true, ended: true };
  if (state.asked && now - state.at > STOP_WAIT_MS) return { asked: false, over: state.over, failed: true };
  return { asked: state.asked, over: state.over && !working };
}

/** The rows the record marks cut short, each by its kind and start. */
export const cutRows = (rows: readonly ChatRow[]): Set<string> =>
  new Set(rows.flatMap((row) => "cancelled" in row && row.cancelled ? [`${row.kind}:${row.at}`] : []));

/**
 * 멈췄어요 at the end of the talk: a stop pressed here ended the work (the live state says so, `over`) and the record
 * marks no row cut short since the press (`before`, cutRows then) -- a turn stopped before its first word, whose
 * prompt the record drops. A row the record marks says it under itself.
 */
export const stoppedEnd = (rows: readonly ChatRow[], over: boolean, before: ReadonlySet<string>): boolean =>
  over && [...cutRows(rows)].every((cut) => before.has(cut));

/**
 * The pane's focus into its chat: the list, unless the keyboard is already somewhere in the chat. A press anywhere in
 * the pane asks this first (main.ts focusPane), and taking the focus away then closed the chip's menu and the "/" list
 * before the press's click reached the row.
 */
export function focusChat(view: { contains(node: never): boolean }, list: { focus(): void }, active: unknown): void {
  if (!view.contains(active as never)) list.focus();
}

/**
 * What a paste into the composer attaches, as the terminal's paste does: files (each with its path), pictures copied
 * with no file and no words beside them (their indexes in `files`), else a file copied in Explorer or Finder (`copied`,
 * asked only when the paste has no text). Undefined: text, the field's own paste.
 */
export function pastedFiles(files: ReadonlyArray<{ path: string; type: string }>, text: string, copied: () => string): { paths: string[]; pictures: number[] } | undefined {
  const paths = files.map((file) => file.path).filter((path) => path !== "");
  // With words beside it (Excel cells, a Word copy) the picture is only another form of them: the words paste.
  const pictures = text !== "" ? [] : files.flatMap((file, at) => (file.path === "" && file.type.startsWith("image/") ? [at] : []));
  if (paths.length || pictures.length) return { paths, pictures };
  const file = text === "" ? copied() : "";
  return file ? { paths: [file], pictures: [] } : undefined;
}

/**
 * A line that is one of the AI's "/" commands (its first word "/name", not a path): it shows as sent once typed, as
 * Claude keeps a local one (/model, /clear…) out of its record and Codex keeps none, so no record line would take it.
 */
export const settlesOnSend = (line: string): boolean => /^\/[^\s/]+(\s|$)/.test(line.trim());

/** The line sent: each attachment's path as the session types it (ending in a space), then the words. */
export const withAttached = (typed: readonly string[], text: string): string => `${typed.join("")}${text}`.trim();

/** One row of the composer's suggestions: what the text before the caret becomes when it is picked. */
export interface SuggestRow { insert: string; label: string; detail?: string }

/**
 * What the text before the caret asks to be suggested, as the phone's composer reads it: a lone "/word" the AI's
 * commands, and a word at the end starting "@" one folder of files ("@src/" goes into src). Undefined: nothing.
 */
export function suggestAsk(before: string): { slash: string } | { skill: string } | { folder: string; typed: string } | undefined {
  const slash = /^\/(\S*)$/.exec(before);
  if (slash) return { slash: slash[1]!.toLowerCase() };
  // Codex's skill mention, as its own "$" popup: a word starting with "$", anywhere (the caller asks Codex's only).
  const skill = /(?:^|\s)\$(\S*)$/.exec(before);
  if (skill) return { skill: skill[1]!.toLowerCase() };
  const at = /(?:^|\s)@(\S*)$/.exec(before);
  if (!at) return undefined;
  const folder = at[1]!.slice(0, at[1]!.lastIndexOf("/") + 1);
  // Inside the session's folder only, as the phone's listing is.
  if (folder.startsWith("/") || folder.split("/").includes("..")) return undefined;
  return { folder, typed: at[1]!.slice(folder.length) };
}

/** The commands whose name holds what was typed after "/", those that start with it first; every one, as the terminal's list (it scrolls). */
export function slashRows(commands: ReadonlyArray<{ name: string; description: string }>, query: string): SuggestRow[] {
  const hits = commands.filter((command) => command.name.slice(1).toLowerCase().includes(query));
  const starts = (name: string) => Number(!name.slice(1).toLowerCase().startsWith(query));
  return hits.sort((a, b) => starts(a.name) - starts(b.name))
    .map((command) => ({ insert: `${command.name} `, label: command.name, detail: command.description }));
}

/** The "$" skills whose name holds what was typed after "$", those that start with it first. The word becomes `$<name> `. */
export function skillRows(commands: ReadonlyArray<{ name: string; description: string }>, before: string, query: string): SuggestRow[] {
  const head = before.slice(0, before.length - query.length - 1);
  return slashRows(commands.filter((command) => command.name.startsWith("$")), query).map((row) => ({ ...row, insert: `${head}${row.insert}` }));
}

/** One folder's entries matching the word after "@" and its folder; a folder's row goes into it, a file's ends the word. */
export function fileRows(entries: ReadonlyArray<{ name: string; directory: boolean }>, before: string, folder: string, typed: string): SuggestRow[] {
  const head = before.slice(0, before.length - typed.length);
  return entries.filter((entry) => entry.name.toLowerCase().includes(typed.toLowerCase())).slice(0, 40).map((entry) => ({
    insert: `${head}${entry.name}${entry.directory ? "/" : " "}`,
    label: `@${folder}${entry.name}${entry.directory ? "/" : ""}`,
  }));
}

/** A key while the suggestions are open: ↑/↓ move, Enter or Tab puts the row in, Esc closes. None while an IME composes. */
export function suggestKey(event: { key: string; shiftKey: boolean; isComposing: boolean; keyCode?: number }): "up" | "down" | "pick" | "close" | undefined {
  if (event.isComposing || event.keyCode === 229) return undefined;
  if (event.key === "ArrowDown") return "down";
  if (event.key === "ArrowUp") return "up";
  if ((event.key === "Enter" || event.key === "Tab") && !event.shiftKey) return "pick";
  if (event.key === "Escape") return "close";
  return undefined;
}

/**
 * The CLIs whose model is switched in place by a line typed into the session, each checked on this PC; any other
 * changes its model in the terminal. Claude Code 2.1.332: `/model <model>` (argumentHint "[model]") switches with no
 * picker when given a name, and `claude --help` names the aliases (fable, opus, sonnet; haiku is in its alias list
 * too). Codex 0.172.0's `/model` opens a picker ("choose what model and reasoning effort to use"); its binary has a
 * "Usage: /…" line for every command that takes words (/goal, /permissions, /raw, …) and none for /model: not here.
 * `alsoDefault`: the CLI saves the pick as the default for new sessions too (Claude's interactive /model does), and
 * the menu says so.
 */
type ModelCommand = { line(model: string): string; models: string[]; alsoDefault?: true };
export const MODEL_COMMANDS: Partial<Record<AgentKind, ModelCommand>> = {
  claude: { line: (model) => `/model ${model}`, models: ["fable", "opus", "sonnet", "haiku"], alsoDefault: true },
};

/**
 * A model line is typed only into a prompt waiting for words: never into an AI at work, nor over a question on
 * screen, read (its card) or not ("터미널에서 답해 주세요", mood waiting) -- its Enter would pick the menu's choice.
 */
export const canTypeModel = (canType: boolean, ask: ChatCard | undefined, mood: SessionStatus): boolean =>
  canType && ask === undefined && mood !== "waiting" && mood !== "working";

/** Where an arrow, Home or End moves in a menu of `count` items from item `at` (-1: the menu itself); undefined: not a move. */
export function menuMove(key: string, at: number, count: number): number | undefined {
  if (count === 0) return undefined;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  if (key === "ArrowDown") return at < 0 ? 0 : (at + 1) % count;
  if (key === "ArrowUp") return at < 0 ? count - 1 : (at - 1 + count) % count;
  return undefined;
}

/** The model chip's menu: this AI's models when its CLI takes them as a line, and the other AIs here to carry the talk to. */
export function modelMenu(current: AgentKind, installed: readonly AgentKind[]): {
  same?: ModelCommand;
  others: Array<{ kind: AgentKind; terminalOnly: boolean }>;
} {
  const same = MODEL_COMMANDS[current];
  return {
    ...(same ? { same } : {}),
    others: installed.filter((kind) => kind !== current).map((kind) => ({ kind, terminalOnly: !chatAgent(kind) })),
  };
}

/** Ids for the menu's note under a model list, one per menu drawn. */
let noteIds = 0;

/**
 * Types a line as the phone's /api/input does: the text pasted (a bracketed paste keeps its lines in the prompt), then
 * Enter once it has landed, or the agent reads the Enter as part of the paste. Nothing while `blocked` (any menu on
 * the screen read right then: its Enter would pick the highlighted choice), and no Enter if a menu came up meanwhile.
 * With no bracketed paste each line break would be an Enter: they are folded as the phone folds them. False: nothing
 * was typed.
 */
export function typeLine(text: string, io: { blocked(): boolean; bracketed: boolean; paste(text: string): void; enter(): void; later(run: () => void, ms: number): void }): boolean {
  if (io.blocked()) return false;
  io.paste(io.bracketed ? text : oneLine(text));
  io.later(() => {
    if (!io.blocked()) io.enter();
  }, 300);
  return true;
}

/**
 * Whether a pane sent to its terminal to answer goes back to its chat: never while a menu is on its screen (read just
 * now) nor within 1.5 s of the person's last key there (or of arriving) -- one keypress never flips it; then once the
 * question it went there for is gone: a menu seen there since has left the screen, or (one no card could read) the AI
 * works again on work begun after the person's Enter there (`sentAt`). The person's own typing echoes as output, which
 * the lamp reads as work, so work older than that Enter, or with none yet, is not the answer taken.
 */
export const leaveTerminal = (state: { menuNow: boolean; menuSeen: boolean; working: boolean; workSince: number; sentAt?: number; quietMs: number }): boolean =>
  !state.menuNow && state.quietMs >= 1500 &&
  (state.menuSeen || (state.working && state.sentAt !== undefined && state.workSince > state.sentAt));

/** A session's chat let go (opened again, or closed): the next draw makes a new one, reading its talk afresh. */
export function dropChat(views: Map<string, ChatView>, key: string): void {
  views.get(key)?.dispose();
  views.delete(key);
}

/** The model the chip shows: the one last read, only while the session still runs the AI it was read for. */
export const shownModel = (read: { kind: AgentKind; model?: string } | undefined, now: AgentKind): string | undefined =>
  read?.kind === now ? read.model : undefined;

/** A session moved at `at` to another AI, or its AI to another model (main.ts `switching`). */
export interface Switch {
  to: AgentKind;
  at: number;
  /** Opened again: its AI's record is the one read now. Until then the chat reads none (it would be the last AI's). */
  up: boolean;
  /** It went on with a conversation of its own; else a new one began. */
  resume: boolean;
  /** A handoff is typed into the new one. */
  typed: boolean;
  /** The model picked, until a turn of the record names one. */
  model?: string;
}

/** How long a move is waited on for its record before the chat shows what it reads: another PC's clock may be behind. */
const SWITCH_WAIT_MS = 120_000;

/**
 * A read once the session is up after a move: a new conversation shows nothing of that AI's older ones (its newest
 * record is one until the new one writes), and "starting" while a handoff is on its way; a conversation it went on
 * with shows as read, with the picked model. `done`: the record has caught up with the move, or it is long ago.
 */
export function readAfterSwitch(move: Switch, read: SessionWorkflowResult, now: number): { read: SessionWorkflowResult; done: boolean } {
  if (now - move.at > SWITCH_WAIT_MS || (read.ok && read.workflow.events.some((event) => event.at >= move.at))) return { read, done: true };
  if (move.resume) return read.ok && move.model ? { read: { ok: true, workflow: { ...read.workflow, model: move.model } }, done: false } : { read, done: !move.model };
  return { read: move.typed ? { ok: false, reason: "no_transcript", why: "starting" } : { ok: true, workflow: { events: [] } }, done: false };
}

/** "Claude · claude-opus-5-5", or the AI's name alone while the record names no model. */
export const chipLabel = (kind: AgentKind, model?: string): string => model ? `${agents[kind].short} · ${model}` : agents[kind].short;

/** Claude's spinner line ("✶ Onioning… (17s · thinking)"), Codex's ("• Working (5s • esc to interrupt)"). */
const SPINNER = /^[✻✶✳✢✽·*]\s+(\S.*….*)$|^[•◦]\s+(\S.*\besc to interrupt\b.*)$/i;
/** A Claude tool line still at work: "● Searching for 1 pattern…" (done, it reads "Searched for 1 pattern"). */
const TOOL_AT_WORK = /^●\s+(\S.*…)(?:\s*\(ctrl\+o to expand\))?$/i;

/**
 * The CLI's own line for what it is doing now, read off the screen as it is, or undefined when it shows none: its
 * spinner line, or else a tool line still at work. In its brackets only the first part stays, the counter as a
 * rule: "Onioning… (17s · thinking)" is "Onioning… (17s)", "Working (5s • esc to interrupt)" is "Working (5s)".
 */
export function liveLine(screen: string): string | undefined {
  const lines = screen.split("\n").map((line) => line.replace(/\s+/g, " ").trim());
  let tool: string | undefined;
  for (let i = lines.length - 1; i >= 0; i--) {
    const spin = SPINNER.exec(lines[i]!);
    if (spin) return (spin[1] ?? spin[2]!).replace(/\s*\(([^()]*?)\s*[·•][^()]*\)/, (_, first: string) => first ? ` (${first})` : "");
    tool ??= TOOL_AT_WORK.exec(lines[i]!)?.[1];
  }
  return tool;
}

/** A prompt's words and the pictures sent with it: Claude's record writes "[image]" for a picture alone, "[Image #1]" among words. */
export const promptParts = (text: string): Array<string | { photo: true }> =>
  text.split(/(\[image\]|\[Image #\d+\])/).filter((part) => part !== "").map((part) => /^\[(?:image|Image #\d+)\]$/.test(part) ? { photo: true as const } : part);

/** An agent's mark once more on the page: its gradient ids made its own, or a second copy draws with the first's. */
const logo = (kind: AgentKind): HTMLElement => {
  const mark = document.createElement("span");
  mark.className = "chatLogo";
  mark.innerHTML = agentLogos[kind].replace(/id="([^"]+)"/g, 'id="$1-chat"').replace(/url\(#([^)]+)\)/g, "url(#$1-chat)");
  return mark;
};

/** A file attached in the composer: its name for its chip, and its path as the session types it. */
export interface Attached { name: string; text: string }

export interface ChatViewDeps {
  read(before?: number): Promise<SessionWorkflowResult>;
  /** The session's AI now: it may have been opened again with another. */
  agent(): AgentKind | undefined;
  /** The AIs this session's PC has; none for a bot's session, which stays with its own. */
  installed(): Promise<AgentKind[]>;
  /** Opens the folder's session again with this AI, told what was said so far (the "AI 바꾸기" handoff). */
  continueWith(kind: AgentKind): void;
  /** Codex's own model list on the session's PC (codexModelList); undefined when it cannot be read there. */
  codexModels(): Promise<Array<{ slug: string; name: string }> | undefined>;
  /** Opens the session again with Codex on this model, going on with the same conversation. */
  useCodexModel(slug: string): void;
  /** Reads the terminal's screen now, so ask() and mood() say what is on it this moment; true: a menu is on it, read as a card or not. */
  readScreen(): boolean;
  /** The terminal's screen as it is now, its rows joined. */
  screen(): string;
  /** A picture an answer names by its path on the session's PC (relative to its folder), as a data URL; undefined: none there. */
  image(path: string): Promise<string | undefined>;
  /** A prompt's picture by the name a read gave it, as a data URL, from main (chatPhoto); undefined: no longer held there. */
  photo(name: string): Promise<string | undefined>;
  /**
   * Types this into the session (typeLine). False: nothing was typed, a menu is on screen. A promise: on its way, and
   * how it went: "notSent" shows "보내지 못했어요 · 다시 보내기", "typed" (in the prompt, its Enter held back) says so with no resend.
   * `typing` is asked just before its first key (chatLine): false, it was taken back meanwhile and nothing is typed.
   */
  send(text: string, typing?: () => boolean): boolean | Promise<SendResult>;
  /** The AI's turn stopped with its CLI's own interrupt key (chatStop): never over a question on screen ("asking"), nor with no working line ("idle"). */
  stop(): Promise<"stopped" | "asking" | "idle" | "notSent">;
  /** The "/" list for this session with that AI: from its files, or (`own`) Claude's own where it gives one (the phone's /api/commands list). */
  commands(kind: AgentKind, own: boolean): Promise<Array<{ name: string; description: string }>>;
  /** One folder of the session's (relative to it, "" for itself, ending "/"); empty when it cannot be read. */
  folder(relative: string): Promise<Array<{ name: string; directory: boolean }>>;
  /** Files as the session reads them, each its name and path as typed (copied to its PC first when that is another one). */
  attach(paths: string[]): Promise<{ ok: true; items: Attached[] } | { ok: false; error: string }>;
  /** A picture with no file (pasted, or dragged from a browser), saved on the session's PC as the terminal's paste does. */
  picture(bytes: Uint8Array, type: string): Promise<{ ok: true; items: Attached[] } | { ok: false; error: string }>;
  /** A file copied in Explorer or Finder, its path; empty when none. */
  copiedFile(): string;
  /** The session takes typing now: up, and its AI not gone. */
  canType(): boolean;
  /**
   * Its connection dropped: the talk so far stays, under a line that says so -- being made again, or why that stopped
   * with `retry` (a button) to try once more. Undefined while it is up.
   */
  lost(): { text: string; retry?: () => void } | undefined;
  /** A drag the app started itself (out of its file tree): not files coming in. */
  appDrag(): boolean;
  mood(): SessionStatus;
  /** The question on the session's terminal as a card (chat-ask.ts chatCard); undefined when none is on it. */
  ask(): ChatCard | undefined;
  /** Answers the card drawn as `card` (chat-ask.ts answerCard): "busy" while other keys for the session are on their way. */
  answer(card: ChatCard, action: CardAction): Promise<CardResult | "busy">;
  /** The record reads further back (`before`): only Claude's. */
  older: boolean;
  icon(name: string): HTMLElement;
  copy(text: string): void;
  /** A web address, opened as the terminal's Ctrl+click opens it. */
  openLink(url: string, event: MouseEvent): void;
  /** A path printed in the talk (relative to the session's folder), opened as the terminal's Ctrl+click opens it. */
  openPath(printed: string, event: MouseEvent, folder?: boolean): void;
  toTerminal(): void;
}
export interface ChatView {
  element: HTMLElement;
  refresh(): Promise<void>;
  /** A line sent from outside the composer, shown at once as "보내는 중" until the record has it; its id. */
  pending(text: string): number;
  /** That line could not be sent: "보내지 못했어요 · 다시 보내기". */
  failed(id: number): void;
  /** The card for the menu on the terminal, drawn again if it changed: no read of the record. */
  showAsk(): void;
  /** A note over the composer with 다시 시도, which clears it and runs `retry`. */
  notice(text: string, retry: () => void): void;
  focus(): void;
  /** Lets go of what it watches: the view is not used again. */
  dispose(): void;
}

/** The largest picture attached from a paste or a drop (main's pasteImage refuses past it too: its dropLimitMb). */
const PICTURE_MB = 200;

/** Within this of the bottom, the list follows what is added. */
const NEAR_BOTTOM = 60;
/** Within this of the top, older talk is read. */
const NEAR_TOP = 40;
/** After an older read that threw, none for this long. */
const OLDER_REST_MS = 5000;

/**
 * The scrolling list as an element that hears being put into the page. A pane redraw takes it out and puts it
 * back, and an element taken out of the page loses where it was scrolled: it is put back there on arrival.
 */
function scrollingList(): HTMLElement & { arrived?: () => void } {
  if (!customElements.get("chat-list")) {
    customElements.define("chat-list", class extends HTMLElement {
      arrived?: () => void;
      connectedCallback() { this.arrived?.(); }
    });
  }
  return document.createElement("chat-list");
}

/** What a card's answer says when it did not go in. */
const cardNotes: Record<Exclude<CardResult, "ok"> | "busy", string> = { moved: "chat.ask.moved", stuck: "chat.ask.stuck", busy: "chat.ask.busy" };

/**
 * Whether the note goes as the card changes or goes: what a card's answer said ("stuck", "moved") was about that card,
 * and "answer it first" about a question now gone.
 */
export function cardNoteStale(note: string, asking: boolean): boolean {
  return (!asking && note === t("chat.answerFirst")) || Object.values(cardNotes).some((key) => note === t(key));
}

/**
 * A card takes no press this soon after it came to show another question than before (the next of a set, the review):
 * a click or Enter meant for the last one never answers one not seen yet.
 */
export const CARD_SETTLE_MS = 500;
/** How long a card stays on show while the screen shows none (a redraw caught half done) before it goes. */
const CARD_GONE_MS = 400;
/** The card comes to show another question than `shown` (none: the last card went): its presses wait CARD_SETTLE_MS. */
export const newQuestion = (shown: ChatCard | undefined, next: ChatCard): boolean => !shown || !sameQuestion(shown, next);

/**
 * Where the keyboard goes as a card is drawn again with the keyboard in it: the words being written; on Claude's
 * review its title, never 제출 (an Enter carried over would send the set); else its first row; else its first button.
 */
export function cardFocus(card: ChatCard, writing: boolean): "words" | "title" | "row" | "button" {
  if (writing) return "words";
  if (card.review) return "title";
  return card.options.some((option) => !option.chat) ? "row" : "button";
}

/**
 * A handoff main gave back (its AI never marked its prompt up after a question) on one look at the screen (main.ts
 * typeHandoff): a menu holds it, and its wait starts again once the menu goes; a plain prompt -- no menu, no work, the
 * AI there -- takes it; past the wait, a note says so.
 */
export function handoffStep(screen: { menu: boolean; working: boolean; up: boolean }, now: number, until: number): "hold" | "type" | "wait" | "stuck" {
  if (screen.menu) return "hold";
  if (screen.up && !screen.working) return "type";
  return now >= until ? "stuck" : "wait";
}

/** One session's conversation, read from its record: what was said, and what was done between, folded. */
export function createChatView(deps: ChatViewDeps): ChatView {
  const element = document.createElement("div");
  element.className = "chatView";
  // The column's first part; what is typed to the session goes under it.
  const list = scrollingList();
  list.className = "chatList";
  list.tabIndex = 0;

  // Under the list: what is typed to the session, with files attached and the model chip beside.
  const composer = document.createElement("div");
  composer.className = "chatComposer";
  const note = document.createElement("p");
  note.className = "chatNote";
  note.setAttribute("role", "alert");
  note.hidden = true;
  const tell = (message: string) => {
    note.textContent = message;
    note.hidden = message === "";
  };
  const box = document.createElement("div");
  box.className = "chatInput";
  const input = document.createElement("textarea");
  input.rows = 1;
  input.setAttribute("aria-label", t("chat.placeholder"));
  const bar = document.createElement("div");
  bar.className = "chatBar";
  const iconButton = (className: string, label: string, icon: string): HTMLButtonElement => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = className;
    button.setAttribute("aria-label", label);
    button.title = label;
    button.append(deps.icon(icon));
    return button;
  };
  const attach = iconButton("paneBtn chatAttach", t("chat.attach"), "plus");
  const picker = document.createElement("input");
  picker.type = "file";
  picker.multiple = true;
  picker.hidden = true;
  // The model chip: the AI and its model, and above it a menu to switch the model in place or carry the talk to another AI.
  const chip = document.createElement("span");
  chip.className = "chatChip";
  const chipButton = document.createElement("button");
  chipButton.type = "button";
  chipButton.className = "chatChipButton";
  chipButton.setAttribute("aria-haspopup", "menu");
  chipButton.setAttribute("aria-expanded", "false");
  const chipText = document.createElement("span");
  const menu = document.createElement("div");
  menu.className = "chatMenu";
  menu.setAttribute("role", "menu");
  // A click on its headings keeps the keyboard inside, so the menu stays open.
  menu.tabIndex = -1;
  menu.hidden = true;
  chip.append(chipButton, menu);
  /** The model the record named at the last read, and the AI it was read for; none when that read failed. */
  let modelRead: { kind: AgentKind; model?: string } | undefined;
  let chipDrawn = "";
  const syncChip = () => {
    const kind = deps.agent();
    chip.hidden = kind === undefined;
    const label = kind === undefined ? "" : chipLabel(kind, shownModel(modelRead, kind));
    if (kind === undefined || label === chipDrawn) return;
    chipDrawn = label;
    chipText.textContent = label;
    chipButton.title = label;
    chipButton.replaceChildren(logo(kind), chipText, deps.icon("chevronUp"));
  };
  /** Bumped as the menu opens and closes: the list of other AIs, read slowly, lands only in the menu that asked. */
  let menuRun = 0;
  const menuItems = () => [...menu.querySelectorAll<HTMLElement>('[role^="menuitem"]')];
  const closeMenu = (toChip: boolean) => {
    if (menu.hidden) return;
    menu.hidden = true;
    menuRun++;
    chipButton.setAttribute("aria-expanded", "false");
    if (toChip) chipButton.focus();
  };
  const menuGroup = (heading: string, rows: HTMLElement[]): HTMLElement => {
    const group = document.createElement("div");
    group.setAttribute("role", "group");
    group.setAttribute("aria-label", heading);
    const head = document.createElement("span");
    head.className = "chatMenuHead";
    head.setAttribute("aria-hidden", "true");
    head.textContent = heading;
    group.append(head, ...rows);
    return group;
  };
  const words = (text: string, className: string): HTMLElement => {
    const span = document.createElement("span");
    span.className = className;
    span.textContent = text;
    return span;
  };
  /** One row; with nothing to do it is only read out. */
  const menuRow = (role: "menuitem" | "menuitemradio", parts: Node[], pick?: () => void): HTMLElement => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "listRow chatMenuItem";
    button.setAttribute("role", role);
    button.tabIndex = -1;
    button.append(...parts);
    if (!pick) button.setAttribute("aria-disabled", "true");
    else {
      button.addEventListener("click", () => {
        closeMenu(true);
        pick();
      });
    }
    return button;
  };
  /**
   * The model line for the menu opened on `kind`, typed only as canTypeModel allows, on the screen as read right now
   * (as a card's press is): a question that came up since the last read takes no Enter. The session opened again
   * with another AI meanwhile takes nothing: the line was that AI's. send() reads the screen once more before the
   * paste and again before its Enter.
   */
  const switchModel = (kind: AgentKind, line: string) => {
    const menuUp = deps.readScreen();
    if (deps.agent() !== kind) return;
    if (menuUp || !canTypeModel(deps.canType(), deps.ask(), deps.mood())) return tell(t("chat.cannotType"));
    tell(deps.send(line) ? "" : t("chat.cannotType"));
  };
  /** Codex on another model: the session opened again, so not over its work or a question, as a model line is not. */
  const useCodexModel = (slug: string) => {
    const menuUp = deps.readScreen();
    if (deps.agent() !== "codex") return;
    if (menuUp || !canTypeModel(deps.canType(), deps.ask(), deps.mood())) return tell(t("chat.cannotType"));
    deps.useCodexModel(slug);
  };
  const openMenu = (kind: AgentKind) => {
    const run = ++menuRun;
    const { same } = modelMenu(kind, []);
    const heading = t("chat.sameAi", { agent: agents[kind].short });
    const model = shownModel(modelRead, kind);
    // Said under the list, and read out with each of its models.
    const noteId = `chatModelNote${++noteIds}`;
    const alsoDefault = same?.alsoDefault ? [Object.assign(words(t("chat.modelDefaultToo"), "chatMenuNote chatMenuAside"), { id: noteId })] : [];
    menu.replaceChildren(menuGroup(heading, same
      ? [...same.models.map((name) => {
        const on = model?.includes(name) === true;
        const item = menuRow("menuitemradio", [words(name.charAt(0).toUpperCase() + name.slice(1), "chatMenuName"), ...(on ? [words(t("chat.now"), "chatMenuNow")] : [])], () => switchModel(kind, same.line(name)));
        item.setAttribute("aria-checked", String(on));
        if (alsoDefault.length) item.setAttribute("aria-describedby", noteId);
        return item;
      }), ...alsoDefault]
      : [menuRow("menuitem", [words(t("chat.modelInTerminal"), "chatMenuName")])]));
    menu.setAttribute("aria-label", chipText.textContent ?? "");
    menu.hidden = false;
    chipButton.setAttribute("aria-expanded", "true");
    const items = menuItems();
    (items.find((item) => item.getAttribute("aria-checked") === "true") ?? items[0])?.focus();
    // Codex's /model is a picker, no line: its list read off its PC, a pick opening the session again on that model.
    if (kind === "codex") void deps.codexModels().then((list) => {
      if (run !== menuRun || !list) return;
      const had = menu.contains(document.activeElement);
      const old = menu.firstElementChild;
      const group = menuGroup(heading, list.map(({ slug, name }) => {
        const on = model === slug;
        const item = menuRow("menuitemradio", [words(name, "chatMenuName"), ...(on ? [words(t("chat.now"), "chatMenuNow")] : [])], on ? undefined : () => useCodexModel(slug));
        item.setAttribute("aria-checked", String(on));
        return item;
      }));
      // The keyboard onto the new rows before the old ones go: a focused row taken out of the page drops the focus
      // with nowhere inside the chip to go, and the chip's focusout closed the menu the moment the list came.
      menu.prepend(group);
      const now = [...group.querySelectorAll<HTMLElement>('[role^="menuitem"]')];
      if (had) (now.find((item) => item.getAttribute("aria-checked") === "true") ?? now[0])?.focus();
      old?.remove();
    }, () => undefined);
    void deps.installed().then((installed) => {
      const { others } = modelMenu(kind, installed);
      if (run !== menuRun || others.length === 0) return;
      const line = document.createElement("div");
      line.className = "chatMenuLine";
      line.setAttribute("role", "separator");
      menu.append(line, menuGroup(t("chat.otherAi"), others.map(({ kind: other, terminalOnly }) =>
        menuRow("menuitem", [logo(other), words(agents[other].short, "chatMenuName"), ...(terminalOnly ? [words(t("chat.terminalOnly"), "chatMenuNote")] : [])], () => deps.continueWith(other)))));
    }, () => undefined);
  };
  chipButton.addEventListener("click", () => {
    if (!menu.hidden) return closeMenu(true);
    const kind = deps.agent();
    if (kind) openMenu(kind);
  });
  chipButton.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowUp" || !menu.hidden) return;
    event.preventDefault();
    chipButton.click();
  });
  menu.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      // The menu's, not the pane's or a dialog's under it.
      event.preventDefault();
      event.stopPropagation();
      return closeMenu(true);
    }
    const items = menuItems();
    const to = menuMove(event.key, items.indexOf(document.activeElement as HTMLElement), items.length);
    if (to === undefined) return;
    event.preventDefault();
    items[to]!.focus();
  });
  // A click outside or a Tab away takes the keyboard out of the chip: the menu closes.
  chip.addEventListener("focusout", (event) => {
    if (!chip.contains(event.relatedTarget as Node | null)) closeMenu(false);
  });
  const sendButton = iconButton("chatSend", t("chat.send"), "arrowUp");
  /** The CLI's own working line at the live line's last look (syncLive), none over a question: the button stops it then. */
  let workLine: string | undefined;
  let buttonDoes: ReturnType<typeof composerAction> = "send";
  const syncButton = () => {
    const does = composerAction(pending.some((one) => one.queued), workLine);
    if (does === buttonDoes) return;
    buttonDoes = does;
    const label = t(does === "send" ? "chat.send" : does === "stop" ? "chat.stop" : "chat.cancelSend");
    sendButton.setAttribute("aria-label", label);
    sendButton.title = label;
    sendButton.classList.toggle("stop", does !== "send");
    sendButton.replaceChildren(deps.icon(does === "send" ? "arrowUp" : does === "stop" ? "square" : "x"));
  };
  const beta = document.createElement("span");
  beta.className = "chatBeta";
  beta.textContent = t("chat.beta");
  bar.append(attach, picker, chip, beta, sendButton);
  // Over the field while "/" or "@" is typed: the AI's commands or one folder's files, as its terminal and the phone offer them.
  const suggest = document.createElement("div");
  suggest.className = "chatSuggest";
  suggest.id = `chatSuggest${++noteIds}`;
  suggest.setAttribute("role", "listbox");
  suggest.hidden = true;
  // The field keeps the keyboard on a press anywhere in the list -- a row, the gap between rows, its scrollbar (which
  // still scrolls): a blur would close it.
  suggest.addEventListener("mousedown", (event) => event.preventDefault());
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-controls", suggest.id);
  input.setAttribute("aria-expanded", "false");
  let rows: SuggestRow[] = [];
  let picked = 0;
  let suggestRun = 0;
  /** The list for the AI the session runs: the files' at once, then Claude's own when it gives one. */
  let commandsAsked: { kind: AgentKind; list: Promise<Array<{ name: string; description: string }>> } | undefined;
  const commandsOf = (kind: AgentKind) => {
    if (commandsAsked?.kind !== kind) commandsAsked = { kind, list: deps.commands(kind, false).catch(() => []) };
    return commandsAsked.list;
  };
  /** Claude's own list, asked as a "/" list opens (main asks Claude only when what shapes it moved): it replaces the files'. */
  let ownAsking = false;
  const askOwn = (kind: AgentKind) => {
    if (kind !== "claude" || ownAsking) return;
    ownAsking = true;
    void deps.commands(kind, true).then((list) => {
      if (list.length && deps.agent() === kind) {
        commandsAsked = { kind, list: Promise.resolve(list) };
        if (!suggest.hidden && suggestAsk(input.value.slice(0, input.selectionStart)) !== undefined) void updateSuggest();
      }
    }, () => undefined).finally(() => (ownAsking = false));
  };
  /** Each folder listed once while the list is up. */
  const listed = new Map<string, Promise<Array<{ name: string; directory: boolean }>>>();
  const closeSuggest = () => {
    suggestRun++;
    rows = [];
    listed.clear();
    suggest.hidden = true;
    suggest.replaceChildren();
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
  };
  const showPicked = () => {
    [...suggest.children].forEach((option, at) => option.setAttribute("aria-selected", String(at === picked)));
    const on = suggest.children[picked];
    if (!on) return;
    input.setAttribute("aria-activedescendant", on.id);
    on.scrollIntoView({ block: "nearest" });
  };
  const updateSuggest = async () => {
    const run = ++suggestRun;
    const before = input.value.slice(0, input.selectionStart);
    const ask = input.selectionStart === input.selectionEnd ? suggestAsk(before) : undefined;
    const kind = deps.agent();
    // "$" is Codex's: in another AI's prompt it is only a letter.
    if (!ask || ("slash" in ask && !kind) || ("skill" in ask && kind !== "codex")) return closeSuggest();
    let next: SuggestRow[];
    if ("slash" in ask) {
      if (suggest.hidden) askOwn(kind!);
      next = slashRows((await commandsOf(kind!)).filter((command) => command.name.startsWith("/")), ask.slash);
    } else if ("skill" in ask) {
      next = skillRows(await commandsOf(kind!), before, ask.skill);
    } else {
      if (!listed.has(ask.folder)) listed.set(ask.folder, deps.folder(ask.folder).catch(() => []));
      next = fileRows(await listed.get(ask.folder)!, before, ask.folder, ask.typed);
    }
    if (run !== suggestRun) return;
    if (next.length === 0) return closeSuggest();
    rows = next;
    picked = 0;
    suggest.setAttribute("aria-label", "slash" in ask ? t("chat.suggestCommands") : "skill" in ask ? t("chat.suggestSkills") : t("chat.suggestFiles"));
    suggest.replaceChildren(...next.map((row, at) => {
      const option = document.createElement("div");
      option.id = `${suggest.id}-${at}`;
      option.className = "chatSuggestRow";
      option.setAttribute("role", "option");
      option.append(words(row.label, "chatSuggestName"), ...(row.detail ? [words(row.detail, "chatSuggestDetail")] : []));
      option.title = row.detail ?? row.label;
      option.addEventListener("click", () => pickRow(row));
      return option;
    }));
    suggest.hidden = false;
    input.setAttribute("aria-expanded", "true");
    showPicked();
  };
  /** The text before the caret becomes the row's; a folder's row lists that folder next. */
  const pickRow = (row: SuggestRow) => {
    input.setRangeText(row.insert, 0, input.selectionStart, "end");
    input.focus();
    void updateSuggest();
  };
  input.addEventListener("input", () => void updateSuggest());
  input.addEventListener("blur", closeSuggest);
  // Over the field: what goes with the next line, each removable, until it is sent.
  const attached: Attached[] = [];
  const chips = document.createElement("div");
  chips.className = "chatAttached";
  chips.setAttribute("role", "list");
  chips.setAttribute("aria-label", t("chat.attached"));
  chips.hidden = true;
  const drawAttached = () => {
    chips.hidden = attached.length === 0;
    chips.replaceChildren(...attached.map((one, at) => {
      const chip = document.createElement("span");
      chip.className = "chatAttachedItem";
      chip.setAttribute("role", "listitem");
      chip.title = one.text.trim();
      const remove = iconButton("chatAttachedRemove", t("chat.removeAttached", { name: one.name }), "x");
      remove.addEventListener("click", () => {
        attached.splice(at, 1);
        drawAttached();
        input.focus();
      });
      chip.append(words(one.name, "chatAttachedName"), remove);
      return chip;
    }));
  };
  box.append(suggest, chips, input, bar);
  // Over the composer while subagents run: how many, unfolding to each one's name and time.
  const subs = document.createElement("div");
  subs.className = "chatSubs";
  subs.hidden = true;
  const subsHead = document.createElement("button");
  subsHead.type = "button";
  subsHead.className = "chatSubsHead";
  subsHead.setAttribute("aria-expanded", "false");
  const subsList = document.createElement("ul");
  subsList.className = "chatSubsList";
  subsList.hidden = true;
  subsHead.addEventListener("click", () => {
    subsList.hidden = !subsList.hidden;
    subsHead.setAttribute("aria-expanded", String(!subsList.hidden));
  });
  subs.append(subsHead, subsList);
  composer.append(subs, note, box);
  // Over the talk while the connection is made again: it stays as it was, and says why nothing moves.
  const lostLine = document.createElement("p");
  lostLine.className = "chatLost";
  lostLine.setAttribute("role", "status");
  lostLine.hidden = true;
  const lostText = document.createElement("span");
  const lostRetry = document.createElement("button");
  lostRetry.type = "button";
  lostRetry.className = "chatLostRetry";
  lostRetry.textContent = t("chat.reconnect");
  lostLine.append(lostText, lostRetry);
  let retryLost: (() => void) | undefined;
  lostRetry.addEventListener("click", () => retryLost?.());
  const syncLost = () => {
    const lost = deps.lost();
    lostLine.hidden = lost === undefined;
    lostText.textContent = lost?.text ?? "";
    retryLost = lost?.retry;
    lostRetry.hidden = retryLost === undefined;
  };
  element.append(lostLine, list, composer);

  /** Not `disabled`: a disabled field drops the keyboard to the page, and what was typed stays put to send later. */
  const syncInput = () => {
    syncLost();
    const can = deps.canType();
    box.classList.toggle("locked", !can);
    input.readOnly = !can;
    input.placeholder = can ? t("chat.placeholder") : t("chat.cannotType");
    for (const button of [attach, sendButton]) {
      if (can) button.removeAttribute("aria-disabled");
      else button.setAttribute("aria-disabled", "true");
    }
  };
  const submit = () => {
    syncInput();
    const text = withAttached(attached.map((one) => one.text), input.value.trim());
    if (text === "") return;
    // Kept as typed while the session cannot take it, or while a question waits on screen.
    if (!deps.canType()) return tell(t("chat.cannotType"));
    if (!sendLine(text)) return tell(t("chat.answerFirst"));
    input.value = "";
    attached.length = 0;
    drawAttached();
    closeSuggest();
    tell("");
  };
  /** Lines taken back before their first key (takeBack), by id: the wait's end types nothing. */
  const takenBack = new Set<number>();
  /** Sends `text` and shows it at once as "보내는 중"; false: nothing was typed (a menu on screen). */
  const sendLine = (text: string): boolean => {
    let id: number | undefined;
    let typed = false;
    // With nothing to wait for (a local pane), chatLine asks this before deps.send returns, `id` not yet given: the
    // line is drawn as on its way, never as waiting (chatLine's own test pins it).
    const sent = deps.send(text, () => {
      if (id !== undefined && takenBack.delete(id)) return false;
      typed = true;
      const one = pending.find((other) => other.id === id);
      if (one?.queued) {
        delete one.queued;
        drawPending();
      }
      return true;
    });
    if (sent === false) return false;
    // A line after a stop: the stop's mark and its wait are over.
    stopAsked = false;
    stopOver = false;
    syncStopped();
    id = addPending(text, !typed);
    const sentOut = () => {
      if (!settlesOnSend(text)) return;
      pending = pending.filter((one) => one.id !== id);
      drawPending();
    };
    if (sent === true) sentOut();
    else void sent.then((result) => (result === "sent" ? sentOut() : markFailed(id, result === "typed")), () => markFailed(id, false)).finally(() => takenBack.delete(id));
    return true;
  };
  input.addEventListener("keydown", (event) => {
    const move = suggest.hidden ? undefined : suggestKey(event);
    if (move) {
      // The list's, not the composer's nor the pane's.
      event.preventDefault();
      event.stopPropagation();
      if (move === "close") return closeSuggest();
      if (move === "pick") return pickRow(rows[picked]!);
      picked = menuMove(move === "down" ? "ArrowDown" : "ArrowUp", picked, rows.length)!;
      return showPicked();
    }
    const key = composerKey(event, input.value === "" && attached.length === 0);
    if (key === "stop") {
      syncButton();
      // Nothing to stop: Esc is the pane's, as before.
      if (buttonDoes === "send") return;
      event.preventDefault();
      event.stopPropagation();
      return press();
    }
    if (key !== "send") return;
    event.preventDefault();
    submit();
  });
  sendButton.addEventListener("click", () => press());
  attach.addEventListener("click", () => {
    if (deps.canType()) picker.click();
  });
  /** Files picked, pasted or dropped: each a chip until sent. Pictures with no file are saved on the session's PC first. */
  const attachFiles = async (files: readonly File[], found: { paths: string[]; pictures: number[] }) => {
    if (!deps.canType()) return tell(t("chat.cannotType"));
    // Not read whole into the page and sent over first, to be refused there (main's limit is the same).
    if (found.pictures.some((at) => files[at]!.size > PICTURE_MB * 1024 * 1024)) return tell(t("err.dropTooBig", { mb: PICTURE_MB }));
    // A copy to another PC takes a moment: said, so a line sent meanwhile is known to go without it.
    tell(t("chat.attaching"));
    const results = await Promise.all([
      ...(found.paths.length ? [deps.attach(found.paths)] : []),
      ...found.pictures.map(async (at) => deps.picture(new Uint8Array(await files[at]!.arrayBuffer()), files[at]!.type)),
    ]);
    const failed = results.find((result) => !result.ok);
    tell(failed && !failed.ok ? failed.error : "");
    for (const result of results) if (result.ok) attached.push(...result.items);
    drawAttached();
    input.focus();
  };
  const fileList = (files: FileList | null | undefined) => [...(files ?? [])];
  const withPaths = (files: readonly File[]) => files.map((file) => ({ path: window.cockpit.pathForFile(file), type: file.type }));
  picker.addEventListener("change", () => {
    const files = fileList(picker.files);
    // The same file picked again is a change again.
    picker.value = "";
    const found = pastedFiles(withPaths(files), "", () => "");
    if (found) void attachFiles(files, found);
  });
  // A paste with files or a picture in it attaches them, as the terminal's does; plain text pastes as text.
  input.addEventListener("paste", (event) => {
    const files = fileList(event.clipboardData?.files);
    const found = pastedFiles(withPaths(files), event.clipboardData?.getData("text/plain") ?? "", deps.copiedFile);
    if (!found) return;
    event.preventDefault();
    void attachFiles(files, found);
  });
  // Files dragged in from Explorer or Finder (or a picture from a browser), anywhere on the chat.
  const filesIn = (event: DragEvent) => event.dataTransfer?.types.includes("Files") === true && !deps.appDrag();
  for (const type of ["dragenter", "dragover"] as const) {
    element.addEventListener(type, (event) => {
      if (!filesIn(event)) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer!.dropEffect = "copy";
      box.classList.add("filesOver");
    });
  }
  element.addEventListener("dragleave", (event) => {
    if (!element.contains(event.relatedTarget as Node | null)) box.classList.remove("filesOver");
  });
  element.addEventListener("drop", (event) => {
    box.classList.remove("filesOver");
    if (!filesIn(event)) return;
    event.preventDefault();
    event.stopPropagation();
    const files = fileList(event.dataTransfer?.files);
    const found = pastedFiles(withPaths(files), "", () => "");
    if (found) void attachFiles(files, found);
  });

  let events: WorkflowItem[] = [];
  /** At work, or held on a call (a permission question): the last work row is not done, and its time goes on. */
  const runningNow = () => {
    const mood = deps.mood();
    return mood === "working" || (mood === "waiting" && heldOnScreen(chatRows(events), deps.screen()));
  };
  let drawn: string | undefined;
  /** The first row drawn, to tell older rows put in front. */
  let drawnFirst: string | undefined;
  let reading = false;
  /** Asked while a read was on its way (the record changed again): one more read after it. */
  let readAgain = false;
  /** Work rows unfolded, by when they began: a redraw keeps them open. */
  const open = new Set<number>();
  /** The row still running, whose time moves on without a redraw. */
  let live: { label: HTMLElement; row: WorkRow } | undefined;
  let stuck = true;
  let top = 0;
  const shown = () => list.isConnected && list.clientHeight > 0;
  /** Text being selected in the list would come undone: a redraw waits for a moment with no selection. */
  const selecting = () => {
    const selection = document.getSelection();
    return selection !== null && !selection.isCollapsed && list.contains(selection.anchorNode);
  };
  /** Reading older talk, whether the record has none left to give, and until when a read that threw is not tried again. */
  let readingOlder = false;
  let oldest = false;
  let restUntil = 0;
  const loadOlder = async () => {
    const first = events[0]?.at;
    if (!deps.older || oldest || readingOlder || Date.now() < restUntil || first === undefined || list.scrollTop >= NEAR_TOP) return;
    readingOlder = true;
    try {
      const result = await deps.read(first);
      const before = events.length;
      if (result.ok) events = olderEvents(events, result.workflow.events);
      if (!result.ok || result.workflow.more !== true || events.length === before) oldest = true;
      // Drawn now, or by the next refresh once nothing is selected (its read differs from what was drawn).
      if (events.length === before || selecting()) return;
      const running = runningNow();
      drawn = JSON.stringify([events, running]);
      draw(running);
    } catch {
      // Unreadable for now (the PC went away mid-read): a scroll up a few seconds on tries again, not every scroll.
      restUntil = Date.now() + OLDER_REST_MS;
    } finally {
      readingOlder = false;
    }
  };
  list.addEventListener("scroll", () => {
    if (!shown()) return;
    stuck = list.scrollHeight - list.scrollTop - list.clientHeight < NEAR_BOTTOM;
    top = list.scrollTop;
    void loadOlder();
  });
  // A list too short to scroll hears no scroll: a wheel turned up asks too.
  list.addEventListener("wheel", (event) => {
    if (event.deltaY < 0 && shown()) void loadOlder();
  }, { passive: true });
  const place = () => {
    if (shown()) list.scrollTop = stuck ? list.scrollHeight : top;
  };
  list.arrived = place;
  // Shown again after the panel was hidden, or the pane resized: still at the bottom if it was.
  const resized = new ResizeObserver(place);
  resized.observe(list);

  // Links open the way the terminal's do, never inside this page: an answer's own link on a click, and with Ctrl
  // (Cmd) held any address or path in the talk's text -- a code block's and inline code's too.
  list.addEventListener("click", (event) => {
    const link = (event.target as Element).closest("a[href]");
    if (link) {
      event.preventDefault();
      const href = link.getAttribute("href") ?? "";
      const target = answerLink(href);
      if (target && "path" in target) deps.openPath(target.path, event);
      else if (target) deps.openLink(target.url, event);
      return;
    }
    if (!(event.ctrlKey || event.metaKey) || (event.target as Element).closest("button")) return;
    const caret = document.caretRangeFromPoint(event.clientX, event.clientY);
    const node = caret?.startContainer;
    if (!caret || node?.nodeType !== Node.TEXT_NODE || !list.contains(node)) return;
    // The text the click is in, whole: the line it is on is read as the terminal reads a row.
    const block = node.parentElement!.closest<HTMLElement>("pre, p, li, td, th, h1, h2, h3, h4, h5, h6, blockquote, .chatBubble, code") ?? node.parentElement!;
    const before = document.createRange();
    before.setStart(block, 0);
    before.setEnd(node, caret.startOffset);
    const found = linkAt(block.textContent ?? "", before.toString().length);
    if (!found) return;
    event.preventDefault();
    if ("url" in found) deps.openLink(found.url, event);
    else deps.openPath(found.path, event, found.folder);
  });

  const workWords = (row: WorkRow, running: boolean): string => {
    const sum = workSummary(row, running, Date.now());
    if (running) return t("chat.working", { time: durationWords(sum.seconds ?? 0, t) });
    const counts = { commands: sum.commands, files: sum.files };
    return sum.seconds === undefined ? t("chat.workDoneBare", counts) : t("chat.workDone", { time: durationWords(sum.seconds, t), ...counts });
  };

  /** Calls' outputs opened whole ("더 보기"), by their row's start and place in it: a redraw keeps them open. */
  const wholeOutput = new Set<string>();
  /** What a call gave back: two lines, and "더 보기" for the rest. */
  const outputBlock = (output: string, key: string): HTMLElement => {
    const box = document.createElement("div");
    box.className = "chatStepOut";
    const text = document.createElement("pre");
    const { preview, more } = outputPreview(output);
    box.append(text);
    const toggle = more ? document.createElement("button") : undefined;
    const show = () => {
      const whole = wholeOutput.has(key);
      text.textContent = whole ? output : preview;
      if (!toggle) return;
      toggle.textContent = t(whole ? "chat.less" : "chat.more");
      toggle.setAttribute("aria-expanded", String(whole));
    };
    if (toggle) {
      toggle.type = "button";
      toggle.className = "chatMore";
      toggle.addEventListener("click", () => {
        if (!wholeOutput.delete(key)) wholeOutput.add(key);
        show();
      });
      box.append(toggle);
    }
    show();
    return box;
  };

  const stepLine = (step: ToolStep, running: boolean, key: string): HTMLElement => {
    const line = document.createElement("div");
    line.className = "chatStep";
    const kind = document.createElement("span");
    kind.className = "chatStepKind";
    kind.textContent = t(`chat.step.${step.tool}`);
    const target = document.createElement("code");
    target.textContent = step.target;
    target.title = step.target;
    const result = document.createElement("span");
    result.className = `chatStepResult ${step.result ?? (running ? "running" : "")}`;
    result.textContent = step.result ? t(`chat.result.${step.result}`) : running ? t("chat.result.running") : "";
    line.append(kind, target, result);
    if (step.output) line.append(outputBlock(step.output, key));
    return line;
  };

  /** A subagent's fold: its name, and how it is going. */
  const subWords = (row: SubRow, state: ReturnType<typeof subState>): string => t("chat.sub", {
    name: row.description || row.agentType || t("chat.sub.unnamed"),
    state: state === "running" ? t("chat.sub.running", { time: durationWords(Math.max(0, Math.round((Date.now() - row.at) / 1000)), t) })
      : t(state === "done" ? "chat.sub.done" : "chat.sub.stopped"),
  });
  /** Subagent rows unfolded, by when they began (apart from work rows: a call and a subagent can share a time). */
  const subOpen = new Set<number>();
  /** The subagent rows still running, whose time moves on without a redraw. */
  let liveSubs: Array<{ label: HTMLElement; row: SubRow }> = [];
  const subRow = (row: SubRow, state: ReturnType<typeof subState>): HTMLElement => {
    const box = document.createElement("div");
    box.className = "chatWork chatSub";
    const head = document.createElement("button");
    head.type = "button";
    head.className = state === "running" ? "chatWorkHead live" : "chatWorkHead";
    const label = document.createElement("span");
    label.textContent = subWords(row, state);
    const chevron = document.createElement("span");
    chevron.className = "chatChevron";
    chevron.textContent = "›";
    chevron.setAttribute("aria-hidden", "true");
    head.append(label, chevron);
    const body = document.createElement("div");
    body.className = "chatSubBody";
    const part = (heading: string, text: string) => {
      const name = document.createElement("span");
      name.className = "chatSubHead";
      name.textContent = heading;
      const words = document.createElement("pre");
      words.textContent = text;
      body.append(name, words);
    };
    if (row.instructions) part(t("chat.sub.given"), row.instructions);
    if (row.result) part(t("chat.sub.result"), row.result);
    if (!row.instructions && !row.result) {
      const none = document.createElement("span");
      none.className = "chatSubHead";
      none.textContent = t("chat.sub.none");
      body.append(none);
    }
    const fold = (unfolded: boolean) => {
      body.hidden = !unfolded;
      head.setAttribute("aria-expanded", String(unfolded));
      if (unfolded) subOpen.add(row.at);
      else subOpen.delete(row.at);
    };
    fold(subOpen.has(row.at));
    head.addEventListener("click", () => fold(!subOpen.has(row.at)));
    if (state === "running") liveSubs.push({ label, row });
    box.append(head, body);
    return box;
  };

  /** Over the composer: the subagents running now, by name and time; gone when none run. */
  const syncSubs = (rows: readonly ChatRow[], working: boolean) => {
    const running = runningSubs(rows, working);
    const was = subs.hidden;
    subs.hidden = running.length === 0;
    const chevron = deps.icon("chevronDown");
    subsHead.replaceChildren(t("chat.subs", { n: running.length }), chevron);
    subsList.replaceChildren(...running.map((row) => {
      const item = document.createElement("li");
      const name = document.createElement("span");
      name.textContent = row.description || row.agentType || t("chat.sub.unnamed");
      const time = document.createElement("span");
      time.className = "chatSubsTime";
      time.textContent = durationWords(Math.max(0, Math.round((Date.now() - row.at) / 1000)), t);
      item.append(name, time);
      return item;
    }));
    // The list got shorter or taller over the composer: one kept at the bottom stays there.
    if (was !== subs.hidden) place();
  };

  const workRow = (row: WorkRow, running: boolean): HTMLElement => {
    const box = document.createElement("div");
    box.className = "chatWork";
    const head = document.createElement("button");
    head.type = "button";
    head.className = running ? "chatWorkHead live" : "chatWorkHead";
    const label = document.createElement("span");
    label.textContent = workWords(row, running);
    const chevron = document.createElement("span");
    chevron.className = "chatChevron";
    chevron.textContent = "›";
    chevron.setAttribute("aria-hidden", "true");
    head.append(label, chevron);
    const steps = document.createElement("div");
    steps.className = "chatSteps";
    // Built when first unfolded: a long talk's folded rows cost nothing to draw.
    let built = false;
    const fold = (unfolded: boolean) => {
      if (unfolded && !built) {
        built = true;
        steps.append(...row.steps.map((step, index) => stepLine(step, running, `${row.at}:${index}`)));
      }
      steps.hidden = !unfolded;
      head.setAttribute("aria-expanded", String(unfolded));
      if (unfolded) open.add(row.at);
      else open.delete(row.at);
    };
    fold(open.has(row.at));
    head.addEventListener("click", () => fold(!open.has(row.at)));
    if (running) live = { label, row };
    box.append(head, steps, ...(row.cancelled ? [stoppedMark()] : []));
    return box;
  };
  /** 멈췄어요 under a row the record says the turn was stopped at. */
  const stoppedMark = (): HTMLElement => words(t("chat.stopped"), "chatStopped");

  /** Each path's picture, read once for this view. */
  const images = new Map<string, Promise<string | undefined>>();
  const showImages = (body: HTMLElement) => {
    for (const label of body.querySelectorAll<HTMLElement>("span.chatImage[data-path]")) {
      const path = label.dataset.path!;
      let read = images.get(path);
      // Not there (yet): forgotten, so the next draw -- the record changed -- asks again.
      if (!read) {
        images.set(path, (read = deps.image(path).catch(() => undefined).then((src) => {
          if (src === undefined) images.delete(path);
          return src;
        })));
      }
      void read.then((src) => {
        if (!src || !label.isConnected) return;
        const image = document.createElement("img");
        image.className = "chatImage";
        image.alt = label.textContent ?? "";
        image.title = path;
        image.src = src;
        // Taller once it has loaded: a list kept at the bottom stays there.
        image.addEventListener("load", place, { once: true });
        label.replaceWith(image);
      });
    }
  };

  const answerRow = (text: string, cancelled?: true): HTMLElement => {
    const box = document.createElement("div");
    box.className = "chatAgent";
    const body = document.createElement("div");
    body.className = "chatAnswer";
    body.innerHTML = renderAnswer(text);
    showImages(body);
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "paneBtn chatCopy";
    copy.setAttribute("aria-label", t("chat.copy"));
    copy.title = t("chat.copy");
    copy.append(deps.icon("copy"));
    copy.addEventListener("click", () => {
      deps.copy(text);
      copy.classList.add("copied");
      setTimeout(() => copy.classList.remove("copied"), 1200);
    });
    box.append(body, ...(cancelled ? [stoppedMark()] : []), copy);
    return box;
  };

  /** A picture opened larger, over the app: one for the view, in the page's top layer (a pane redraw cannot take it out). */
  let viewer: HTMLDialogElement | undefined;
  const viewPhoto = (src: string) => {
    if (!viewer) {
      viewer = document.createElement("dialog");
      viewer.className = "chatPhotoView";
      viewer.setAttribute("aria-label", t("chat.photo"));
      const close = iconButton("paneBtn chatPhotoClose", t("chat.photoClose"), "x");
      close.addEventListener("click", () => viewer!.close());
      // A click beside the picture closes it, as Esc does.
      viewer.addEventListener("click", (event) => {
        if (event.target === viewer) viewer.close();
      });
      viewer.append(close, document.createElement("img"));
      document.body.append(viewer);
    }
    const image = viewer.querySelector("img")!;
    image.src = src;
    image.alt = t("chat.photo");
    viewer.showModal();
  };
  const photoChip = () => {
    const chip = document.createElement("span");
    chip.className = "chatPhoto";
    chip.append(deps.icon("image"), t("chat.photo"));
    return chip;
  };
  /** Each picture's thumbnail by its name, asked of main once and moved into each draw as it is, not decoded again. */
  const thumbs = new Map<string, HTMLButtonElement>();
  /**
   * A picture from the record as a thumbnail, by the name a read gave it; one not kept (too big, an address) stays
   * the "사진" chip, as does one main no longer holds (asked again at the next draw).
   */
  const photo = (name: string | undefined): HTMLElement => {
    if (!name) return photoChip();
    const held = thumbs.get(name);
    if (held) return held;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "chatThumb";
    button.setAttribute("aria-label", t("chat.photoOpen"));
    button.title = t("chat.photoOpen");
    const image = document.createElement("img");
    image.alt = "";
    image.decoding = "async";
    // Taller once it has loaded: a list kept at the bottom stays there.
    image.addEventListener("load", place, { once: true });
    button.append(image);
    thumbs.set(name, button);
    void deps.photo(name).catch(() => undefined).then((src) => {
      if (thumbs.get(name) !== button) return;
      if (!src) {
        thumbs.delete(name);
        return button.replaceWith(photoChip());
      }
      image.src = src;
      button.addEventListener("click", () => viewPhoto(src));
    });
    return button;
  };

  const userRow = (text: string, at: number, images: readonly string[] = []): HTMLElement => {
    const box = document.createElement("div");
    box.className = "chatUser";
    const bubble = document.createElement("div");
    bubble.className = "chatBubble";
    // The words name the pictures in order; any the words do not name follow them.
    let shown = 0;
    bubble.append(...promptParts(text).map((part) => typeof part === "string" ? part : photo(images[shown++])));
    bubble.append(...images.slice(shown).filter((name) => name !== "").map((name) => photo(name)));
    const time = document.createElement("time");
    time.dateTime = new Date(at).toISOString();
    time.textContent = formatDate(at, { hour: "2-digit", minute: "2-digit" });
    box.append(bubble, time);
    return box;
  };

  /** Why the last read had nothing, when main knows (another PC's record not found, not connected, ...). */
  let whyEmpty: Extract<SessionWorkflowResult, { ok: false }>["why"];
  const emptyNote = (): HTMLElement => {
    const box = document.createElement("div");
    box.className = "chatEmpty";
    const text = document.createElement("p");
    text.textContent = whyEmpty ? t(`chat.why.${whyEmpty}`) : t("chat.empty");
    box.append(text);
    return box;
  };

  /**
   * Under the last row: the menu on the terminal as buttons, or, waiting with no menu read, a way to the terminal.
   * Its own part, drawn again when the menu changes, not when the record does.
   */
  const askBox = document.createElement("div");
  askBox.className = "chatAsk";
  askBox.hidden = true;
  /**
   * While the AI works, under the last row: "작업 중", with the CLI's own line off the screen (liveLine), until the record
   * has a work row of its own going; from then on that row says 작업 중, and this the CLI's line only. Its own part,
   * as the card is: changed in place, its words at most once a second, never while text is being selected.
   */
  const liveBox = document.createElement("div");
  liveBox.className = "chatLive";
  liveBox.setAttribute("role", "status");
  liveBox.hidden = true;
  const liveText = document.createElement("span");
  // The CLI's counter, "(17s)": shown, not read out each second by a screen reader.
  const liveCount = document.createElement("span");
  liveCount.setAttribute("aria-hidden", "true");
  liveBox.append(liveText, liveCount);
  /** Lines sent from here and not in the record yet (settlePending), under the last row. */
  const pendingBox = document.createElement("div");
  pendingBox.className = "chatPending";
  let pending: Pending[] = [];
  let pendingIds = 0;
  const promptAts = () => events.flatMap((event) => event.kind === "prompt" ? [event.at] : []);
  const drawPending = () => {
    pending = settlePending(pending, promptAts());
    if (pending.length) list.querySelector(".chatEmpty")?.remove();
    pendingBox.replaceChildren(...pending.map((one) => {
      const box = document.createElement("div");
      box.className = one.failed ? "chatUser failed" : one.typed ? "chatUser typed" : "chatUser sending";
      const bubble = document.createElement("div");
      bubble.className = "chatBubble";
      bubble.textContent = one.text;
      const state = document.createElement("span");
      state.className = "chatSendState";
      if (one.failed) {
        const again = document.createElement("button");
        again.type = "button";
        again.textContent = t("chat.resend");
        again.addEventListener("click", () => {
          if (!deps.canType()) return tell(t("chat.cannotType"));
          pending = pending.filter((other) => other !== one);
          if (!sendLine(one.text)) {
            pending.push(one);
            tell(t("chat.answerFirst"));
          }
          drawPending();
        });
        state.append(t("chat.sendFailed"), " · ", again);
      } else if (one.typed) {
        // Sending it again would type it twice into the same prompt.
        state.textContent = t("chat.typedNotSent");
      } else {
        state.setAttribute("role", "status");
        state.textContent = t("chat.sending");
        if (one.queued) {
          const back = iconButton("chatTakeBack", t("chat.cancelSend"), "x");
          back.addEventListener("click", () => takeBack([one]));
          state.append(back);
        }
      }
      box.append(bubble, state);
      return box;
    }));
    syncButton();
    place();
  };
  const addPending = (text: string, queued = false): number => {
    const id = ++pendingIds;
    pending.push({ id, text, after: promptAts().reduce((last, at) => Math.max(last, at), -Infinity), ...(queued ? { queued: true as const } : {}) });
    stuck = true;
    drawPending();
    return id;
  };
  /** Lines not typed yet, taken back: never typed, and their words back in the composer to edit, after any there. */
  const takeBack = (ones: readonly Pending[]) => {
    const back = ones.filter((one) => one.queued);
    for (const one of back) takenBack.add(one.id);
    pending = pending.filter((one) => !back.includes(one));
    input.value = [input.value, ...back.map((one) => one.text)].filter((text) => text !== "").join("\n");
    drawPending();
    input.focus();
  };
  /**
   * The stop pressed (its key typed) and not yet seen to end the work, and seen to: 멈췄어요 at the end while the
   * record marks no row (stoppedEnd). One stop at a time: a second Esc on a prompt at rest opens the CLI's rewind.
   */
  let stopAsked = false;
  let stopOver = false;
  let stopAt = -Infinity;
  let cutBefore = new Set<string>();
  const stopBox = document.createElement("p");
  stopBox.className = "chatStopped";
  stopBox.setAttribute("role", "status");
  stopBox.textContent = t("chat.stopped");
  stopBox.hidden = true;
  const syncStopped = () => {
    const hidden = !stoppedEnd(chatRows(events), stopOver, cutBefore);
    if (stopBox.hidden === hidden) return;
    stopBox.hidden = hidden;
    place();
  };
  const stopTurn = () => {
    // One at a time: while one's Esc is on its way or unanswered, a second would land on a prompt at rest.
    if (stopAsked || Date.now() - stopAt < 1500) return;
    stopAt = Date.now();
    cutBefore = cutRows(chatRows(events));
    void deps.stop().catch(() => "notSent" as const).then((how) => {
      if (how !== "stopped") stopAt = -Infinity;
      stopAsked = how === "stopped";
      // Its working line gone by the press (the turn ended meanwhile): nothing typed, nothing to say.
      tell(how === "stopped" || how === "idle" ? "" : t(how === "asking" ? "chat.stopAsking" : "chat.stopFailed"));
      liveAt = 0;
      syncLive();
    });
  };
  const press = () => {
    syncButton();
    if (buttonDoes === "send") return submit();
    if (buttonDoes === "cancel") return takeBack(pending);
    stopTurn();
  };
  const markFailed = (id: number, typed = false) => {
    const one = pending.find((other) => other.id === id);
    if (!one) return;
    if (typed) one.typed = true;
    else one.failed = true;
    drawPending();
  };
  list.append(pendingBox, stopBox, liveBox, askBox);
  /** The record's last row is a work row not cut short: drawn as 작업 중 while the AI works. */
  let recordAtWork = false;
  let liveAt = 0;
  let liveLater: ReturnType<typeof setTimeout> | undefined;
  /** Asked again too soon, or over a selection: once more later, so the last word (work over) is not lost. */
  const liveAgain = (ms: number) => {
    liveLater ??= setTimeout(() => {
      liveLater = undefined;
      syncLive();
    }, ms);
  };
  const syncLive = () => {
    if (selecting()) return liveAgain(1000);
    const mood = deps.mood();
    // A question on screen is the card's: nothing is at work while it waits.
    const asking = mood === "waiting" || deps.ask() !== undefined;
    const now = Date.now();
    if (!asking && now - liveAt < 1000) return liveAgain(1000 - (now - liveAt));
    liveAt = now;
    const line = asking ? undefined : liveLine(deps.screen());
    // The CLI's line shows the work before the lamp turns (it waits for output to keep coming).
    // After a stop, the CLI's own line is what says the work ended or began again: the lamp stays lit a few seconds
    // past the last output, and a second Esc on a prompt at rest is the CLI's rewind, not a stop.
    const working = !asking && (line !== undefined || (mood === "working" && !stopAsked && !stopOver));
    workLine = line;
    const next = stopState({ asked: stopAsked, over: stopOver, at: stopAt }, line !== undefined, now);
    stopAsked = next.asked;
    stopOver = next.over;
    if (next.ended) {
      // The stop ended the work: lines sent before it and not in the record are gone with its turn (the record drops
      // a prompt stopped before its first word); 멈췄어요 says where it stopped.
      pending = pending.filter((one) => one.failed || one.typed || one.queued);
      drawPending();
    }
    if (next.failed) tell(t("chat.stopFailed"));
    syncStopped();
    syncButton();
    const text = !working ? "" : recordAtWork ? line ?? "" : line ? t("chat.workingLine", { line }) : t("chat.workingBare");
    const [, words = text, count = ""] = /^(.*?)(\s*\([^()]*\))?$/.exec(text) ?? [];
    if (liveText.textContent !== words) liveText.textContent = words;
    if (liveCount.textContent !== count) liveCount.textContent = count;
    if (liveBox.hidden !== (text === "")) {
      liveBox.hidden = text === "";
      place();
    }
  };
  let asked = "";
  /** A card's keys are on their way: it takes no other press until they are done (a digit would land in the prompt). */
  let busy = false;
  /** Not `disabled`: a disabled control drops the keyboard to the page. */
  const lock = (on: boolean, look: "sent" | "settling" = "sent") => {
    askBox.classList.toggle(look, on);
    for (const control of askBox.querySelectorAll("button, input")) {
      if (on) control.setAttribute("aria-disabled", "true");
      else control.removeAttribute("aria-disabled");
    }
  };
  /** Words being written for a free-text row (bound to its question and number, not its label, which the words replace), or for a raw card. */
  let draft: { question?: string; n: number; text: string } | undefined;
  let rawText = "";
  /** The card on show (none once its card went past CARD_GONE_MS), and since when its question has been (newQuestion). */
  let shownCard: ChatCard | undefined;
  let shownAt = 0;
  let settleLater: ReturnType<typeof setTimeout> | undefined;
  const settling = () => Date.now() - shownAt < CARD_SETTLE_MS;
  /** Another question on show, or rows moved under the pointer: no press for CARD_SETTLE_MS, and the card looks it. */
  const settle = () => {
    shownAt = Date.now();
    if (!busy) lock(true, "settling");
    clearTimeout(settleLater);
    settleLater = setTimeout(() => {
      askBox.classList.remove("settling");
      if (!busy) lock(false);
    }, CARD_SETTLE_MS);
  };
  /** Since when the screen has shown no card while one is on show, and the look again after CARD_GONE_MS. */
  let goneSince: number | undefined;
  let goneLater: ReturnType<typeof setTimeout> | undefined;
  const act = (card: ChatCard, action: CardAction, done?: () => void) => {
    if (busy || settling()) return;
    busy = true;
    lock(true);
    tell("");
    void deps.answer(card, action).catch(() => "stuck" as const).then((result) => {
      busy = false;
      lock(false);
      if (settling()) lock(true, "settling");
      if (result === "ok") done?.();
      else tell(t(cardNotes[result]));
    });
  };
  const piece = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] => {
    const element = document.createElement(tag);
    element.className = className;
    if (text !== undefined) element.textContent = text;
    if (element instanceof HTMLButtonElement) element.type = "button";
    return element;
  };
  /** A line for words and its send button: Enter sends (not while an IME composes), Esc lets go. */
  const wordsField = (label: string, value: string, typed: (text: string) => void, send: (text: string) => void, close?: () => void): HTMLElement => {
    const row = piece("div", "chatAskFree");
    const field = piece("input", "");
    field.type = "text";
    field.value = value;
    field.placeholder = label;
    field.setAttribute("aria-label", label);
    field.maxLength = 2000;
    // The composer's own send button (arrow up), not a word button beside it.
    const go = iconButton("chatSend", t("chat.send"), "arrowUp");
    const sendIt = () => {
      const text = field.value.trim();
      if (text !== "" && !busy) send(text);
    };
    field.addEventListener("input", () => typed(field.value));
    field.addEventListener("keydown", (event) => {
      if (composerKey(event) === "send") {
        event.preventDefault();
        sendIt();
      } else if (event.key === "Escape" && close) {
        event.preventDefault();
        event.stopPropagation();
        close();
      }
    });
    go.addEventListener("click", sendIt);
    row.append(field, go);
    return row;
  };
  const keyWords = (name: string): string => name === "up" ? "↑" : name === "down" ? "↓" : name === "enter" ? "Enter" : name === "esc" ? "Esc" : name === "tab" ? "Tab" : name;
  /** Under the card's question: the call it is about, from the record, as the record catches up with the screen. */
  const askCode = document.createElement("code");
  askCode.className = "chatAskCode";
  const syncAskCode = () => {
    const step = deps.ask()?.kind === "menu" ? askedStep(chatRows(events), deps.screen()) : undefined;
    const target = step?.command ?? step?.target;
    askCode.textContent = target ?? "";
    askCode.hidden = !target;
  };
  /** The card's parts for `card`, drawn again as a free-text row opens or closes. */
  const drawCard = (card: ChatCard) => {
    const parts: HTMLElement[] = [];
    if (card.tabs) {
      const tabs = piece("div", "chatAskTabs");
      tabs.setAttribute("role", "tablist");
      tabs.setAttribute("aria-label", t("chat.ask.questions"));
      card.tabs.forEach((tab, i) => {
        const button = piece("button", "chatAskTab", `${tab.done ? "✓ " : ""}${tab.label}`);
        button.setAttribute("role", "tab");
        button.setAttribute("aria-selected", String(card.tab === i));
        button.tabIndex = card.tab === i || (card.tab === undefined && i === 0) ? 0 : -1;
        button.addEventListener("click", () => {
          if (card.tab !== undefined && card.tab !== i) act(card, { do: "tab", to: i });
        });
        tabs.append(button);
      });
      parts.push(tabs);
    }
    const question = piece("p", "chatAskQuestion", card.review ? t("chat.ask.review") : card.question ?? (card.kind === "raw" ? t("chat.ask.unread") : t("chat.asks")));
    // The review's title takes the keyboard as it comes (cardFocus).
    if (card.review) question.tabIndex = -1;
    parts.push(question);
    if (card.kind === "menu") parts.push(askCode);
    if (card.lines?.length) parts.push(piece("pre", "chatAskLines", card.lines.join("\n")));
    const ticked = new Set(card.options.filter((option) => option.checked).map((option) => option.n));
    // Claude's "Chat about this" is no answer: it ends the whole set. Its own button, at the foot, never among the rows.
    const chat = card.options.find((option) => option.chat);
    const rows = card.options.filter((option) => !option.chat);
    if (rows.length > 0) {
      const options = piece("div", "chatAskOptions");
      options.setAttribute("role", "group");
      options.setAttribute("aria-label", question.textContent ?? "");
      for (const option of rows) {
        const button = piece("button", "listRow chatAskOption");
        const box = card.multi !== undefined && option.checked !== undefined && !option.freeText;
        const mark = piece("span", "chatAskKey");
        mark.setAttribute("aria-hidden", "true");
        const tick = (on: boolean) => {
          mark.classList.toggle("checked", on);
          mark.textContent = on ? "✓" : option.typed ?? String(option.n);
          if (box) button.setAttribute("aria-checked", String(on));
        };
        if (box) button.setAttribute("role", "checkbox");
        tick(ticked.has(option.n));
        const words = piece("span", "chatAskWords");
        words.append(piece("span", "", option.typed ? t(option.typed === "y" ? "chat.ask.yes" : "chat.ask.no") : card.review ? t(option.n === 1 ? "chat.ask.submit" : "common.cancel") : option.label));
        if (option.detail && option.detail !== option.label) words.append(piece("span", "sub", option.detail));
        button.append(mark, words);
        // Open only on the question it was written for (a moment with no card keeps it, but not for another question).
        const open = draft?.n === option.n && draft.question === card.question;
        if (open) button.setAttribute("aria-expanded", "true");
        button.addEventListener("click", () => {
          if (busy) return;
          // Its words are written here, then typed into the CLI's own field (answerCard "write").
          if (option.freeText) {
            draft = open ? undefined : { ...(card.question === undefined ? {} : { question: card.question }), n: option.n, text: "" };
            drawCard(card);
            (askBox.querySelector<HTMLElement>(".chatAskFree input") ?? button).focus();
            return;
          }
          // Ticked here; Submit presses the boxes that differ from the screen's, then goes on.
          if (box) {
            if (ticked.has(option.n)) ticked.delete(option.n);
            else ticked.add(option.n);
            return tick(ticked.has(option.n));
          }
          act(card, { do: "pick", n: option.n });
        });
        options.append(button);
        if (open && draft) {
          const at = option.n;
          options.append(wordsField(t("chat.ask.yours"), draft.text, (text) => {
            if (draft) draft.text = text;
          }, (text) => act(card, { do: "write", n: at, text }, () => {
            // The field folds away and the rows under it move up (a multi-select's question stays): a moment's wait.
            draft = undefined;
            settle();
            const now = deps.ask();
            if (now) drawCard(now);
          }), () => {
            draft = undefined;
            drawCard(card);
            button.focus();
          }));
        }
      }
      parts.push(options);
    }
    if (card.multi) {
      const submit = piece("button", "go chatAskSubmit", t(card.tabs ? "chat.ask.next" : "chat.ask.submit"));
      submit.addEventListener("click", () => act(card, { do: "ticks", ticked: [...ticked] }));
      parts.push(submit);
    }
    if (chat) {
      const away = piece("button", "chatAskAway", t("chat.ask.chat"));
      away.title = t("chat.ask.chatHint");
      away.addEventListener("click", () => act(card, { do: "pick", n: chat.n }));
      parts.push(away);
    }
    if (card.kind === "raw") {
      const keys = piece("div", "chatAskKeys");
      keys.setAttribute("role", "group");
      keys.setAttribute("aria-label", t("chat.ask.keys"));
      for (const name of card.keys ?? []) {
        const said = name === "up" ? t("chat.key.up") : name === "down" ? t("chat.key.down") : keyWords(name);
        const button = piece("button", "chatAskKeyButton", keyWords(name));
        button.setAttribute("aria-label", t("chat.key.press", { key: said }));
        button.title = t("chat.key.press", { key: said });
        button.addEventListener("click", () => act(card, { do: "key", name }));
        keys.append(button);
      }
      parts.push(keys, wordsField(t("chat.ask.typeHere"), rawText, (text) => {
        rawText = text;
      }, (text) => act(card, { do: "line", text }, () => {
        rawText = "";
      })));
      const away = piece("button", "chatAskAway", t("chat.showTerminal"));
      away.addEventListener("click", () => deps.toTerminal());
      parts.push(away);
    }
    const had = askBox.contains(document.activeElement);
    askBox.replaceChildren(...parts);
    if (busy) lock(true);
    else if (settling()) lock(true, "settling");
    // Taller with a free-text row open: a list kept at the bottom stays there.
    place();
    // Never a tab (an Enter there would step back to the question before), nor the review's 제출.
    if (had) {
      const words = askBox.querySelector<HTMLElement>(".chatAskFree input");
      const target = { words, title: question, row: askBox.querySelector<HTMLElement>(".chatAskOption"), button: askBox.querySelector<HTMLElement>("button") }[cardFocus(card, words !== null)];
      (target ?? list).focus({ preventScroll: true });
    }
  };
  // ←/→ on the card move between a question set's questions, as the CLI's own keys do.
  askBox.addEventListener("keydown", (event) => {
    const card = deps.ask();
    if (!card?.tabs || (event.key !== "ArrowLeft" && event.key !== "ArrowRight") || event.target instanceof HTMLInputElement) return;
    event.preventDefault();
    const forward = event.key === "ArrowRight";
    if (card.tab === undefined) act(card, { do: "key", name: forward ? "tab" : card.back ?? "left" });
    else if (forward ? card.tab < card.tabs.length - 1 : card.tab > 0) act(card, { do: "tab", to: card.tab + (forward ? 1 : -1) });
  });
  const syncAsk = () => {
    // As the session comes and goes, and its AI with it: asked as often as the card is.
    syncInput();
    syncChip();
    syncLive();
    const ask = deps.ask();
    const state = ask ? `card:${ask.id}` : deps.mood() === "waiting" ? "terminal" : "";
    if (ask) goneSince = undefined;
    if (state === asked) return;
    // A card's screen being redrawn shows none for a moment (Ink erases, then draws): the card stays that long, so
    // nothing else (the terminal's button) comes up under the pointer. Pressed meanwhile, it types nothing (answerCard).
    if (!ask && asked.startsWith("card:")) {
      goneSince ??= Date.now();
      if (Date.now() - goneSince < CARD_GONE_MS) {
        clearTimeout(goneLater);
        goneLater = setTimeout(syncAsk, CARD_GONE_MS);
        return;
      }
    }
    goneSince = undefined;
    asked = state;
    // A card back after none (gone past the wait) is a new question too: its rows came up where something else was.
    const fresh = ask !== undefined && newQuestion(shownCard, ask);
    shownCard = ask;
    if (cardNoteStale(note.textContent ?? "", ask !== undefined)) tell("");
    // Words written for another question are not this one's (a moment with no card on the screen is no other question:
    // they stay, and the rows under them do not move up); a raw card's stay while the screen shows one.
    if (draft && ask && ask.question !== draft.question) draft = undefined;
    if (ask?.kind !== "raw") rawText = "";
    const had = askBox.contains(document.activeElement);
    askBox.hidden = state === "";
    if (fresh) settle();
    if (ask) {
      drawCard(ask);
      syncAskCode();
    } else if (state === "terminal") {
      const note = document.createElement("p");
      note.className = "chatAskQuestion";
      note.textContent = t("chat.answerInTerminal");
      const back = document.createElement("button");
      back.type = "button";
      back.textContent = t("chat.showTerminal");
      back.addEventListener("click", () => deps.toTerminal());
      askBox.replaceChildren(note, back);
    } else {
      askBox.replaceChildren();
    }
    place();
    // A card puts the keyboard back itself (drawCard).
    if (had && !ask) (askBox.querySelector("button") ?? list).focus({ preventScroll: true });
  };

  const draw = (running: boolean) => {
    live = undefined;
    liveSubs = [];
    // The keyboard was in the list: after the rebuild it goes back to the same row's button, or else to the list.
    const had = document.activeElement instanceof HTMLElement && list.contains(document.activeElement) ? document.activeElement : undefined;
    const where = had?.closest<HTMLElement>("[data-row]")?.dataset.row;
    const part = had?.matches(".chatCopy") ? ".chatCopy" : had?.matches(".chatWorkHead") ? ".chatWorkHead" : had?.matches(".chatThumb") ? ".chatThumb" : undefined;
    const rows = chatRows(events);
    // Older rows put in front (loadOlder) push the rest down: what was in view stays there.
    const first = rows[0] && `${rows[0].kind}:${rows[0].at}`;
    const keep = !stuck && shown() && drawnFirst !== undefined && first !== drawnFirst ? list.scrollHeight - list.scrollTop : undefined;
    drawnFirst = first;
    list.replaceChildren(...rows.map((row, index) => {
      const box = row.kind === "user" ? userRow(row.text, row.at, row.images)
        : row.kind === "agent" ? answerRow(row.text, row.cancelled)
          : row.kind === "sub" ? subRow(row, subState(rows, index, running))
            : workRow(row, running && index === rows.length - 1);
      box.dataset.row = `${row.kind}:${row.at}`;
      return box;
    }));
    if (rows.length === 0 && pending.length === 0) list.append(emptyNote());
    // Moved, not rebuilt: a key on one of its buttons is put back on the same one.
    list.append(pendingBox, stopBox, liveBox, askBox);
    drawPending();
    syncStopped();
    syncSubs(rows, running);
    if (keep === undefined) place();
    else top = list.scrollTop = list.scrollHeight - keep;
    if (had) (askBox.contains(had) ? had : where && part ? list.querySelector<HTMLElement>(`[data-row="${where}"] ${part}`) ?? list : list).focus({ preventScroll: true });
  };

  return {
    element,
    async refresh() {
      // Before the read, and whether or not one is on its way: a question shows as it comes.
      syncAsk();
      if (reading) {
        readAgain = true;
        return;
      }
      reading = true;
      // The AI this read is for: the session may be opened again with another while it is on its way.
      const kind = deps.agent();
      try {
        const result = await deps.read();
        if (result.ok) events = mergeEvents(events, result.workflow.events);
        whyEmpty = result.ok ? undefined : result.why;
        const last = chatRows(events).at(-1);
        recordAtWork = last?.kind === "work" && !last.cancelled;
        // The record caught up (or fell behind): the live line says so now, not a second on.
        liveAt = 0;
        syncLive();
        // Moving to another AI: "Codex · 켜는 중…" until its record is read.
        const model = result.ok ? result.workflow.model : result.why === "starting" ? t("chat.starting") : undefined;
        modelRead = kind === undefined ? undefined : { kind, ...(model === undefined ? {} : { model }) };
        syncChip();
        syncAskCode();
        const running = runningNow();
        const read = JSON.stringify([events, running, whyEmpty]);
        if (read !== drawn && !selecting()) {
          drawn = read;
          draw(running);
        } else {
          if (live) live.label.textContent = workWords(live.row, true);
          for (const sub of liveSubs) sub.label.textContent = subWords(sub.row, "running");
          syncSubs(chatRows(events), running);
        }
      } catch {
        // Unreadable for now (the PC went away mid-read): the view keeps what it had, the chip the AI's name only.
        modelRead = undefined;
        syncChip();
      } finally {
        reading = false;
        if (readAgain) {
          readAgain = false;
          void this.refresh();
        }
      }
    },
    pending: addPending,
    failed: markFailed,
    showAsk: syncAsk,
    notice(text, retry) {
      tell(text);
      const again = document.createElement("button");
      again.type = "button";
      again.className = "chatNoteRetry";
      again.textContent = t("chat.retry");
      again.addEventListener("click", () => {
        tell("");
        retry();
      });
      note.append(" · ", again);
    },
    focus: () => focusChat(element, list, document.activeElement),
    dispose() {
      resized.disconnect();
      thumbs.clear();
      clearTimeout(liveLater);
      clearTimeout(goneLater);
      clearTimeout(settleLater);
      viewer?.remove();
    },
  };
}

import type { PhoneSubagent, PhoneSummary, SessionWorkflow, WorkflowItem } from "../../shared/ipc.ts";

/*
 * What a session is about, read off its record mechanically: no model call,
 * nothing to pay for (spec 2026-10-31 section 11). Pure, so the phone can
 * take it later as it is.
 *
 * Everything about progress is the current turn: from the last thing the
 * human asked to now. A subagent left without a result in an older turn was
 * interrupted, and must not read as still running.
 */

export type StepKind = "prompt" | "action" | "subagent";
export const MAX_STEPS = 5;

/** A session's last few workflow steps, oldest first: the phone's step chain. */
export function stepsOf(events: ReadonlyArray<{ kind: string }>): StepKind[] {
  const steps: StepKind[] = [];
  for (let i = events.length - 1; i >= 0 && steps.length < MAX_STEPS; i--) {
    const kind = events[i]!.kind;
    if (kind === "prompt" || kind === "action" || kind === "subagent") steps.unshift(kind);
  }
  return steps;
}

export interface Progress {
  /** When the turn began (the last prompt), and its newest step. */
  start?: number;
  last?: number;
  /** Files written or edited, by name, first touched first. */
  edited: string[];
  reads: number;
  commands: number;
  subagents: number;
  running: number;
}

export interface Summary {
  title?: string;
  /** The last thing the human asked, whole. */
  goal?: string;
  /** The newest step, one line. */
  now?: { at: number; kind: WorkflowItem["kind"]; text: string };
  /** What the turn ended on: the agent's note, first sentence or two. None while work follows it or a subagent is still out. */
  result?: string;
  progress: Progress;
}

/** User-perceived characters: a cut never splits a surrogate pair or a decomposed (NFD) Hangul syllable. */
const graphemes = new Intl.Segmenter();
export const chars = (text: string): string[] => Array.from(graphemes.segment(text), (part) => part.segment);

/** The first non-empty line, whitespace collapsed, cut to `max` characters with an ellipsis. */
export function oneLine(text: string | undefined, max: number): string {
  const line = (text ?? "").split("\n").map((part) => part.replace(/\s+/g, " ").trim()).find((part) => part !== "") ?? "";
  const all = chars(line);
  return all.length <= max ? line : all.slice(0, max - 1).join("").trimEnd() + "…";
}

/** A run with no space this long (a URL, a hash, a path) is cut: it would not wrap. */
const LONG = 40;
const shorten = (token: string) => (chars(token).length > LONG ? chars(token).slice(0, LONG - 1).join("") + "…" : token);

const hasWords = (text: string) => /[\p{L}\p{N}]/u.test(text);
const leadsIn = (text: string) => /[:：]$/.test(text);

/**
 * A note's lines with the Markdown marks off, each its own thought. Code blocks
 * go whole, closed or cut off. Headings, tables and a "[Notice: ...]" line only frame what is said:
 * they stay out while the note has a line of its own to give, and then a
 * table gives its first row after the header, its cells apart.
 */
function plainLines(text: string): string[] {
  const prose: string[] = [];
  const heads: string[] = [];
  const rows: string[] = [];
  const body = text.replace(/^[ \t]*(```|~~~)[^]*?(?:^[ \t]*\1[ \t]*$|(?![^]))/gm, "").replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1");
  for (const raw of body.split("\n")) {
    const line = raw.replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s*)/, "").replace(/\*\*|__|`/g, "").replace(/\S+/g, shorten).trim();
    if (!hasWords(line)) continue; // Empty, a rule, a table's separator.
    if (/^\s*\|/.test(raw)) rows.push(line.split("|").map((cell) => cell.trim()).filter(hasWords).join(" · "));
    else if (/^\s*#{1,6}\s/.test(raw) || /^\[[A-Za-z]+: .*\]$/.test(line) || (/^\s*(\*\*|__).*\1\s*$/.test(raw) && !/[.!?。！？]$/.test(line))) heads.push(line);
    else prose.push(line);
  }
  if (prose.some((line) => !leadsIn(line) || /[.!?。！？]\s/.test(line))) return prose;
  const row = rows[1] ?? rows[0];
  return [...prose, ...(row === undefined ? heads : [row])];
}

/**
 * The first `n` sentences. A full stop only ends one when a space or the end
 * follows, so "paint.ts" stays whole; Korean, English and CJK stops all count.
 * So does a line's end: what has no stop of its own is set apart with " · ",
 * and "다음과 같습니다:" runs into what it leads to, or goes when nothing does.
 * A sentence that would not fit is left out rather than cut, unless it is the first.
 */
export function sentences(text: string | undefined, n: number, max = 200): string {
  const parts = plainLines(text ?? "").flatMap((line) => line.split(/(?<=[.!?])\s+|(?<=[。！？])\s*|\s+·\s+/)).filter((part) => part !== "");
  // Clipped when the record was read: a whole sentence loses the mark, half of one goes if anything whole came before.
  const end = parts.at(-1);
  if (end?.endsWith("…")) {
    if (/[.!?。！？]…$/.test(end)) parts[parts.length - 1] = end.slice(0, -1);
    else if (parts.length > 1) parts.pop();
  }
  let out = "";
  let whole = "";
  let count = 0;
  for (const part of parts) {
    const next = out === "" ? part : out + (/[。！？]$/.test(out) ? "" : /[.!?:：]$/.test(out) ? " " : " · ") + part;
    if (out !== "" && chars(next).length > max) break;
    out = next;
    if (leadsIn(part)) continue;
    whole = out;
    if (++count === n) break;
  }
  const all = chars(whole || out);
  return all.length <= max ? whole || out : all.slice(0, max - 1).join("").trimEnd() + "…";
}

/** Wrappers around pasted or injected text, closed or cut off on the line they open: a tag name has a "-" or "_", so HTML in a goal stays. */
const WRAPPER = /<([a-z]+[-_][\w-]*)(?:\s[^>]*)?>[^]*?<\/\1(?:\s[^>]*)?>|^[ \t]*<[a-z]+[-_][\w-]*(?:\s[^>]*)?>[^]*$/gm;

/** A goal in the operator's own words. Nothing but a paste: the paste, without its tag. */
function goalOf(text: string): string {
  return text.replace(WRAPPER, "").replace(/\[Image #\d+\]\s*/g, "").trim() || text.replace(/<\/?[a-z]+[-_][\w-]*(?:\s[^>]*)?>/g, "").trim();
}

/** Whether a goal needs a "show more": over three lines, or long enough to wrap past them. */
export const goalIsLong = (goal: string): boolean => goal.split("\n").filter((line) => line.trim() !== "").length > 3 || chars(goal).length > 140;

/** The current turn: from the last prompt on, or everything when there is none. */
function turnOf(events: readonly WorkflowItem[]): readonly WorkflowItem[] {
  for (let i = events.length - 1; i >= 0; i--) if (events[i]!.kind === "prompt") return events.slice(i);
  return events;
}

const fileOf = (label: string) => /^(?:Edit|Write|NotebookEdit) (.+)$/.exec(label)?.[1];

export function summarize(workflow: SessionWorkflow | undefined): Summary {
  const progress: Progress = { edited: [], reads: 0, commands: 0, subagents: 0, running: 0 };
  const events = workflow?.events ?? [];
  const summary: Summary = { ...(workflow?.title ? { title: workflow.title } : {}), progress };
  if (events.length === 0) return summary;

  const turn = turnOf(events);
  const prompt = turn[0]?.kind === "prompt" ? turn[0] : undefined;
  if (prompt) summary.goal = goalOf(prompt.text);

  const last = events.at(-1)!;
  summary.now = { at: last.at, kind: last.kind, text: last.kind === "note" ? sentences(last.text, 2, 120) || oneLine(last.text, 120) : oneLine(last.kind === "subagent" ? last.description : last.text, 120) };

  if (turn[0]!.at) progress.start = turn[0]!.at;
  if (last.at) progress.last = last.at;
  for (const event of turn) {
    if (event.kind === "subagent") {
      progress.subagents++;
      if (event.result === undefined) progress.running++;
    }
    if (event.kind !== "action") continue;
    for (const label of event.labels ?? []) {
      const file = fileOf(label);
      if (file !== undefined && !progress.edited.includes(file)) progress.edited.push(file);
      else if (label.startsWith("Read ")) progress.reads++;
      else if (/^(?:Bash|Shell)(?: · |$)/.test(label)) progress.commands++;
    }
  }
  // A note the operator stopped the turn on is no outcome, and one that was only code has no words to give.
  const result = last.kind === "note" && !last.cancelled && progress.running === 0 ? sentences(last.text, 2) : "";
  if (result) summary.result = result;
  return summary;
}

/** A path's last part: "src/cart.ts" -> "cart.ts". */
const base = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? "";
/** Only a real path: two separators and not a date, or one with a file extension ("src/cart.ts"); never "and/or", "24/7", "TCP/IP". */
const isPath = (token: string) => {
  const seps = token.split(/[\\/]/).length - 1;
  return (seps >= 2 && /[^\d\\/]/.test(token)) || (seps === 1 && /\.[A-Za-z0-9]{1,8}$/.test(token));
};
/**
 * Every path in a text cut to its base name: "Edit src/cart.ts" -> "Edit cart.ts".
 * A drive or UNC path may hold spaces ("C:\Users\Jane Doe\proj" -> "proj"),
 * and so may a quoted rooted one; elsewhere a space ends a path.
 */
export const unpath = (text: string) =>
  text
    .replace(/(['"`])((?:[A-Za-z]:[\\/]|\\\\|~?\/)[^'"`\n]*)\1/g, (all, q: string, path: string) => (path.includes(" ") ? q + base(path) + q : all))
    .replace(/(?:\b[A-Za-z]:[\\/]|\\\\)(?:[^\s\\/'"`]+(?: [^\s\\/'"`]+)?[\\/])*/g, "")
    .replace(/[^\s'"`()<>[\]{},;]*[\\/][^\s'"`()<>[\]{},;]*/g, (token) => {
      const core = token.replace(/[.:!?]+$/, "");
      return isPath(core) ? base(core) + token.slice(core.length) : token;
    });

/**
 * Conversation text with what must not leave the PC put as "…": all after
 * "Bearer ", URLs (host and all), e-mail and user@host, IPv4 and IPv6
 * addresses, KEY=value and token: value secrets, long hex or base64 runs.
 */
export const scrub = (text: string) =>
  text
    .replace(/\bBearer\s+[^\n]*/gi, "Bearer …")
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S*|\bwww\.\S+/gi, "…")
    .replace(/[^\s@'"`()<>[\]]+@[^\s@'"`()<>[\]]+/g, "…")
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, "…")
    .replace(/(?<![\w:])(?:(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}|(?=[0-9a-f:]*[0-9a-f])(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4})*)?::(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4})*)?)(?![\w:])/gi, "…")
    .replace(/\b([\w.-]*(?:token|secret|passw(?:or)?d|pwd|api[_-]?key|auth\w*|credentials?|cookie|session[_-]?id)\s*[:=]\s*)(["']?)[^\s"']+\2/gi, "$1…")
    .replace(/\b([A-Za-z_][\w.-]*=)(["']?)[^\s"']+\2/g, "$1…")
    .replace(/\b[0-9a-fA-F]{24,}\b/g, "…")
    // A key mixes digits and letters, and cases unless it is one unbroken run; a kebab or snake name ("2026-10-31-pane-tabs") does not.
    .replace(/[A-Za-z0-9+_-]{24,}={0,2}/g, (run) => (/\d/.test(run) && /[a-z]/i.test(run) && ((/[a-z]/.test(run) && /[A-Z]/.test(run)) || !/[-_]/.test(run)) ? "…" : run));
/** Conversation text as it may leave the PC: scrubbed, then paths cut to base names. */
const safe = (text: string) => unpath(scrub(text));
/** A tool label as it may leave the PC: a file tool keeps the file's base name, any other tool only its name ("Bash · curl …" -> "Bash"). */
const toolOnly = (label: string) => {
  const file = /^(Edit|Write|NotebookEdit|Read) (.+)$/.exec(label);
  return file ? `${file[1]} ${base(file[2]!)}` : label.split(/[\s·]/)[0]!;
};
/** At most `max` characters, lines kept. */
const capped = (text: string, max: number) => { const all = chars(text); return all.length <= max ? text : all.slice(0, max - 1).join("").trimEnd() + "…"; };
/** Text as it may leave the PC, still something to read: a run of "…" is one, and only "…" is nothing. */
const told = (text: string, max: number) => { const out = capped(safe(text).replace(/…(?:[\s,]*…)+/g, "…"), max); return hasWords(out) ? out : ""; };

const agentLabel = (description: string) => oneLine(safe(description), 80);

/**
 * What the phone gets for a session (its map and sheet), and nothing more
 * (the PC's own map keeps the full text). Conversation text -- goal 200,
 * result 200 characters, subagent labels 80 -- is scrubbed and its paths
 * cut to base names. The newest step is never free text: an action is its
 * tools' names, a file tool with the file's base name ("Edit cart.ts ·
 * Bash"); a subagent step is its label; a note is the note, scrubbed.
 * After a prompt there is no step yet. Three edited file names of 80, the
 * current turn's subagents, running first, eight at most, each with when it
 * was sent and the first sentence it came back with (80, scrubbed). Nothing when
 * there is no record.
 */
export function forPhone(workflow: SessionWorkflow | undefined): { summary?: PhoneSummary; subagents?: PhoneSubagent[] } {
  const events = workflow?.events ?? [];
  if (events.length === 0) return {};
  const sum = summarize(workflow);
  const p = sum.progress;
  const last = events.at(-1)!;
  const said = last.kind === "note" ? oneLine(told(sum.now!.text, 120), 120) : "";
  const now: PhoneSummary["now"] =
    last.kind === "action" ? { at: last.at, kind: "action", text: oneLine([...new Set((last.labels ?? []).map(toolOnly))].join(" · "), 120) }
    : last.kind === "subagent" ? { at: last.at, kind: "agent", text: agentLabel(last.description) }
    : said ? { at: last.at, kind: "note", text: said }
    : undefined;
  const goal = told(sum.goal ?? "", 200);
  const result = told(sum.result ?? "", 200);
  const summary: PhoneSummary = {
    ...(goal ? { goal } : {}),
    ...(now ? { now } : {}),
    ...(result ? { result } : {}),
    progress: {
      files: p.edited.length, fileNames: p.edited.slice(0, 3).map((file) => oneLine(base(file), 80)),
      reads: p.reads, commands: p.commands, subagents: p.subagents, running: p.running, ...(p.start === undefined ? {} : { since: p.start }),
    },
  };
  const subs = turnOf(events).filter((event): event is Extract<WorkflowItem, { kind: "subagent" }> => event.kind === "subagent");
  const subagents = [...subs.filter((s) => s.result === undefined), ...subs.filter((s) => s.result !== undefined)]
    .slice(0, 8)
    .map((s) => {
      const back = told(sentences(s.result, 1, 80), 80);
      return { label: agentLabel(s.description), running: s.result === undefined, since: s.at, ...(s.result !== undefined && s.resultAt !== undefined ? { doneAt: s.resultAt } : {}), ...(back ? { result: back } : {}) };
    });
  return { summary, ...(subagents.length ? { subagents } : {}) };
}

/** Whole minutes from `at` to `now`, never negative. */
export const minutesSince = (at: number, now: number): number => Math.max(0, Math.floor((now - at) / 60000));

const sameDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString();

export interface PcCounts { working: number; waiting: number; done: number; subagents: number }

/**
 * A PC's line under its hub. 오늘 끝: sessions resting after work whose last
 * step was today, plus subagents that came back today. 하위 에이전트: the
 * ones still running in a turn that is itself still going.
 */
export function pcCounts(sessions: ReadonlyArray<{ mood: string; workflow?: SessionWorkflow }>, now: number): PcCounts {
  const counts: PcCounts = { working: 0, waiting: 0, done: 0, subagents: 0 };
  for (const session of sessions) {
    const events = session.workflow?.events ?? [];
    if (session.mood === "working") counts.working++;
    if (session.mood === "waiting") counts.waiting++;
    const lastAt = events.at(-1)?.at;
    if ((session.mood === "done" || session.mood === "idle") && lastAt !== undefined && sameDay(lastAt, now)) counts.done++;
    counts.done += finishedToday(events, now);
    if (session.mood === "working" || session.mood === "waiting") counts.subagents += runningSubagents(session.workflow).length;
  }
  return counts;
}

/** Subagents whose result came back today. */
export function finishedToday(events: readonly WorkflowItem[], now: number): number {
  return events.filter((event) => event.kind === "subagent" && event.result !== undefined && sameDay(event.resultAt ?? event.at, now)).length;
}

/** Subagents still out in the current turn, oldest first. */
export function runningSubagents(workflow: SessionWorkflow | undefined): Array<Extract<WorkflowItem, { kind: "subagent" }>> {
  return turnOf(workflow?.events ?? []).filter((event): event is Extract<WorkflowItem, { kind: "subagent" }> => event.kind === "subagent" && event.result === undefined);
}

/** The current turn's subagents that came back, newest first. */
export function finishedSubagents(workflow: SessionWorkflow | undefined): Array<Extract<WorkflowItem, { kind: "subagent" }>> {
  return turnOf(workflow?.events ?? [])
    .filter((event): event is Extract<WorkflowItem, { kind: "subagent" }> => event.kind === "subagent" && event.result !== undefined)
    .sort((a, b) => (b.resultAt ?? b.at) - (a.resultAt ?? a.at));
}

/**
 * The words of the map's summary blocks as "{n}" templates: plain strings,
 * so the phone can hand them to its web view as they are.
 */
export interface BlockWords {
  /** "진행 중 · {t}" */
  running: string;
  under: string;
  minutes: string;
  hours: string;
  /** A subagent that came back with nothing to say. */
  done: string;
  sessions: string;
  working: string;
  waiting: string;
  doneToday: string;
}
const fill = (template: string, vars: Record<string, string | number>) => template.replace(/\{(\w+)\}/g, (whole, name: string) => (name in vars ? String(vars[name]) : whole));

/** "4분", "1시간 5분", "1분 안". */
export function elapsed(minutes: number, w: Pick<BlockWords, "under" | "minutes" | "hours">): string {
  if (minutes < 1) return w.under;
  if (minutes < 60) return fill(w.minutes, { n: minutes });
  return fill(w.hours, { h: Math.floor(minutes / 60), m: minutes % 60 });
}

/** A subagent's block: what it was asked; then how long it has been out, or the first sentence of what came back. */
export function agentBlock(a: { asked: string; running: boolean; since?: number; result?: string }, now: number, w: BlockWords): [string, string] {
  const status = a.running ? fill(w.running, { t: elapsed(minutesSince(a.since ?? now, now), w) }) : sentences(a.result, 1, 80) || w.done;
  return [oneLine(a.asked, 80), status];
}

export interface FolderCounts { sessions: number; working: number; waiting: number; done: number }
/** A folder's block: what its busiest session is doing ("" when none is), then its counts, zeros left out. */
export function folderBlock(doing: string | undefined, c: FolderCounts, w: BlockWords): [string, string] {
  const parts: Array<[string, number]> = [[w.sessions, c.sessions], [w.working, c.working], [w.waiting, c.waiting], [w.doneToday, c.done]];
  return [oneLine(doing, 80), parts.filter(([, n]) => n > 0).map(([template, n]) => fill(template, { n })).join(" · ")];
}

/** What a session is about, one line: its goal, else its newest step. */
export function doingOf(workflow: SessionWorkflow | undefined): string | undefined {
  const sum = summarize(workflow);
  return sum.goal ? oneLine(sum.goal, 80) : sum.now?.text;
}

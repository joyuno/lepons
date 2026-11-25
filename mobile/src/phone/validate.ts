import { modeLine, ruleLine } from "./status.ts";
import {
  accountStates, moods, pcStates, stepKinds,
  type AccountState, type AgentUsage, type CommandSuggestion, type PcAccounts, type PhoneBot, type PhoneState, type PhoneSubagent, type PhoneSummary, type UsageWindow, type When, type WorkflowItem,
} from "./types.ts";

/**
 * Everything the PC sends is checked here before a screen sees it: the link
 * is sealed, but a PC on another Lepons version (or a bug) must not crash the
 * app or slip a non-string into a <Text>. Anything that does not fit is
 * dropped: the whole reply when its frame is wrong, one item when only it is.
 */

type Obj = Record<string, unknown>;
const isObj = (value: unknown): value is Obj => typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown, max: number): value is string => typeof value === "string" && value.length <= max;
const num = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
/** A time Date can hold: ±8.64e15 ms. */
const time = (value: unknown): value is number => num(value) && Math.abs(value) < 8.64e15;
const optStr = (value: unknown, max: number) => value === undefined || str(value, max);
const list = <T>(value: unknown, max: number, item: (v: unknown) => T | undefined): T[] | undefined =>
  Array.isArray(value) ? value.slice(0, max).flatMap((v) => {
    const out = item(v);
    return out === undefined ? [] : [out];
  }) : undefined;

/** A bad pane is dropped, not the session: the list still shows it, outside the panes. */
const paneOf = (p: unknown): { pane?: { n: number; tab: number; shown: boolean } } =>
  isObj(p) && Number.isInteger(p.n) && (p.n as number) >= 1 && (p.n as number) <= 64 && Number.isInteger(p.tab) && (p.tab as number) >= 0 && (p.tab as number) < 500 && typeof p.shown === "boolean"
    ? { pane: { n: p.n as number, tab: p.tab as number, shown: p.shown } }
    : {};

/** Bad kinds are dropped and only the last five kept; none at all is no field. */
const stepsOf = (steps: unknown): { steps?: Array<(typeof stepKinds)[number]> } => {
  const kept = list(steps, 50, (kind) => ((stepKinds as readonly unknown[]).includes(kind) ? (kind as (typeof stepKinds)[number]) : undefined));
  return kept?.length ? { steps: kept.slice(-5) } : {};
};

/**
 * The PC caps these in user-perceived characters (goal 200, now 120,
 * result 200, labels and file names 80). One emoji can be a dozen UTF-16
 * units and Hermes may not carry Intl.Segmenter, so the check allows 16 per
 * character: anything the PC cut fits, and only a broken PC is dropped. An
 * empty string is what the PC sends for an empty label; it is kept.
 */
const capOk = (value: unknown, chars: number): value is string => str(value, chars * 16);
const nowKinds = ["action", "agent", "note"] as const;
const count = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 1_000_000;
const summaryOf = (s: unknown): { summary?: PhoneSummary } => {
  if (!isObj(s)) return {};
  const now = isObj(s.now) && time(s.now.at) && (nowKinds as readonly unknown[]).includes(s.now.kind) && capOk(s.now.text, 120)
    ? { at: s.now.at, kind: s.now.kind as (typeof nowKinds)[number], text: s.now.text }
    : undefined;
  const p = s.progress;
  const names = isObj(p) ? list(p.fileNames, 3, (name) => (capOk(name, 80) ? name : undefined)) : undefined;
  const progress = isObj(p) && names && count(p.files) && count(p.reads) && count(p.commands) && count(p.subagents) && count(p.running) &&
    p.running <= p.subagents && names.length <= p.files && (p.since === undefined || time(p.since))
    ? { files: p.files, fileNames: names, reads: p.reads, commands: p.commands, subagents: p.subagents, running: p.running, ...(p.since === undefined ? {} : { since: p.since as number }) }
    : undefined;
  const summary: PhoneSummary = {
    ...(capOk(s.goal, 200) ? { goal: s.goal } : {}),
    ...(now ? { now } : {}),
    ...(capOk(s.result, 200) ? { result: s.result } : {}),
    ...(progress ? { progress } : {}),
  };
  return Object.keys(summary).length ? { summary } : {};
};
const subagentsOf = (a: unknown): { subagents?: PhoneSubagent[] } => {
  const kept = list(a, 8, (s) =>
    isObj(s) && capOk(s.label, 80) && typeof s.running === "boolean" && (s.doneAt === undefined || time(s.doneAt)) && (s.since === undefined || time(s.since)) && (s.result === undefined || capOk(s.result, 80))
      ? { label: s.label, running: s.running, ...(s.since === undefined ? {} : { since: s.since as number }), ...(s.doneAt === undefined ? {} : { doneAt: s.doneAt as number }), ...(s.result === undefined ? {} : { result: s.result as string }) }
      : undefined);
  return kept?.length ? { subagents: kept } : {};
};

/** A worktree's original folder and task name, as the PC sends them: the task only with its folder. */
const named = (value: unknown): value is string => str(value, 500) && value !== "";
const worktreeOf = (s: Obj): { worktreeOf?: string; worktree?: string } =>
  named(s.worktreeOf) ? { worktreeOf: s.worktreeOf, ...(named(s.worktree) ? { worktree: s.worktree } : {}) } : {};
/** 자리 비움 기본 답: when the PC answers by itself, and with which option. */
const autoOf = (value: unknown): { auto?: { at: number; n: number; option: string } } =>
  isObj(value) && time(value.at) && typeof value.n === "number" && Number.isInteger(value.n) && value.n >= 1 && value.n <= 9 && str(value.option, 500)
    ? { auto: { at: value.at as number, n: value.n, option: value.option } } : {};

/** The keys a menu option may press (cockpit/src/phone/input.ts allows these). */
const askKeys = ["enter", "esc", "up", "down", "tab", "left", "backtab", "1", "2", "3", "4", "5", "6", "7", "8", "9"];
type Ask = NonNullable<PhoneState["sessions"][number]["ask"]>;
/**
 * The menu the PC read for a waiting session, all or nothing: one bad part drops the ask (the phone then reads its own
 * screen), never the session.
 */
const askOf = (a: unknown): { ask?: Ask } => {
  if (!isObj(a) || !str(a.id, 64) || !/^[0-9a-f]+$/.test(a.id) || !optStr(a.question, 300)) return {};
  if (!Array.isArray(a.options) || a.options.length === 0 || a.options.length > 9) return {};
  const options: Ask["options"] = [];
  for (const o of a.options as unknown[]) {
    if (!isObj(o) || !Number.isInteger(o.n) || (o.n as number) < 1 || (o.n as number) > 9 || !str(o.label, 120) || !optStr(o.detail, 200)) return {};
    if ((o.freeText !== undefined && o.freeText !== true) || (o.checked !== undefined && typeof o.checked !== "boolean")) return {};
    if (o.key !== undefined && o.key !== "enter" && o.key !== "esc") return {};
    if (o.keys !== undefined && !(Array.isArray(o.keys) && o.keys.length >= 1 && o.keys.length <= 10 && o.keys.every((k) => askKeys.includes(k as string)))) return {};
    options.push({
      n: o.n as number, label: o.label,
      ...(o.detail === undefined ? {} : { detail: o.detail as string }),
      ...(o.freeText ? { freeText: true as const } : {}),
      ...(o.checked === undefined ? {} : { checked: o.checked as boolean }),
      ...(o.key === undefined ? {} : { key: o.key as "enter" | "esc" }),
      ...(o.keys === undefined ? {} : { keys: [...(o.keys as string[])] }),
    });
  }
  let tabs: Ask["tabs"];
  if (a.tabs !== undefined) {
    if (!Array.isArray(a.tabs) || a.tabs.length < 2 || a.tabs.length > 10 || !a.tabs.every((t) => isObj(t) && str(t.label, 120) && typeof t.done === "boolean")) return {};
    tabs = (a.tabs as Array<{ label: string; done: boolean }>).map(({ label, done }) => ({ label, done }));
  }
  if (a.tab !== undefined && !(tabs && Number.isInteger(a.tab) && (a.tab as number) >= 0 && (a.tab as number) < tabs.length)) return {};
  return { ask: { id: a.id, ...(a.question === undefined ? {} : { question: a.question as string }), options, ...(tabs ? { tabs } : {}), ...(a.tab === undefined ? {} : { tab: a.tab as number }), ...formOf(a.form) } };
};

/** The whole question set (cockpit/src/phone/ask.ts askForm), one question or several, all or nothing: a bad one drops only the form, and the phone goes question by question. */
const formOf = (f: unknown): { form?: NonNullable<Ask["form"]> } => {
  if (!isObj(f) || !str(f.id, 100) || !/^[\w-]+$/.test(f.id) || !Array.isArray(f.questions) || f.questions.length === 0 || f.questions.length > 4) return {};
  const questions: NonNullable<Ask["form"]>["questions"] = [];
  for (const q of f.questions as unknown[]) {
    if (!isObj(q) || !str(q.header, 40) || !str(q.question, 500) || typeof q.multiSelect !== "boolean" || !Array.isArray(q.options) || q.options.length === 0 || q.options.length > 4) return {};
    const options: NonNullable<Ask["form"]>["questions"][number]["options"] = [];
    for (const o of q.options as unknown[]) {
      if (!isObj(o) || !str(o.label, 120) || o.label === "" || !optStr(o.description, 200)) return {};
      options.push({ label: o.label, ...(o.description === undefined ? {} : { description: o.description as string }) });
    }
    questions.push({ header: q.header, question: q.question, multiSelect: q.multiSelect, options });
  }
  return { form: { id: f.id, questions } };
};

export function stateOf(data: unknown): PhoneState | undefined {
  if (!isObj(data)) return undefined;
  const sessions = list(data.sessions, 500, (s) =>
    isObj(s) && str(s.id, 64) && /^[0-9a-f]+$/.test(s.id) && str(s.pc, 200) && str(s.folder, 500) &&
    (moods as readonly unknown[]).includes(s.mood) && optStr(s.preview, 2000) && typeof s.agent === "boolean"
      ? { id: s.id, pc: s.pc, folder: s.folder, mood: s.mood as PhoneState["sessions"][number]["mood"], agent: s.agent, ...(s.agentGone === true ? { agentGone: true } : {}), ...(s.preview === undefined || (!(s.preview as string).includes("\n") && (modeLine.test((s.preview as string).trim()) || ruleLine.test(s.preview as string))) ? {} : { preview: s.preview as string }), ...paneOf(s.pane), ...stepsOf(s.steps), ...summaryOf(s.summary), ...subagentsOf(s.subagents), ...(str(s.agentName, 100) ? { agentName: s.agentName } : {}), ...(s.mainFree === true ? { mainFree: true } : {}), ...worktreeOf(s), ...(named(s.bot) ? { bot: s.bot } : {}), ...autoOf(s.auto), ...askOf(s.ask) }
      : undefined);
  const pcs = list(data.pcs, 100, (p) =>
    isObj(p) && str(p.label, 200) && (pcStates as readonly unknown[]).includes(p.state)
      ? { ...(hexId(p.id) ? { id: p.id } : {}), label: p.label, state: p.state as PhoneState["pcs"][number]["state"] }
      : undefined);
  const usage = list(data.usage, 10, usageOf);
  // A bad folder is dropped; a PC older than the route sends none.
  const folders = list(data.folders, 1000, (f) =>
    isObj(f) && hexId(f.id) && str(f.pc, 200) && str(f.folder, 500) ? { id: f.id, pc: f.pc, folder: f.folder, ...(str(f.worktreeOf, 500) ? { worktreeOf: f.worktreeOf } : {}) } : undefined);
  return sessions && pcs ? { sessions, pcs, ...(folders?.length ? { folders } : {}), ...(usage?.length ? { usage } : {}) } : undefined;
}

const hexId = (id: unknown): id is string => str(id, 64) && /^[0-9a-f]{16}$/.test(id);

/** A bad window is dropped, and an agent left with none. */
const windowOf = (w: unknown): UsageWindow | undefined =>
  isObj(w) && num(w.percent) && w.percent >= 0 && w.percent <= 100 && (w.resetsAt === undefined || num(w.resetsAt))
    ? { percent: w.percent, ...(w.resetsAt === undefined ? {} : { resetsAt: w.resetsAt as number }) }
    : undefined;
function usageOf(u: unknown): AgentUsage | undefined {
  if (!isObj(u) || !str(u.name, 100)) return undefined;
  const fiveHour = windowOf(u.fiveHour);
  const week = windowOf(u.week);
  return fiveHour || week ? { name: u.name, ...(fiveHour ? { fiveHour } : {}), ...(week ? { week } : {}) } : undefined;
}

/** /api/accounts: PC label, agent name, one of four states; nothing else kept. */
export function accountsOf(body: unknown): PcAccounts | undefined {
  if (!isObj(body)) return undefined;
  return list(body.pcs, 100, (p) => {
    if (!isObj(p) || !str(p.pc, 200)) return undefined;
    const agents = list(p.agents, 20, (a) =>
      isObj(a) && str(a.name, 100) && (accountStates as readonly unknown[]).includes(a.state) ? { name: a.name, state: a.state as AccountState } : undefined);
    return agents ? { pc: p.pc, agents } : undefined;
  });
}

export function screenOf(data: unknown): { data: string; cols: number; rows: number } | undefined {
  if (!isObj(data) || !str(data.data, 4 * 1024 * 1024) || !num(data.cols) || !num(data.rows)) return undefined;
  // The terminal on the phone only reads the screen: a sane size, whatever the PC says.
  const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(n)));
  return { data: data.data, cols: clamp(data.cols, 20, 500), rows: clamp(data.rows, 5, 200) };
}

const TEXT = 200_000;
function itemOf(e: unknown): WorkflowItem | undefined {
  if (!isObj(e) || !time(e.at)) return undefined;
  const mark = e.cancelled === true ? { cancelled: true as const } : {};
  if (e.kind === "prompt" && str(e.text, TEXT)) return { kind: e.kind, at: e.at, text: e.text };
  if (e.kind === "note" && str(e.text, TEXT)) return { kind: e.kind, at: e.at, text: e.text, ...mark };
  if (e.kind === "action" && str(e.text, TEXT)) {
    const labels = e.labels === undefined ? undefined : list(e.labels, 1000, (l) => (str(l, 2000) ? l : undefined));
    return { kind: "action", at: e.at, text: e.text, ...(labels ? { labels } : {}), ...mark };
  }
  if (e.kind === "subagent" && str(e.description, 2000) && str(e.instructions, TEXT) && optStr(e.agentType, 200) && optStr(e.result, TEXT)) {
    return {
      kind: "subagent", at: e.at, description: e.description, instructions: e.instructions,
      ...(e.agentType === undefined ? {} : { agentType: e.agentType as string }),
      ...(e.result === undefined ? {} : { result: e.result as string }),
      ...(time(e.resultAt) ? { resultAt: e.resultAt } : {}),
      ...mark,
    };
  }
  return undefined;
}

/** /api/workflow: the events, or null when the session has no transcript to read. */
export function workflowOf(body: unknown): { title?: string; events: WorkflowItem[]; more?: boolean } | null | undefined {
  if (!isObj(body)) return undefined;
  if (body.ok === false) return null;
  const events = body.ok === true ? list(body.events, 500, itemOf) : undefined;
  if (!events) return undefined;
  return { events, ...(str(body.title, 500) ? { title: body.title } : {}), ...(typeof body.more === "boolean" ? { more: body.more } : {}) };
}

/**
 * Asked for with &before= (the time of the oldest event held): the events before it, and whether the PC holds more.
 * A PC older than that sends its newest instead, which hold nothing before it: none, and no more.
 */
export function olderOf(body: unknown, before: number): { events: WorkflowItem[]; more: boolean } | undefined {
  const read = workflowOf(body);
  if (read === undefined) return undefined;
  const events = read?.events.filter((event) => event.at < before) ?? [];
  return { events, more: read?.more === true && events.length > 0 };
}

/** Older events the reader asked for: "loaded" while the PC holds still more, "done" once it holds none. */
export type Older = "loaded" | "done";

/** What a phone holds once those older events are in. */
export function withOlder<T extends { events: WorkflowItem[] }>(held: T, older: { events: WorkflowItem[]; more: boolean }): T & { older: Older } {
  return { ...held, events: [...older.events, ...held.events], older: older.more ? "loaded" : "done" };
}

/** What /api/workflow answers when asked with &v=, as the phone keeps it. */
/** `more` only as the contract has it: a change never carries one. */
export type WorkflowChange = { same: true } | { title?: string; events: WorkflowItem[]; v?: string; after?: number; keep?: number; more?: boolean };

/** /api/workflow asked with &v=: nothing new, or a list with its "v" (and with `after`, only its newest part). A PC older than this answers as workflowOf reads. */
export function workflowChangeOf(body: unknown): WorkflowChange | null | undefined {
  if (!isObj(body)) return undefined;
  if (body.same === true) return { same: true };
  if (!str(body.v, 64)) return workflowOf(body);
  const events = list(body.events, 500, itemOf);
  if (!events) return undefined;
  return { events, v: body.v, ...(str(body.title, 500) ? { title: body.title } : {}), ...(time(body.after) ? { after: body.after } : {}), ...(typeof body.keep === "number" && Number.isSafeInteger(body.keep) && body.keep > 0 ? { keep: body.keep } : {}) };
}

/** What a phone holds once that answer is in: the newest the PC sent, after any older ones the reader asked for. */
export function withChange<T extends { events: WorkflowItem[]; older?: Older }>(held: T, change: WorkflowChange): T | (Omit<Exclude<WorkflowChange, { same: true }>, "after"> & { older?: Older }) {
  if ("same" in change) return held;
  const { after, ...whole } = change;
  const events = after === undefined ? whole.events : [...held.events.filter((event) => event.at < after), ...whole.events];
  // A newest list that does not reach back to what is held (a new conversation, or more came than it holds): from it alone.
  const apart = (held.events.at(-1)?.at ?? -Infinity) < (events[0]?.at ?? Infinity);
  if (held.older === undefined || apart) return { ...whole, events: events.slice(-(whole.keep ?? 80)) };
  const first = events[0]?.at ?? Infinity;
  return { ...whole, events: [...held.events.filter((event) => event.at < first), ...events], older: held.older };
}

/** /api/docs and /api/files: relative paths, no climbing out. */
export function filesOf(body: unknown): string[] | undefined {
  if (!isObj(body)) return undefined;
  return list(body.files, 5000, (f) => (str(f, 1000) && f !== "" && !f.split("/").includes("..") ? f : undefined));
}

export function commandsOf(body: unknown): CommandSuggestion[] | undefined {
  if (!isObj(body)) return undefined;
  return list(body.commands, 1000, (c) =>
    isObj(c) && str(c.name, 200) && c.name.startsWith("/") && str(c.description, 1000) ? { name: c.name, description: c.description } : undefined);
}

const isoTime = (value: unknown): value is string => str(value, 40) && !Number.isNaN(Date.parse(value));
const nullable = <T>(value: unknown, read: (v: unknown) => T | undefined): T | null | undefined => (value === null ? null : read(value));
/** Why a run was skipped (busy, unreachable, ...): the scheduler's code, never text. */
const reasonOf = (value: unknown) => (str(value, 40) && /^[\w-]+$/.test(value) ? { reason: value } : {});
const runStatusOf = (value: unknown): PhoneBot["runs"][number]["status"] | undefined => (value === "done" || value === "failed" || value === "skipped" || value === "missed" ? value : undefined);
const botStates = ["running", "waiting", "idle", "paused", "missed"] as const;

/** A job's time as the PC keeps it: a minute, an hour unless hourly, weekdays (0 = Sunday) unless every day. */
export function whenOf(w: unknown): When | undefined {
  const within = (v: unknown, hi: number): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= hi;
  if (!isObj(w) || !within(w.minute, 59) || (w.hour !== undefined && !within(w.hour, 23))) return undefined;
  const days = w.days === undefined ? undefined : list(w.days, 7, (d) => (within(d, 6) ? d : undefined));
  if (w.days !== undefined && !days?.length) return undefined;
  return { minute: w.minute, ...(w.hour === undefined ? {} : { hour: w.hour as number }), ...(days ? { days } : {}) };
}

/** /api/bots: a bad bot is dropped, a bad job or run only itself. Names and codes only: the PC sends no answers. */
export function botsOf(body: unknown): PhoneBot[] | undefined {
  if (!isObj(body)) return undefined;
  return list(body.bots, 200, (b): PhoneBot | undefined => {
    if (!isObj(b) || !str(b.id, 64) || !named(b.name) || !str(b.pc, 200) || !hexId(b.pcId) || !str(b.folder, 500) || !str(b.executor, 100)) return undefined;
    if (typeof b.fresh !== "boolean" || typeof b.paused !== "boolean" || !(botStates as readonly unknown[]).includes(b.state)) return undefined;
    const next = nullable(b.next, (v) => (isoTime(v) ? v : undefined));
    const last = nullable(b.last, (v) => {
      const status = isObj(v) ? runStatusOf(v.status) : undefined;
      return isObj(v) && status && isoTime(v.at) ? { at: v.at, status, ...reasonOf(v.reason) } : undefined;
    });
    const missed = nullable(b.missed, (v) => (isObj(v) && Number.isInteger(v.count) && (v.count as number) >= 1 && isoTime(v.at) && str(v.jobId, 64) ? { count: v.count as number, at: v.at, jobId: v.jobId } : undefined));
    const jobs = list(b.jobs, 100, (j) => {
      const when = isObj(j) ? whenOf(j.when) : undefined;
      return isObj(j) && when && str(j.id, 64) && str(j.text, 400) ? { id: j.id, when, text: j.text } : undefined;
    });
    const runs = list(b.runs, 10, (r) => {
      const status = isObj(r) ? runStatusOf(r.status) : undefined;
      return isObj(r) && status && isoTime(r.at) ? { at: r.at, status, ...reasonOf(r.reason), ...(str(r.jobText, 400) ? { jobText: r.jobText } : {}) } : undefined;
    });
    const sessionId = nullable(b.sessionId, (v) => (hexId(v) ? v : undefined));
    if (next === undefined || last === undefined || missed === undefined || !jobs || !runs || sessionId === undefined) return undefined;
    // A path in the folder only, as the files tab takes it.
    const path = b.profilePath;
    const profile = str(path, 500) && path !== "" && !/^[\\/]|^[A-Za-z]:/.test(path) && !path.split(/[\\/]/).includes("..") ? { profilePath: path } : {};
    return {
      id: b.id, name: b.name, pc: b.pc, pcId: b.pcId, folder: b.folder, executor: b.executor, fresh: b.fresh, paused: b.paused,
      state: b.state as PhoneBot["state"], next, last, missed, jobs, runs, ...profile, sessionId,
    };
  });
}

import { modeLine, ruleLine } from "./status.ts";
import {
  accountStates, moods, pcStates, stepKinds,
  type AccountState, type AgentUsage, type CommandSuggestion, type PcAccounts, type PhoneState, type PhoneSubagent, type PhoneSummary, type UsageWindow, type WorkflowItem,
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

export function stateOf(data: unknown): PhoneState | undefined {
  if (!isObj(data)) return undefined;
  const sessions = list(data.sessions, 500, (s) =>
    isObj(s) && str(s.id, 64) && /^[0-9a-f]+$/.test(s.id) && str(s.pc, 200) && str(s.folder, 500) &&
    (moods as readonly unknown[]).includes(s.mood) && optStr(s.preview, 2000) && typeof s.agent === "boolean"
      ? { id: s.id, pc: s.pc, folder: s.folder, mood: s.mood as PhoneState["sessions"][number]["mood"], agent: s.agent, ...(s.agentGone === true ? { agentGone: true } : {}), ...(s.preview === undefined || modeLine.test((s.preview as string).trim()) || ruleLine.test(s.preview as string) ? {} : { preview: s.preview as string }), ...paneOf(s.pane), ...stepsOf(s.steps), ...summaryOf(s.summary), ...subagentsOf(s.subagents), ...(str(s.agentName, 100) ? { agentName: s.agentName } : {}), ...(s.mainFree === true ? { mainFree: true } : {}), ...worktreeOf(s) }
      : undefined);
  const pcs = list(data.pcs, 100, (p) =>
    isObj(p) && str(p.label, 200) && (pcStates as readonly unknown[]).includes(p.state)
      ? { ...(hexId(p.id) ? { id: p.id } : {}), label: p.label, state: p.state as PhoneState["pcs"][number]["state"] }
      : undefined);
  const usage = list(data.usage, 10, usageOf);
  // A bad folder is dropped; a PC older than the route sends none.
  const folders = list(data.folders, 1000, (f) =>
    isObj(f) && hexId(f.id) && str(f.pc, 200) && str(f.folder, 500) ? { id: f.id, pc: f.pc, folder: f.folder } : undefined);
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
export function workflowOf(body: unknown): { title?: string; events: WorkflowItem[] } | null | undefined {
  if (!isObj(body)) return undefined;
  if (body.ok === false) return null;
  const events = body.ok === true ? list(body.events, 500, itemOf) : undefined;
  if (!events) return undefined;
  return { events, ...(str(body.title, 500) ? { title: body.title } : {}) };
}

/** What /api/workflow answers when asked with &v=, as the phone keeps it. */
export type WorkflowChange = { same: true } | { title?: string; events: WorkflowItem[]; v?: string; after?: number };

/** /api/workflow asked with &v=: nothing new, or a list with its "v" (and with `after`, only its newest part). A PC older than this answers as workflowOf reads. */
export function workflowChangeOf(body: unknown): WorkflowChange | null | undefined {
  if (!isObj(body)) return undefined;
  if (body.same === true) return { same: true };
  if (!str(body.v, 64)) return workflowOf(body);
  const events = list(body.events, 500, itemOf);
  if (!events) return undefined;
  return { events, v: body.v, ...(str(body.title, 500) ? { title: body.title } : {}), ...(time(body.after) ? { after: body.after } : {}) };
}

/** What a phone holds once that answer is in. */
export function withChange<T extends { events: WorkflowItem[] }>(held: T, change: WorkflowChange): T | Omit<Exclude<WorkflowChange, { same: true }>, "after"> {
  if ("same" in change) return held;
  const { after, ...whole } = change;
  return after === undefined ? whole : { ...whole, events: [...held.events.filter((event) => event.at < after), ...whole.events].slice(-80) };
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

import { fmt, t } from "../i18n.ts";
import type { PhonePc, PhoneSessionView, PhoneSummary, WorkflowItem } from "../phone/types.ts";
import type { MapInput, MapSession } from "../../../cockpit/src/renderer/workflowmap/model.ts";

/*
 * One PC's constellation from the phone's state: that PC as the hub, its
 * folders, their sessions and subagents. Not a copy of the cockpit's: it
 * only feeds the copied model.ts, which reads a session's workflow. The
 * phone gets a summary rather than the record, so each session gets a
 * small record made back from it -- the prompt (goal), its subagents, the
 * note (result) and the newest step (now) -- which the model summarises to
 * the same lines the PC draws.
 *
 * Type imports only: model.ts and summary.ts run in the web view, never on
 * the app's own engine.
 */

/** The record a summary stands for, oldest first, newest step last. */
export function workflowOf(session: PhoneSessionView): MapSession["workflow"] {
  const sum = session.summary;
  if (!sum) return undefined;
  const start = sum.progress?.since ?? sum.now?.at ?? 0;
  const now = sum.now;
  const events: WorkflowItem[] = [];
  if (sum.goal) events.push({ kind: "prompt", at: start, text: sum.goal });
  const agents = (session.subagents ?? []).map((agent): WorkflowItem => ({
    kind: "subagent", at: agent.since ?? start, description: agent.label, instructions: "", ...(agent.running ? {} : { result: agent.result ?? "", resultAt: agent.doneAt ?? start }),
  }));
  // A subagent step is that subagent, last, so the model words it as an agent step as the PC does.
  const step = now?.kind === "agent" ? agents.findLastIndex((agent) => agent.kind === "subagent" && agent.description === now.text) : -1;
  events.push(...agents.filter((_, i) => i !== step));
  if (sum.result) events.push({ kind: "note", at: now?.at ?? start, text: sum.result });
  if (step >= 0) events.push({ ...agents[step]!, at: now!.at });
  // A note step is the note; with no result to stand for it, it is one.
  else if (now?.kind === "note") { if (!sum.result) events.push({ kind: "note", at: now.at, text: now.text }); }
  else if (now) events.push({ kind: "action", at: now.at, text: now.text });
  return events.length ? { events } : undefined;
}

/**
 * Sessions carry the PC's name, not its id, so the name is the key -- the
 * same one the sessions tab groups by. Folders are keyed by name within it.
 */
export function phoneMap(pc: PhonePc, sessions: readonly PhoneSessionView[], words: { agent: string; terminal: string }, now = Date.now()): MapInput {
  const mine = sessions.filter((session) => session.pc === pc.label);
  const folders = [...new Set(mine.map((session) => session.folder))];
  return {
    // Minutes are enough for "오늘": a finer clock would rebuild the map on every render.
    now: Math.floor(now / 60000) * 60000,
    pcs: [{ id: pc.label, label: pc.label, state: pc.state }],
    // A worktree's folder names its original, which the map joins to it with a branch.
    folders: folders.map((folder) => {
      const of = mine.find((session) => session.folder === folder && session.worktreeOf)?.worktreeOf;
      return { id: folder, pc: pc.label, label: folder, ...(of ? { worktreeOf: of } : {}) };
    }),
    sessions: mine.map((session): MapSession => {
      const workflow = workflowOf(session);
      return { id: session.id, folder: session.folder, label: session.agent ? words.agent : words.terminal, mood: session.mood, ...(workflow ? { workflow } : {}) };
    }),
    delegations: [],
    shares: [],
  };
}

/** "12:27". */
export const clock = (at: number) => {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

/** "38분", "1시간 5분", "1분 안". */
export function duration(minutes: number): string {
  if (minutes < 1) return t.sumUnderMinute;
  if (minutes < 60) return fmt(t.sumMinutes, { n: minutes });
  return fmt(t.sumHours, { h: Math.floor(minutes / 60), m: minutes % 60 });
}

/** 진행, as the PC's panel words it: elapsed · files edited (three named) · reads · commands · subagents (running). */
export function progressLine(summary: PhoneSummary, working: boolean, now = Date.now()): string {
  const p = summary.progress;
  if (!p) return "";
  const bits: string[] = [];
  // Elapsed runs to now while working, else to the newest step.
  const end = working ? now : summary.now?.at ?? now;
  if (p.since !== undefined) bits.push(duration(Math.max(0, Math.floor((end - p.since) / 60000))));
  if (p.files) bits.push(fmt(t.sumEdited, { n: p.files, names: p.fileNames.join(", ") + (p.files > p.fileNames.length ? "…" : "") }));
  if (p.reads) bits.push(fmt(t.sumReads, { n: p.reads }));
  if (p.commands) bits.push(fmt(t.sumCommands, { n: p.commands }));
  if (p.subagents) bits.push(p.running ? fmt(t.sumSubsRunning, { n: p.subagents, m: p.running }) : fmt(t.sumSubs, { n: p.subagents }));
  return bits.join(" · ");
}

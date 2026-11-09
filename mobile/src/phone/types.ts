import type { PhonePc as PcPhonePc, PhoneState as PcPhoneState, PhoneUsage, PhoneUsageWindow } from "../../../cockpit/src/phone/contract.ts";

/**
 * The phone API's shapes are declared once, in cockpit/src/phone/contract.ts,
 * and only named here: type-only, so nothing of the cockpit reaches the bundle.
 * Any optional field may be absent from a PC older than it. The lists below
 * have to exist at run time, for validate.ts; types-match.ts holds them to it.
 *
 * What else is the cockpit's, and where copies.test.ts checks it
 * (cockpit/src/renderer/workflowmap/, which also holds the map's code itself):
 * - verbatim (only the import points here): phone/chat.ts, menu.ts, status.ts
 *   (cockpit/src/phone/); workflowmap/d3-force.d.ts.
 * - functions copied out of Node-only files: phone/copied.ts (inputFor,
 *   MAX_INPUT, matchFiles, reflow), run against the originals.
 */
export type { PhoneSubagent, PhoneSummary, SessionWorkflow, WorkflowItem } from "../../../cockpit/src/shared/ipc.ts";
export type { CommandSuggestion, PcAccounts, PhoneSessionView } from "../../../cockpit/src/phone/contract.ts";

export const moods = ["waiting", "failed", "working", "done", "idle"] as const;
export type Mood = (typeof moods)[number];
/** What a session's lamp and word show: its mood, or a terminal its AI has left. */
export const lampState = (session: { mood: Mood; agentGone?: boolean }): Mood | "shellOnly" => session.agentGone ? "shellOnly" : session.mood;

/** The sessions list: what needs the reader, then what is moving, then what stopped. */
const listRank: Record<Mood, number> = { waiting: 0, working: 1, failed: 2, done: 3, idle: 4 };
export const byUrgency = <S extends { mood: Mood; agentGone?: boolean }>(sessions: readonly S[]): S[] =>
  [...sessions].sort((a, b) => (a.agentGone ? 5 : listRank[a.mood]) - (b.agentGone ? 5 : listRank[b.mood]));

type Placed = { pc: string; folder: string; worktreeOf?: string; worktree?: string };

/** "lepons · 로그인 수정" for a worktree's session, so it never reads as a second "lepons"; the folder's name for any other. */
export const folderName = (session: Placed): string =>
  session.worktreeOf ? `${session.worktreeOf} · ${session.worktree ?? session.folder}` : session.folder;

/**
 * Each worktree's sessions right under the last session of its original
 * folder on the same PC, marked `nested`; one whose original is not in the
 * list keeps its own place. The order is otherwise kept.
 */
export function underOriginals<S extends Placed>(sessions: readonly S[]): Array<{ session: S; nested: boolean }> {
  const isOriginal = (o: S, w: S) => o.worktreeOf === undefined && o.pc === w.pc && o.folder === w.worktreeOf;
  const nested = (w: S) => w.worktreeOf !== undefined && sessions.some((o) => isOriginal(o, w));
  const top = sessions.filter((s) => !nested(s));
  return top.flatMap((s, i) => {
    const last = s.worktreeOf === undefined && !top.slice(i + 1).some((o) => o.worktreeOf === undefined && o.pc === s.pc && o.folder === s.folder);
    const trees = last ? sessions.filter((w) => nested(w) && isOriginal(s, w)) : [];
    return [{ session: s, nested: false }, ...trees.map((w) => ({ session: w, nested: true }))];
  });
}

/** A workflow step's kind, as the work map's dot chain shows it. */
export const stepKinds = ["prompt", "action", "subagent"] as const;
export type StepKind = (typeof stepKinds)[number];

export const pcStates = ["live", "connecting", "failed", "off"] as const;
export type PcState = (typeof pcStates)[number];

/** Its opaque id, for /api/pc-reconnect, is absent from a PC older than it. */
export type PhonePc = Omit<PcPhonePc, "id"> & { id?: string };

export type UsageWindow = PhoneUsageWindow;
export type AgentUsage = PhoneUsage[number];

export type PhoneState = Omit<PcPhoneState, "pcs"> & { pcs: PhonePc[] };

export const accountStates = ["in", "out", "unknown", "none"] as const;
export type AccountState = (typeof accountStates)[number];

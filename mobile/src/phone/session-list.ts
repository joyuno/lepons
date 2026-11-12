import { byUrgency, underOriginals, type Mood, type PcState } from "./types.ts";

type Session = { id: string; pc: string; folder: string; mood: Mood; agentGone?: boolean; worktreeOf?: string; worktree?: string };
type Folder = { id: string; pc: string; folder: string; worktreeOf?: string };
type Pc = { id?: string; label: string; state: PcState };

/** One line of a PC's part: an open session or a closed one, a worktree's a step in under its original. */
export type ListRow<S, F> = ({ kind: "session"; session: S } | { kind: "folder"; folder: F }) & { nested: boolean; lastNested: boolean };

export interface ListGroup<S, F> { pc: string; state?: PcState; pcId?: string; rows: Array<ListRow<S, F>> }

/**
 * The sessions tab: what waits for the reader first, then each PC's part --
 * its open sessions by urgency, then its closed ones -- each worktree under
 * its original folder, open or closed. A worktree whose original is not in
 * its PC's part (waiting above, say) stands on its own. PCs keep the PC's order.
 */
export function sessionList<S extends Session, F extends Folder>(sessions: readonly S[], folders: readonly F[], pcs: readonly Pc[]) {
  const waiting = underOriginals(sessions.filter((one) => one.mood === "waiting"));
  const rest = byUrgency(sessions.filter((one) => one.mood !== "waiting"));
  const labels = [...new Set([...pcs.map((pc) => pc.label), ...rest.map((one) => one.pc), ...folders.map((one) => one.pc)])];
  const groups = labels.flatMap((label): Array<ListGroup<S, F>> => {
    const entries = [
      ...rest.filter((one) => one.pc === label).map((session) => ({ kind: "session" as const, session, name: session.folder, of: session.worktreeOf })),
      ...folders.filter((one) => one.pc === label).map((folder) => ({ kind: "folder" as const, folder, name: folder.folder, of: folder.worktreeOf })),
    ];
    if (entries.length === 0) return [];
    const originals = new Set(entries.filter((one) => one.of === undefined).map((one) => one.name));
    const rows = entries.filter((one) => one.of === undefined || !originals.has(one.of)).flatMap((top) => {
      const children = top.of === undefined ? entries.filter((one) => one.of === top.name) : [];
      // Two open sessions of one folder would take its worktrees twice: the first keeps them.
      const taken = entries.findIndex((one) => one.of === undefined && one.name === top.name) !== entries.indexOf(top);
      return [top, ...(taken ? [] : children)].map((one, i, all) => ({ ...strip(one), nested: i > 0, lastNested: i > 0 && i === all.length - 1 }));
    });
    const pc = pcs.find((one) => one.label === label);
    return [{ pc: label, ...(pc ? { state: pc.state, ...(pc.id ? { pcId: pc.id } : {}) } : {}), rows }];
  });
  return { waiting, groups };
}

const strip = <S, F>(one: { kind: "session"; session: S } | { kind: "folder"; folder: F }) =>
  one.kind === "session" ? { kind: "session" as const, session: one.session } : { kind: "folder" as const, folder: one.folder };

/**
 * Which pane a tab goes to, and (phase 2) where a dragged tab may land. Pure,
 * so the rules are tested without a window; main.ts does the DOM.
 *
 * A project is a folder on a PC -- `sessionKey(node, repo)` -- or the PC alone
 * for a file outside every listed folder. A pane holds one project's tabs.
 */
import { sessionKey } from "../shared/ipc.ts";

export interface LeafView { id: string; project: string | null; tabs: number }
export type Placement = { pane: string } | { split: string } | { blocked: true };

/** A session's project: its folder's key, the folder's own terminal included. */
export function projectOf(key: string): string {
  return key.endsWith("::terminal") ? key.slice(0, -"::terminal".length) : key;
}

/** The deepest listed folder holding `path`; the machine itself when none does. */
export function projectOfFile(repos: ReadonlyArray<{ id: string; path: string }>, nodeId: string, path: string): string {
  let best: { id: string; path: string } | undefined;
  for (const repo of repos) {
    const under = path === repo.path || path.startsWith(`${repo.path}/`);
    if (under && (!best || repo.path.length > best.path.length)) best = repo;
  }
  return sessionKey(nodeId, best?.id ?? null);
}

/**
 * Where a new tab of `project` goes, first match wins: the focused pane if it
 * is the project's and has room; another of its panes with room; the focused
 * pane if empty; any empty pane; a split beside the project's full pane, or
 * beside the focused one. Never another project's pane.
 */
export function place(
  leaves: readonly LeafView[],
  focusedId: string,
  project: string,
  maxTabs: number,
  canSplit: (paneId: string) => boolean,
): Placement {
  const focused = leaves.find((leaf) => leaf.id === focusedId);
  const room = (leaf: LeafView) => leaf.project === project && leaf.tabs < maxTabs;
  if (focused && room(focused)) return { pane: focused.id };
  const same = leaves.find(room);
  if (same) return { pane: same.id };
  if (focused?.project === null) return { pane: focused.id };
  const empty = leaves.find((leaf) => leaf.project === null);
  if (empty) return { pane: empty.id };
  const beside = leaves.find((leaf) => leaf.project === project)?.id ?? focused?.id ?? leaves[0]?.id;
  return beside !== undefined && canSplit(beside) ? { split: beside } : { blocked: true };
}

/** One of six band colours, the same for a project every time. */
export function bandOf(project: string): number {
  let hash = 0;
  for (const char of project) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash % 6;
}

export type Zone = "center" | "right" | "bottom";

/**
 * Where over a pane a dragged tab is: on its tab strip (above `stripBottom`)
 * or in the middle it joins; in the right or bottom quarter it splits off
 * there. Null outside the pane.
 */
export function dropZone(rect: { left: number; top: number; width: number; height: number }, x: number, y: number, stripBottom: number): Zone | null {
  if (x < rect.left || x > rect.left + rect.width || y < rect.top || y > rect.top + rect.height) return null;
  if (y <= stripBottom) return "center";
  const right = (x - rect.left) / rect.width - 0.75;
  const bottom = (y - rect.top) / rect.height - 0.75;
  if (right <= 0 && bottom <= 0) return "center";
  return right > bottom ? "right" : "bottom";
}

/** Whether a tab of `project`, dragged out of `from`, may land in `target` at `zone`. */
export function dropAllowed(target: LeafView, zone: Zone, project: string, from: LeafView, maxTabs: number, canSplit: boolean): boolean {
  if (target.project !== null && target.project !== project) return false;
  if (zone === "center") return target.id === from.id || target.tabs < maxTabs;
  return canSplit && !(target.id === from.id && from.tabs === 1);
}

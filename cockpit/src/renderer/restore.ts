/**
 * The pane layout as it stood, kept so the next Lepons can offer it back,
 * whether the last one was closed or went down -- killed, crashed, the PC
 * lost power. Only what names a place is kept: each pane's project, its tabs
 * (a session, or a file), which tab was shown, and the tool each session ran.
 * The sessions themselves are opened afresh, and a tmux-backed one picks up
 * where it was.
 */
import { projectOf } from "./tabs.ts";

export type SavedFile = { nodeId: string; path: string; name: string };
export type SavedTab = { kind: "session"; key: string } | { kind: "file"; file: SavedFile };
export type SavedPane =
  | { kind: "leaf"; id: string; project: string | null; tabs: SavedTab[]; active: number }
  | { kind: "split"; id: string; direction: "row" | "column"; children: SavedPane[]; sizes: number[] };

export interface SavedLayout {
  version: 2;
  tree: SavedPane;
  executors: Record<string, string>;
  /**
   * Sessions running without a tab: closed tabs, and in a 1.7.5 layout the
   * session under another project's file. Without these only the ones on
   * screen came back.
   */
  background?: string[];
}

/** The layout with only what can be written down: no editors, no views. */
export function layoutOf(tree: SavedPane, executors: Record<string, string>, open: readonly string[] = []): SavedLayout {
  const strip = (pane: SavedPane): SavedPane =>
    pane.kind === "split"
      ? { ...pane, children: pane.children.map(strip) }
      : { kind: "leaf", id: pane.id, project: pane.project, active: pane.active,
          tabs: pane.tabs.map((tab): SavedTab => tab.kind === "session" ? { kind: "session", key: tab.key }
            : { kind: "file", file: { nodeId: tab.file.nodeId, path: tab.file.path, name: tab.file.name } }) };
  const onScreen = new Set(tabKeys(tree));
  const background = open.filter((key) => !onScreen.has(key));
  const keys = new Set([...onScreen, ...background]);
  return {
    version: 2,
    tree: strip(tree),
    executors: Object.fromEntries(Object.entries(executors).filter(([key]) => keys.has(key))),
    ...(background.length > 0 ? { background } : {}),
  };
}

export function leaves(pane: SavedPane): Array<SavedPane & { kind: "leaf" }> {
  return pane.kind === "leaf" ? [pane] : pane.children.flatMap(leaves);
}

const tabKeys = (tree: SavedPane): string[] =>
  leaves(tree).flatMap((leaf) => leaf.tabs.flatMap((tab) => (tab.kind === "session" ? [tab.key] : [])));

type Raw = Record<string, unknown>;
const isRaw = (value: unknown): value is Raw => typeof value === "object" && value !== null && !Array.isArray(value);
const isFile = (value: unknown): value is SavedFile =>
  isRaw(value) && typeof value.nodeId === "string" && typeof value.path === "string" && typeof value.name === "string";
const isTab = (value: unknown): value is SavedTab =>
  isRaw(value) && ((value.kind === "session" && typeof value.key === "string") || (value.kind === "file" && isFile(value.file)));

/**
 * `layout.json` as written by this build (v2) or by 1.7.5 (no version, one
 * session and one file per pane), or null when it is neither: a bad file
 * costs the restore offer, never the start-up that follows it.
 * `fileProject` names a file's project from the folders listed now.
 */
export function readLayout(text: string, fileProject: (nodeId: string, path: string) => string): SavedLayout | null {
  try {
    const raw: unknown = JSON.parse(text);
    if (!isRaw(raw) || !isRaw(raw.executors)) return null;
    const background = Array.isArray(raw.background) ? raw.background.filter((key): key is string => typeof key === "string") : [];
    const leaf = (id: string, project: string | null, tabs: SavedTab[], active = 0): SavedPane =>
      ({ kind: "leaf", id, project: tabs.length > 0 ? project : null, tabs, active });
    const pane = (value: unknown): SavedPane | null => {
      if (!isRaw(value) || typeof value.id !== "string") return null;
      if (value.kind === "split") {
        const { direction, children, sizes } = value;
        if ((direction !== "row" && direction !== "column") || !Array.isArray(children) || !Array.isArray(sizes)) return null;
        const parts = children.map(pane);
        if (parts.length < 2 || sizes.length !== parts.length || !sizes.every((size) => typeof size === "number")) return null;
        if (parts.some((part) => part === null)) return null;
        return { kind: "split", id: value.id, direction, children: parts as SavedPane[], sizes: sizes as number[] };
      }
      if (value.kind !== "leaf") return null;
      if (raw.version === 2) {
        if (!Array.isArray(value.tabs) || typeof value.active !== "number") return null;
        const tabs = value.tabs.filter(isTab);
        return leaf(value.id, typeof value.project === "string" ? value.project : null, tabs, Math.min(Math.max(value.active, 0), Math.max(tabs.length - 1, 0)));
      }
      const key = typeof value.sessionKey === "string" ? value.sessionKey : null;
      const file = isFile(value.file) ? { nodeId: value.file.nodeId, path: value.file.path, name: value.file.name } : undefined;
      if (!file) return key ? leaf(value.id, projectOf(key), [{ kind: "session", key }]) : leaf(value.id, null, []);
      const project = fileProject(file.nodeId, file.path);
      if (key && projectOf(key) === project) return leaf(value.id, project, [{ kind: "session", key }, { kind: "file", file }], 1);
      if (key) background.push(key);
      return leaf(value.id, project, [{ kind: "file", file }]);
    };
    const tree = pane(raw.tree);
    if (!tree) return null;
    const executors = Object.fromEntries(Object.entries(raw.executors).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    return { version: 2, tree, executors, ...(background.length > 0 ? { background } : {}) };
  } catch {
    return null;
  }
}

/**
 * What of `saved` can come back: the same tree, each pane keeping the tabs
 * whose folder or machine is still listed -- a pane left with none stays, empty,
 * so the split the operator made stays as it was. `gone` names what was dropped.
 */
export function restorable(
  saved: SavedLayout,
  sessionExists: (key: string) => boolean,
  nodeExists: (nodeId: string) => boolean,
): { tree: SavedPane; sessions: string[]; files: number; gone: string[] } {
  const gone: string[] = [];
  const keep = (pane: SavedPane): SavedPane => {
    if (pane.kind === "split") return { ...pane, children: pane.children.map(keep) };
    const tabs = pane.tabs.filter((tab) => {
      const here = tab.kind === "session" ? sessionExists(tab.key) : nodeExists(tab.file.nodeId);
      // ponytail: a PC's own terminal (its key is the PC's id) is not reopened,
      // only dropped; restoring it means teaching findByKey a folderless key.
      if (!here && !(tab.kind === "session" && nodeExists(tab.key))) gone.push(tab.kind === "session" ? tab.key : tab.file.path);
      return here;
    });
    // ponytail: a dropped tab before the shown one shifts what is shown; clamped, not tracked.
    return { ...pane, project: tabs.length > 0 ? pane.project : null, tabs, active: Math.min(pane.active, Math.max(tabs.length - 1, 0)) };
  };
  const tree = keep(saved.tree);
  const onScreen = tabKeys(tree);
  const background = (saved.background ?? []).filter((key) => {
    if (onScreen.includes(key)) return false;
    if (sessionExists(key)) return true;
    if (!nodeExists(key)) gone.push(key);
    return false;
  });
  return {
    tree,
    sessions: [...onScreen, ...background],
    files: leaves(tree).reduce((sum, leaf) => sum + leaf.tabs.filter((tab) => tab.kind === "file").length, 0),
    gone,
  };
}

/** The largest `pane-N` in use, so new panes never take a restored one's id. */
export function highestPaneId(tree: SavedPane): number {
  const own = Number(/^pane-(\d+)$/.exec(tree.id)?.[1] ?? 0);
  return tree.kind === "leaf" ? own : Math.max(own, ...tree.children.map(highestPaneId));
}

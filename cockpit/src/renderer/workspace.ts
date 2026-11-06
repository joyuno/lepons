/**
 * The panes: the tree, each pane's tabs, which pane has focus, which is zoomed,
 * and where a tab lands. No DOM at run time, so `node --test` can walk the
 * sequences that keep breaking. main.ts draws this, and hands in what only a
 * window can answer (does a pane have the room to split) as callbacks. Nothing
 * here renders: every change is followed by main.ts's renderPanes().
 */
import type { EditorView } from "@codemirror/view";
import { MAX_TABS } from "./pane-size.ts";
import { highestPaneId } from "./restore.ts";
import { place, type LeafView, type Zone } from "./tabs.ts";

export type Direction = "row" | "column";

/** A file shown in a tab; its overlay lives outside the pane tree, see main.ts positionFileOverlays. */
export interface PaneFile {
  nodeId: string;
  path: string;
  name: string;
  /** Set while the tab is editing the file rather than viewing it. */
  editing?: { view: EditorView; hash: string; eol: "\n" | "\r\n"; bom: boolean; dirty: boolean };
  /** Made by mountFileTab; follows the file from pane to pane. */
  overlay?: HTMLElement;
}
export type PaneTab = { kind: "session"; key: string } | { kind: "file"; file: PaneFile };
/** One project's pane: `project` is null exactly when it has no tabs. */
export type PaneLeaf = { kind: "leaf"; id: string; project: string | null; tabs: PaneTab[]; active: number };
export type PaneSplit = { kind: "split"; id: string; direction: Direction; children: PaneNode[]; sizes: number[] };
export type PaneNode = PaneLeaf | PaneSplit;

const leavesOf = (node: PaneNode): PaneLeaf[] => (node.kind === "leaf" ? [node] : node.children.flatMap(leavesOf));

export const shownTab = (leaf: PaneLeaf): PaneTab | undefined => leaf.tabs[leaf.active];
/** The session the pane shows, if it shows one. */
export function shownKey(leaf: PaneLeaf): string | null {
  const tab = shownTab(leaf);
  return tab?.kind === "session" ? tab.key : null;
}
export function shownFile(leaf: PaneLeaf): PaneFile | undefined {
  const tab = shownTab(leaf);
  return tab?.kind === "file" ? tab.file : undefined;
}
export const leafView = (leaf: PaneLeaf): LeafView => ({ id: leaf.id, project: leaf.project, tabs: leaf.tabs.length });
const sameTab = (a: PaneTab, b: PaneTab) =>
  a.kind === "session" ? b.kind === "session" && b.key === a.key
    : b.kind === "file" && b.file.nodeId === a.file.nodeId && b.file.path === a.file.path;

export type Side = "left" | "right" | "top" | "bottom";
export type ProjectZone = "center" | Side;
/** Where a dropped project opens: in a pane, or in a new one split off beside it. */
export type Landing = { pane: string } | { split: string; side: Side };

/** Where over a pane a project dragged from the rail is: the edge within its outer quarter, else the middle. Null outside the pane. */
export function projectZone(rect: { left: number; top: number; width: number; height: number }, x: number, y: number): ProjectZone | null {
  if (x < rect.left || x > rect.left + rect.width || y < rect.top || y > rect.top + rect.height) return null;
  const across = (x - rect.left) / rect.width;
  const down = (y - rect.top) / rect.height;
  const gaps: Array<[Side, number]> = [["left", across], ["right", 1 - across], ["top", down], ["bottom", 1 - down]];
  const [side, gap] = gaps.reduce((near, next) => (next[1] < near[1] ? next : near));
  return gap < 0.25 ? side : "center";
}

/**
 * The session a tab's × stops, if any: a PC's home terminal (its key is the
 * bare node id) has no rail row to stop it from, so hiding it would leave it
 * running unseen. Every other session tab only hides.
 */
export function homeTerminal(tab: PaneTab, isNode: (id: string) => boolean): string | undefined {
  return tab.kind === "session" && isNode(tab.key) ? tab.key : undefined;
}

export class Workspace {
  tree: PaneNode = { kind: "leaf", id: "pane-root", project: null, tabs: [], active: 0 };
  focused = "pane-root";
  /** The pane shown alone over the whole area, the rest kept behind it; null for the layout. */
  zoomed: string | null = null;
  private lastId = 0;

  private nextId(): string {
    this.lastId += 1;
    return `pane-${this.lastId}`;
  }

  leaves(): PaneLeaf[] {
    return leavesOf(this.tree);
  }
  leaf(id: string): PaneLeaf | undefined {
    return this.leaves().find((leaf) => leaf.id === id);
  }
  focusedLeaf(): PaneLeaf | undefined {
    return this.leaf(this.focused);
  }
  /** Every file open in a tab, shown or not. */
  files(): PaneFile[] {
    return this.leaves().flatMap((leaf) => leaf.tabs.flatMap((tab) => (tab.kind === "file" ? [tab.file] : [])));
  }
  /** The pane a file's tab is in now; undefined once it is closed. */
  ownerOf(file: PaneFile): PaneLeaf | undefined {
    return this.leaves().find((leaf) => leaf.tabs.some((tab) => tab.kind === "file" && tab.file === file));
  }
  /**
   * The sessions on screen: each pane's shown session tab. Unread tracking,
   * the workflow panel's "elsewhere" list and refitting go by this; a hidden
   * tab is elsewhere, and is never fitted.
   */
  visibleSessions(): Set<string> {
    return new Set(this.leaves().flatMap((leaf) => shownKey(leaf) ?? []));
  }
  /** The split a leaf sits in when that split runs the given way -- where a new pane joins as a sibling. */
  sameWaySplit(paneId: string, direction: Direction): PaneSplit | undefined {
    const find = (node: PaneNode): PaneSplit | undefined => {
      if (node.kind === "leaf") return undefined;
      if (node.direction === direction && node.children.some((child) => child.kind === "leaf" && child.id === paneId)) return node;
      for (const child of node.children) {
        const found = find(child);
        if (found) return found;
      }
      return undefined;
    };
    return find(this.tree);
  }
  /**
   * What splitting a pane has to fit in: the node to measure, the panes along
   * that way (equal siblings, see split), and how many divide it the other way.
   * With `moving`, that pane takes the new place, so it adds nothing where it
   * already sits, and the room it leaves beside this pane counts.
   */
  splitArea(paneId: string, direction: Direction, moving?: string): { area: string; parts: number; sharing: number } {
    const holdsMoving = (split: PaneSplit) => split.children.some((child) => child.id === moving);
    const parent = this.sameWaySplit(paneId, direction);
    if (parent) return { area: parent.id, parts: parent.children.length + (holdsMoving(parent) ? 0 : 1), sharing: 1 };
    const across = this.sameWaySplit(paneId, direction === "row" ? "column" : "row");
    if (across && holdsMoving(across)) return { area: across.id, parts: 2, sharing: across.children.length - 1 };
    return { area: paneId, parts: 2, sharing: 1 };
  }

  /** Moves focus. A zoomed pane other than this one lets go, or the focus would land behind it. */
  focus(paneId: string): void {
    if (this.zoomed !== null && this.zoomed !== paneId) this.zoomed = null;
    this.focused = paneId;
  }
  toggleZoom(paneId: string): void {
    this.zoomed = this.zoomed === paneId ? null : paneId;
    this.settleZoom();
  }
  /** Zoom needs a second pane to hide, and its own pane still there. */
  private settleZoom(): void {
    if (this.leaves().length < 2 || !this.leaf(this.zoomed ?? "")) this.zoomed = null;
  }

  /** Splits a pane and focuses the new one (a fresh one, or one being moved here), after it or with `before` ahead of it. Whether it has the room is the caller's to ask first. */
  split(paneId: string, direction: Direction, newLeaf: PaneLeaf = { kind: "leaf", id: this.nextId(), project: null, tabs: [], active: 0 }, before = false): PaneLeaf {
    const parent = this.sameWaySplit(paneId, direction);
    const replace = (node: PaneNode): PaneNode => {
      if (node.kind === "leaf") {
        if (node.id !== paneId) return node;
        return { kind: "split", id: this.nextId(), direction, children: before ? [newLeaf, node] : [node, newLeaf], sizes: [1, 1] };
      }
      if (node === parent) {
        const at = node.children.findIndex((child) => child.id === paneId) + (before ? 0 : 1);
        const children = [...node.children.slice(0, at), newLeaf, ...node.children.slice(at)];
        return { ...node, children, sizes: children.map(() => 1) };
      }
      return { ...node, children: node.children.map(replace) };
    };
    this.tree = replace(this.tree);
    this.focus(newLeaf.id);
    return newLeaf;
  }

  /** Puts a tab last in a pane and shows it. */
  addTab(leaf: PaneLeaf, project: string | null, tab: PaneTab): void {
    leaf.project = project;
    leaf.tabs.push(tab);
    leaf.active = leaf.tabs.length - 1;
  }

  /** Brings a tab to the front of its pane, and the pane into focus. */
  showTab(leaf: PaneLeaf, index: number): void {
    leaf.active = index;
    this.focus(leaf.id);
  }

  /**
   * Puts a tab where tabs.ts place() says, or shows the one already open:
   * never into another project's pane. False when there is no room; then
   * nothing has changed. `splitWay` says how a pane could split, if it can.
   */
  placeTab(project: string, tab: PaneTab, splitWay: (paneId: string) => Direction | null): boolean {
    for (const leaf of this.leaves()) {
      const index = leaf.tabs.findIndex((other) => sameTab(tab, other));
      if (index >= 0) {
        this.showTab(leaf, index);
        return true;
      }
    }
    const where = place(this.leaves().map(leafView), this.focused, project, MAX_TABS, (id) => splitWay(id) !== null);
    if ("blocked" in where) return false;
    const leaf = "split" in where ? this.split(where.split, splitWay(where.split)!) : this.leaf(where.pane)!;
    this.addTab(leaf, project, tab);
    this.focus(leaf.id);
    return true;
  }

  /**
   * Where a project dropped on a pane opens. A tab already open stays where it
   * is, wherever the drop was. An empty pane takes it. An edge splits there. The
   * middle joins the project's own pane with room, else splits the way `splitWay`
   * says. Null when there is no room for that.
   */
  landing(project: string, tab: PaneTab, toId: string, zone: ProjectZone, canSplit: (paneId: string, direction: Direction) => boolean, splitWay: (paneId: string) => Direction | null): Landing | null {
    const open = this.leaves().find((leaf) => leaf.tabs.some((other) => sameTab(tab, other)));
    if (open) return { pane: open.id };
    const to = this.leaf(toId);
    if (!to) return null;
    if (to.project === null) return { pane: toId };
    if (zone === "center") {
      if (to.project === project && to.tabs.length < MAX_TABS) return { pane: toId };
      const way = splitWay(toId);
      return way && { split: toId, side: way === "row" ? "right" : "bottom" };
    }
    return canSplit(toId, zone === "left" || zone === "right" ? "row" : "column") ? { split: toId, side: zone } : null;
  }

  /** Opens a tab where landing() said, and focuses it. */
  openAt(project: string, tab: PaneTab, landing: Landing): void {
    const leaf = "pane" in landing ? this.leaf(landing.pane)!
      : this.split(landing.split, landing.side === "left" || landing.side === "right" ? "row" : "column", undefined, landing.side === "left" || landing.side === "top");
    const open = leaf.tabs.findIndex((other) => sameTab(tab, other));
    if (open >= 0) leaf.active = open;
    else this.addTab(leaf, project, tab);
    this.focus(leaf.id);
  }

  /** Takes a tab out, keeping the shown one where it was. Ending a file's view is the caller's. */
  removeTab(leaf: PaneLeaf, index: number): PaneTab | undefined {
    const [tab] = leaf.tabs.splice(index, 1);
    if (index < leaf.active || leaf.active >= leaf.tabs.length) leaf.active = Math.max(leaf.active - 1, 0);
    if (leaf.tabs.length === 0) leaf.project = null;
    return tab;
  }

  /** Takes the matching tabs out of every pane; emptied panes stay, empty. */
  removeTabs(matches: (tab: PaneTab) => boolean): PaneTab[] {
    const removed: PaneTab[] = [];
    for (const leaf of this.leaves())
      for (let i = leaf.tabs.length - 1; i >= 0; i--) {
        if (!matches(leaf.tabs[i]!)) continue;
        removed.push(this.removeTab(leaf, i)!);
      }
    return removed;
  }

  /** Whether a pane closes now that its tabs are gone: any but the last one. */
  emptied(leaf: PaneLeaf): boolean {
    return leaf.tabs.length === 0 && this.tree.kind !== "leaf";
  }

  /**
   * Removes a leaf. If that leaves its parent split with one child, the split
   * node is replaced by that remaining child -- this is what unwinds a 4-pane
   * layout back down to a single leaf with no special-cased "last pane" path.
   * Undefined when nothing closed (the one remaining pane cannot be); else the
   * tabs that went with it, and the pane focus moved to if it had to.
   */
  closePane(paneId: string): { tabs: PaneTab[]; refocused?: PaneLeaf } | undefined {
    if (this.tree.kind === "leaf") return undefined;
    const tabs = this.leaf(paneId)?.tabs ?? [];
    const remove = (node: PaneNode): PaneNode | null => {
      if (node.kind === "leaf") return node.id === paneId ? null : node;
      const children = node.children.map(remove).filter((child): child is PaneNode => child !== null);
      if (children.length === 1) return children[0]!;
      if (children.length === node.children.length) return { ...node, children };
      return { ...node, children, sizes: children.map(() => 1) };
    };
    const next = remove(this.tree);
    if (!next) return undefined;
    this.tree = next;
    this.settleZoom();
    if (this.focusedLeaf()) return { tabs };
    const refocused = this.leaves()[0]!;
    this.focus(refocused.id);
    return { tabs, refocused };
  }

  /**
   * Lands a dragged tab: into `to` (last, when it is the same pane), or a new
   * pane split off at that edge. A pane it leaves empty closes. Returns where it landed.
   */
  moveTab(from: PaneLeaf, index: number, to: PaneLeaf, zone: Zone, tab: PaneTab, canSplit: (paneId: string, direction: Direction) => boolean): PaneLeaf {
    const project = from.project;
    this.removeTab(from, index);
    let landing = to;
    if (zone !== "center") {
      const direction = zone === "right" ? "row" : "column";
      if (canSplit(to.id, direction)) this.split(to.id, direction);
      landing = this.focusedLeaf()!;
    }
    this.addTab(landing, project, tab);
    if (from.tabs.length === 0 && from !== landing) this.closePane(from.id);
    this.focus(landing.id);
    return landing;
  }

  /** A pane can be picked up when there is another to drop it on, and none is zoomed over the rest. */
  canDragPane(): boolean {
    return this.zoomed === null && this.tree.kind !== "leaf";
  }

  /** Whether a dragged pane may land on another. `canSplit` is the room at that edge; the pane count does not change. */
  paneDropAllowed(paneId: string, toId: string, zone: Zone, canSplit: (paneId: string, direction: Direction) => boolean): boolean {
    if (!this.canDragPane() || paneId === toId || !this.leaf(paneId) || !this.leaf(toId)) return false;
    if (zone === "center") return true;
    const direction = zone === "right" ? "row" : "column";
    // Already right after it: the only change would be losing the split's sizes.
    const parent = this.sameWaySplit(toId, direction);
    if (parent?.children[parent.children.findIndex((child) => child.id === toId) + 1]?.id === paneId) return false;
    return canSplit(toId, direction);
  }

  /**
   * Lands a dragged pane: on another's middle the two change places, sizes
   * staying with the place; on its edge it moves there, as moveTab splits. The
   * leaf itself moves, tabs and all, so nothing is reopened and a file's overlay
   * finds it by id. False when not allowed; then nothing has changed.
   */
  dropPane(paneId: string, toId: string, zone: Zone, canSplit: (paneId: string, direction: Direction) => boolean): boolean {
    if (!this.paneDropAllowed(paneId, toId, zone, canSplit)) return false;
    const moved = this.leaf(paneId)!;
    if (zone === "center") {
      const other = this.leaf(toId)!;
      const swap = (node: PaneNode): PaneNode =>
        node.kind === "split" ? { ...node, children: node.children.map(swap) } : node === moved ? other : node === other ? moved : node;
      this.tree = swap(this.tree);
    } else {
      this.closePane(paneId);
      this.split(toId, zone === "right" ? "row" : "column", moved);
    }
    this.focus(paneId);
    return true;
  }

  /** Takes over a saved tree; new panes never reuse its ids. */
  restore(tree: PaneNode): void {
    this.tree = tree;
    this.lastId = highestPaneId(tree);
    this.focused = this.leaves()[0]!.id;
    this.settleZoom();
  }
}

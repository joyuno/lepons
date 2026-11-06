import { test } from "node:test";
import assert from "node:assert/strict";

import { MAX_PANES, MAX_TABS } from "./pane-size.ts";
import { layoutOf, readLayout, restorable } from "./restore.ts";
import { homeTerminal, projectZone, shownKey, Workspace, type Landing, type PaneNode, type PaneTab, type ProjectZone, type Side } from "./workspace.ts";

const session = (key: string): PaneTab => ({ kind: "session", key });
const fileTab = (path: string, nodeId = "pc"): PaneTab => ({ kind: "file", file: { nodeId, path, name: path } });
const canSplit = () => "row" as const;
const noSplit = () => null;
const shape = (node: PaneNode): unknown => (node.kind === "leaf" ? node.id : node.children.map(shape));

/** Panes "a", "b", ... side by side, each holding one session of its own project; focus on the first. */
function sideBySide(...projects: string[]): { ws: Workspace; ids: string[] } {
  const ws = new Workspace();
  const ids = [ws.focused];
  for (const _ of projects.slice(1)) ids.push(ws.split(ws.focused, "row").id);
  projects.forEach((project, at) => ws.addTab(ws.leaf(ids[at]!)!, project, session(project)));
  ws.focus(ids[0]!);
  return { ws, ids };
}

// 5908dc2: with A zoomed, a tab placed in B moved focus to B behind A, so nothing visible happened.

test("a new tab landing in another pane lets go of the zoom", () => {
  const { ws, ids } = sideBySide("a", "b");
  ws.toggleZoom(ids[0]!);
  assert.ok(ws.placeTab("b", session("b::terminal"), canSplit));
  assert.equal(ws.zoomed, null);
  assert.equal(ws.focused, ids[1]);
});

test("showing a tab already open in another pane lets go of the zoom", () => {
  const { ws, ids } = sideBySide("a", "b");
  ws.toggleZoom(ids[0]!);
  assert.ok(ws.placeTab("b", session("b"), canSplit));
  assert.equal(ws.zoomed, null);
  assert.equal(ws.focused, ids[1]);
});

test("an empty pane chosen for the tab lets go of the zoom too", () => {
  const { ws, ids } = sideBySide("a", "b");
  const empty = ws.split(ids[1]!, "column");
  ws.focus(ids[0]!);
  ws.toggleZoom(ids[0]!);
  assert.ok(ws.placeTab("c", session("c"), canSplit));
  assert.equal(ws.zoomed, null);
  assert.equal(ws.focused, empty.id);
});

test("a tab landing in the zoomed pane keeps the zoom", () => {
  const { ws, ids } = sideBySide("a", "b");
  ws.toggleZoom(ids[0]!);
  assert.ok(ws.placeTab("a", session("a::terminal"), canSplit));
  assert.equal(ws.zoomed, ids[0]);
  assert.ok(ws.placeTab("a", session("a"), canSplit));
  assert.equal(ws.zoomed, ids[0]);
});

test("a split to make room lets go of the zoom and focuses the new pane", () => {
  const { ws, ids } = sideBySide("a", "b");
  ws.toggleZoom(ids[0]!);
  assert.ok(ws.placeTab("c", session("c"), canSplit));
  assert.equal(ws.zoomed, null);
  assert.equal(ws.leaves().length, 3);
  assert.equal(ws.focusedLeaf()?.project, "c");
});

test("zoom, open elsewhere, close: focus and zoom both end up on panes that exist", () => {
  const { ws, ids } = sideBySide("a", "b");
  ws.toggleZoom(ids[0]!);
  ws.focus(ids[0]!);
  ws.placeTab("b", session("b::terminal"), canSplit);
  const leaf = ws.focusedLeaf()!;
  while (leaf.tabs.length > 0) ws.removeTab(leaf, 0);
  assert.ok(ws.emptied(leaf));
  assert.equal(ws.closePane(leaf.id)?.refocused?.id, ids[0]);
  assert.equal(ws.tree.kind, "leaf");
  assert.equal(ws.zoomed, null);
  assert.equal(ws.focused, ids[0]);
});

test("closing the zoomed pane drops the zoom; closing another keeps it", () => {
  const closingZoomed = sideBySide("a", "b", "c");
  closingZoomed.ws.toggleZoom(closingZoomed.ids[0]!);
  closingZoomed.ws.closePane(closingZoomed.ids[0]!);
  assert.equal(closingZoomed.ws.zoomed, null);

  const closingOther = sideBySide("a", "b", "c");
  closingOther.ws.toggleZoom(closingOther.ids[0]!);
  closingOther.ws.closePane(closingOther.ids[2]!);
  assert.equal(closingOther.ws.zoomed, closingOther.ids[0]);
  closingOther.ws.closePane(closingOther.ids[1]!);
  assert.equal(closingOther.ws.zoomed, null, "one pane left: nothing to zoom over");
});

test("a lone pane does not zoom; zoom toggles off", () => {
  const ws = new Workspace();
  ws.toggleZoom(ws.focused);
  assert.equal(ws.zoomed, null);
  const { ws: two, ids } = sideBySide("a", "b");
  two.toggleZoom(ids[0]!);
  assert.equal(two.zoomed, ids[0]);
  two.toggleZoom(ids[0]!);
  assert.equal(two.zoomed, null);
});

test("focus moved to another pane by any route lets go of the zoom", () => {
  const { ws, ids } = sideBySide("a", "b");
  ws.toggleZoom(ids[0]!);
  ws.focus(ids[0]!);
  assert.equal(ws.zoomed, ids[0]);
  ws.showTab(ws.leaf(ids[1]!)!, 0);
  assert.equal(ws.zoomed, null);
});

// 73badf8: a PC's home terminal has no rail row, so hiding its tab left it running unseen.

test("only a PC's home terminal is stopped by its tab's ×", () => {
  const isNode = (id: string) => id === "pc";
  assert.equal(homeTerminal(session("pc"), isNode), "pc");
  assert.equal(homeTerminal(session("pc::a"), isNode), undefined);
  assert.equal(homeTerminal(session("pc::a::terminal"), isNode), undefined);
  assert.equal(homeTerminal(fileTab("pc"), isNode), undefined);
});

test("an emptied pane closes, unless it is the last", () => {
  const { ws, ids } = sideBySide("a", "b");
  const second = ws.leaf(ids[1]!)!;
  ws.removeTab(second, 0);
  assert.ok(ws.emptied(second));
  assert.equal(second.project, null);
  ws.closePane(second.id);
  const last = ws.leaf(ids[0]!)!;
  ws.removeTab(last, 0);
  assert.equal(ws.emptied(last), false);
  assert.equal(ws.closePane(last.id), undefined);
  assert.equal(ws.leaves().length, 1);
});

test("closing a tab keeps the shown one shown", () => {
  const ws = new Workspace();
  const leaf = ws.focusedLeaf()!;
  for (const key of ["x", "y", "z"]) ws.addTab(leaf, "p", session(key));
  ws.showTab(leaf, 1);
  ws.removeTab(leaf, 0);
  assert.equal(shownKey(leaf), "y");
  ws.removeTab(leaf, 1);
  assert.equal(shownKey(leaf), "y");
  ws.removeTab(leaf, 0);
  assert.equal(shownKey(leaf), null);
  assert.equal(leaf.active, 0);
});

test("closing the shown last tab shows the one before it", () => {
  const ws = new Workspace();
  const leaf = ws.focusedLeaf()!;
  for (const key of ["x", "y"]) ws.addTab(leaf, "p", session(key));
  ws.removeTab(leaf, 1);
  assert.equal(shownKey(leaf), "x");
});

test("closing the focused pane moves focus to the first pane left; closing another leaves focus be", () => {
  const { ws, ids } = sideBySide("a", "b", "c");
  ws.focus(ids[1]!);
  assert.equal(ws.closePane(ids[2]!)?.refocused, undefined);
  assert.equal(ws.focused, ids[1]);
  assert.equal(ws.closePane(ids[1]!)?.refocused?.id, ids[0]);
  assert.equal(ws.focused, ids[0]);
});

test("closePane says which tabs went with the pane, for the views to end", () => {
  const { ws, ids } = sideBySide("a", "b");
  const file = fileTab("/a.md");
  ws.addTab(ws.leaf(ids[1]!)!, "b", file);
  assert.deepEqual(ws.closePane(ids[1]!)?.tabs, [session("b"), file]);
});

test("closing unwinds a split with one child left, and evens the sizes of one with more", () => {
  const ws = new Workspace();
  const a = ws.focused;
  const b = ws.split(a, "row").id;
  const c = ws.split(b, "column").id;
  assert.deepEqual(shape(ws.tree), [a, [b, c]]);
  ws.closePane(c);
  assert.deepEqual(shape(ws.tree), [a, b]);
  const d = ws.split(b, "row").id;
  if (ws.tree.kind === "split") ws.tree.sizes = [3, 1, 2];
  ws.closePane(d);
  assert.deepEqual(ws.tree.kind === "split" && ws.tree.sizes, [1, 1]);
  ws.closePane(b);
  assert.deepEqual(shape(ws.tree), a);
});

test("splitting the way the parent runs adds an equal sibling beside the pane, not a nested split", () => {
  const ws = new Workspace();
  const a = ws.focused;
  const b = ws.split(a, "row").id;
  const c = ws.split(a, "row").id;
  assert.deepEqual(shape(ws.tree), [a, c, b]);
  assert.deepEqual(ws.tree.kind === "split" && ws.tree.sizes, [1, 1, 1]);
  assert.equal(ws.focused, c);
});

test("placing never takes another project's pane: no room means nothing changed", () => {
  const { ws, ids } = sideBySide("a", "b");
  const before = JSON.stringify(ws.tree);
  assert.equal(ws.placeTab("c", session("c"), noSplit), false);
  assert.equal(JSON.stringify(ws.tree), before);
  assert.equal(ws.focused, ids[0]);
});

test("a full pane of the project splits beside itself, the way the window says", () => {
  const ws = new Workspace();
  const first = ws.focused;
  for (let at = 0; at < MAX_TABS; at++) ws.addTab(ws.focusedLeaf()!, "a", session(`a${at}`));
  const asked: string[] = [];
  assert.ok(ws.placeTab("a", session("more"), (id) => (asked.push(id), "column")));
  assert.ok(asked.includes(first));
  assert.equal(ws.tree.kind === "split" && ws.tree.direction, "column");
  assert.equal(ws.leaf(first)!.tabs.length, MAX_TABS);
  assert.equal(shownKey(ws.focusedLeaf()!), "more");
});

test("a file already open is shown, by machine and path, not opened twice", () => {
  const { ws, ids } = sideBySide("a", "b");
  ws.addTab(ws.leaf(ids[1]!)!, "b", fileTab("/f.md"));
  ws.addTab(ws.leaf(ids[1]!)!, "b", session("b::terminal"));
  assert.ok(ws.placeTab("whatever", fileTab("/f.md"), canSplit));
  assert.equal(ws.focused, ids[1]);
  assert.equal(ws.leaf(ids[1]!)!.tabs.length, 3);
  assert.equal(ws.leaf(ids[1]!)!.active, 1);
  assert.ok(ws.placeTab("other", fileTab("/f.md", "srv"), canSplit));
  assert.equal(ws.files().length, 2, "the same path on another machine is another file");
});

test("dragging a pane's only tab into another pane closes the one it left", () => {
  const { ws, ids } = sideBySide("a", "b");
  const from = ws.leaf(ids[0]!)!;
  const to = ws.leaf(ids[1]!)!;
  ws.addTab(to, "a", session("b2"));
  const tab = from.tabs[0]!;
  assert.equal(ws.moveTab(from, 0, to, "center", tab, () => true), to);
  assert.equal(ws.tree.kind, "leaf");
  assert.equal(ws.focused, to.id);
  assert.equal(shownKey(to), "a");
});

test("dragging one of several tabs into another pane moves focus with it", () => {
  const { ws, ids } = sideBySide("a", "b");
  const from = ws.leaf(ids[0]!)!;
  ws.addTab(from, "a", session("a::terminal"));
  const to = ws.leaf(ids[1]!)!;
  ws.moveTab(from, 1, to, "center", from.tabs[1]!, () => true);
  assert.equal(ws.focused, to.id);
  assert.equal(shownKey(from), "a");
  assert.equal(shownKey(to), "a::terminal");
});

test("dropping a tab on its own pane puts it last, even a lone tab, and keeps the project", () => {
  const ws = new Workspace();
  const leaf = ws.focusedLeaf()!;
  ws.addTab(leaf, "p", session("only"));
  ws.moveTab(leaf, 0, leaf, "center", leaf.tabs[0]!, () => true);
  assert.equal(leaf.project, "p");
  assert.equal(shownKey(leaf), "only");
  ws.addTab(leaf, "p", session("next"));
  ws.moveTab(leaf, 0, leaf, "center", leaf.tabs[0]!, () => true);
  assert.deepEqual(leaf.tabs, [session("next"), session("only")]);
  assert.equal(leaf.active, 1);
});

test("dragging a tab to an edge splits off a pane holding it, and that pane's project is the tab's", () => {
  const ws = new Workspace();
  const leaf = ws.focusedLeaf()!;
  for (const key of ["x", "y"]) ws.addTab(leaf, "p", session(key));
  const asked: Array<[string, string]> = [];
  const landing = ws.moveTab(leaf, 0, leaf, "bottom", leaf.tabs[0]!, (id, way) => (asked.push([id, way]), true));
  assert.deepEqual(asked, [[leaf.id, "column"]]);
  assert.notEqual(landing, leaf);
  assert.equal(landing.project, "p");
  assert.equal(shownKey(landing), "x");
  assert.equal(shownKey(leaf), "y");
  assert.equal(ws.focused, landing.id);
});

test("removing one session's tabs across panes leaves the panes, empty", () => {
  const { ws, ids } = sideBySide("a", "b");
  ws.addTab(ws.leaf(ids[1]!)!, "b", session("b::terminal"));
  const removed = ws.removeTabs((tab) => tab.kind === "session" && tab.key.startsWith("b"));
  assert.equal(removed.length, 2);
  assert.equal(ws.leaves().length, 2);
  assert.equal(ws.leaf(ids[1]!)!.project, null);
  assert.equal(ws.leaf(ids[0]!)!.tabs.length, 1);
});

test("what is visible is each pane's shown session, and a file's owner follows the tab", () => {
  const { ws, ids } = sideBySide("a", "b");
  const file = { nodeId: "pc", path: "/f.md", name: "f.md" };
  ws.addTab(ws.leaf(ids[1]!)!, "b", { kind: "file", file });
  assert.deepEqual([...ws.visibleSessions()], ["a"]);
  assert.equal(ws.ownerOf(file)?.id, ids[1]);
  ws.removeTabs((tab) => tab.kind === "file");
  assert.equal(ws.ownerOf(file), undefined);
});

test("a restored tree keeps its ids free: the next pane does not take one", () => {
  const ws = new Workspace();
  ws.restore({ kind: "split", id: "pane-7", direction: "row", sizes: [1, 1], children: [
    { kind: "leaf", id: "pane-3", project: "a", tabs: [session("a")], active: 0 },
    { kind: "leaf", id: "pane-9", project: null, tabs: [], active: 0 },
  ] });
  assert.equal(ws.focused, "pane-3");
  assert.equal(ws.split("pane-3", "column").id, "pane-10");
});

// Dragging a whole pane by its head.

const room = () => true;
type Split = Extract<PaneNode, { kind: "split" }>;

test("a zoomed layout takes no pane drag, until the zoom lets go", () => {
  const { ws, ids } = sideBySide("a", "b");
  const [a, b] = ids as [string, string];
  ws.toggleZoom(a);
  assert.equal(ws.canDragPane(), false);
  assert.equal(ws.dropPane(a, b, "center", room), false);
  assert.equal(ws.dropPane(a, b, "right", room), false);
  assert.deepEqual(shape(ws.tree), [a, b]);
  assert.equal(ws.zoomed, a, "a refused drop leaves the zoom on");
  ws.toggleZoom(a);
  assert.equal(ws.canDragPane(), true);
  assert.ok(ws.dropPane(a, b, "center", room));
  assert.deepEqual(shape(ws.tree), [b, a]);
});

test("a lone pane, itself and a pane that is gone are no drops", () => {
  const lone = new Workspace();
  assert.equal(lone.canDragPane(), false);
  const { ws, ids } = sideBySide("a", "b");
  assert.equal(ws.dropPane(ids[0]!, ids[0]!, "center", room), false);
  assert.equal(ws.dropPane(ids[0]!, ids[0]!, "right", room), false);
  assert.equal(ws.dropPane(ids[0]!, "pane-gone", "center", room), false);
  assert.equal(ws.dropPane("pane-gone", ids[0]!, "center", room), false);
  assert.deepEqual(shape(ws.tree), ids);
});

test("a swap changes places: tabs go with the pane, sizes stay with the place", () => {
  const { ws, ids } = sideBySide("a", "b", "c");
  const [a, b, c] = ids as [string, string, string];
  const file = fileTab("/f.md", "a") as Extract<PaneTab, { kind: "file" }>;
  ws.addTab(ws.leaf(a)!, "a", file);
  const leafA = ws.leaf(a)!;
  (ws.tree as Split).sizes = [3, 2, 1];
  assert.ok(ws.dropPane(a, c, "center", room));
  assert.deepEqual(shape(ws.tree), [c, b, a]);
  assert.deepEqual((ws.tree as Split).sizes, [3, 2, 1]);
  assert.equal(ws.leaf(a), leafA, "the same leaf, so no session or file starts over");
  assert.equal(ws.leaf(a)!.active, 1);
  assert.equal(ws.leaf(a)!.project, "a");
  assert.equal(ws.ownerOf(file.file)?.id, a, "the overlay still finds its pane");
  assert.equal(ws.focused, a);
});

test("a swap reaches across nested splits", () => {
  const { ws, ids } = sideBySide("a", "b");
  const [a, b] = ids as [string, string];
  const below = ws.split(b, "column").id;
  ws.addTab(ws.leaf(below)!, "c", session("c"));
  assert.ok(ws.dropPane(a, below, "center", room));
  assert.deepEqual(shape(ws.tree), [below, [b, a]]);
});

test("swap then close: the right pane goes and its neighbour takes the room", () => {
  const { ws, ids } = sideBySide("a", "b", "c");
  const [a, b, c] = ids as [string, string, string];
  assert.ok(ws.dropPane(a, c, "center", room));
  assert.equal(ws.closePane(a)?.tabs[0]?.kind, "session");
  assert.deepEqual(shape(ws.tree), [c, b]);
  assert.deepEqual(ws.leaves().map(shownKey), ["c", "b"]);
  assert.ok(ws.leaf(ws.focused), "focus moved off the closed pane");
});

test("a move to an edge splits there and unwinds the split it left", () => {
  const { ws, ids } = sideBySide("a", "b");
  const [a, b] = ids as [string, string];
  const asked: Array<[string, string]> = [];
  assert.ok(ws.dropPane(a, b, "bottom", (id, way) => (asked.push([id, way]), true)));
  assert.deepEqual(asked, [[b, "column"]]);
  assert.deepEqual(shape(ws.tree), [b, a]);
  assert.equal((ws.tree as Split).direction, "column");
  assert.equal(ws.focused, a);
  assert.deepEqual(ws.leaves().map(shownKey), ["b", "a"]);
});

test("a move joins a split already running that way, and reorders inside one", () => {
  const { ws, ids } = sideBySide("a", "b", "c");
  const [a, b, c] = ids as [string, string, string];
  assert.ok(ws.dropPane(a, c, "right", room));
  assert.deepEqual(shape(ws.tree), [b, c, a]);
  const nested = sideBySide("a", "b", "c");
  const [x, y, z] = nested.ids as [string, string, string];
  assert.ok(nested.ws.dropPane(z, x, "bottom", room));
  assert.deepEqual(shape(nested.ws.tree), [[x, z], y]);
});

test("a move that would change nothing is refused and keeps the sizes", () => {
  const { ws, ids } = sideBySide("a", "b");
  const [a, b] = ids as [string, string];
  const split = ws.tree as Split;
  split.sizes = [3, 1];
  assert.equal(ws.dropPane(b, a, "right", room), false);
  assert.equal(ws.tree, split);
  assert.deepEqual(split.sizes, [3, 1]);
  assert.ok(ws.dropPane(b, a, "bottom", room), "the other edge is a real move");
});

test("no room at the edge leaves everything; the middle needs none", () => {
  const { ws, ids } = sideBySide("a", "b");
  const [a, b] = ids as [string, string];
  const tree = ws.tree;
  assert.equal(ws.dropPane(a, b, "right", () => false), false);
  assert.equal(ws.tree, tree);
  assert.equal(ws.focused, a);
  assert.ok(ws.dropPane(a, b, "center", () => false));
});

test("at the pane cap a pane still moves, and the count never rises", () => {
  const projects = Array.from({ length: MAX_PANES }, (_, at) => `p${at}`);
  const { ws, ids } = sideBySide(...projects);
  assert.ok(ws.dropPane(ids[0]!, ids[3]!, "bottom", room));
  assert.ok(ws.dropPane(ids[1]!, ids[0]!, "right", room));
  assert.ok(ws.dropPane(ids[2]!, ids[7]!, "center", room));
  assert.equal(ws.leaves().length, MAX_PANES);
  assert.deepEqual(new Set(ws.leaves().map(shownKey)), new Set(projects));
});

test("move then restore brings the new arrangement back", () => {
  const { ws, ids } = sideBySide("a", "b", "c");
  const [a, b, c] = ids as [string, string, string];
  ws.addTab(ws.leaf(a)!, "a", fileTab("/f.md", "pc"));
  assert.ok(ws.dropPane(a, c, "bottom", room));
  assert.ok(ws.dropPane(b, c, "center", room));
  const before = shape(ws.tree);
  assert.deepEqual(before, [c, [b, a]]);

  const saved = readLayout(JSON.stringify(layoutOf(ws.tree, {})), () => "");
  assert.ok(saved);
  const back = restorable(saved, () => true, () => true);
  const next = new Workspace();
  next.restore(back.tree as PaneNode);
  assert.deepEqual(shape(next.tree), before);
  assert.deepEqual(next.leaves().map((leaf) => leaf.tabs.length), [1, 1, 2]);
  assert.equal(next.leaf(a)!.active, 1);
  // The split made by the move counts too: a new pane must not take its id.
  const used = new Set<string>();
  const walk = (node: PaneNode): void => {
    used.add(node.id);
    if (node.kind === "split") node.children.forEach(walk);
  };
  walk(next.tree);
  assert.ok(!used.has(next.split(a, "row").id));
});

test("the room for a moved pane counts what it leaves behind", () => {
  const { ws, ids } = sideBySide("a", "b", "c");
  const [a, b, c] = ids as [string, string, string];
  const row = ws.tree.id;
  // A new pane, and a move within the split: along the way it already runs.
  assert.deepEqual(ws.splitArea(a, "row"), { area: row, parts: 4, sharing: 1 });
  assert.deepEqual(ws.splitArea(a, "row", c), { area: row, parts: 3, sharing: 1 });
  // Across it: a new pane has only its own part; a moved sibling's part is shared out.
  assert.deepEqual(ws.splitArea(a, "column"), { area: a, parts: 2, sharing: 1 });
  assert.deepEqual(ws.splitArea(a, "column", c), { area: row, parts: 2, sharing: 2 });
  ws.closePane(b);
  assert.deepEqual(ws.splitArea(a, "column", c), { area: row, parts: 2, sharing: 1 }, "it unwinds: all of it");
  // From elsewhere: an added sibling, and nothing freed here.
  const below = ws.split(c, "column").id;
  assert.deepEqual(ws.splitArea(a, "row", below), { area: row, parts: 3, sharing: 1 });
  assert.deepEqual(ws.splitArea(a, "column", below), { area: a, parts: 2, sharing: 1 });
});

// Dropping a project from the rail onto a pane.

const dropOn = (ws: Workspace, project: string, to: string, zone: ProjectZone, fits = true, way: "row" | "column" | null = "row"): Landing | null =>
  ws.landing(project, session(project), to, zone, () => fits, () => way);

test("a project's drop zone: the four outer quarters, then the middle", () => {
  const rect = { left: 100, top: 200, width: 400, height: 200 };
  assert.equal(projectZone(rect, 110, 300), "left");
  assert.equal(projectZone(rect, 490, 300), "right");
  assert.equal(projectZone(rect, 300, 210), "top");
  assert.equal(projectZone(rect, 300, 390), "bottom");
  assert.equal(projectZone(rect, 300, 300), "center");
  assert.equal(projectZone(rect, 110, 202), "top", "a corner goes to the nearer edge");
  assert.equal(projectZone(rect, 99, 300), null);
  assert.equal(projectZone(rect, 300, 401), null);
});

test("every edge splits at that edge, the new pane focused and holding the session", () => {
  const cases: Array<[Side, (a: string, added: string) => unknown, "row" | "column"]> = [
    ["left", (a, added) => [added, a], "row"],
    ["right", (a, added) => [a, added], "row"],
    ["top", (a, added) => [added, a], "column"],
    ["bottom", (a, added) => [a, added], "column"],
  ];
  for (const [zone, order, direction] of cases) {
    const ws = new Workspace();
    const a = ws.focused;
    ws.addTab(ws.leaf(a)!, "a", session("a"));
    const landing = dropOn(ws, "b", a, zone)!;
    assert.deepEqual(landing, { split: a, side: zone });
    ws.openAt("b", session("b"), landing);
    const added = ws.focused;
    assert.notEqual(added, a);
    assert.deepEqual(shape(ws.tree), order(a, added));
    assert.equal((ws.tree as Split).direction, direction);
    assert.equal(shownKey(ws.leaf(added)!), "b");
    assert.equal(ws.leaf(a)!.tabs.length, 1, "the pane it split keeps its own");
  }
});

test("a drop on the near edge joins a split running that way, beside the pane", () => {
  const { ws, ids } = sideBySide("a", "b");
  const [a, b] = ids as [string, string];
  ws.openAt("c", session("c"), dropOn(ws, "c", b, "left")!);
  const c = ws.focused;
  assert.deepEqual(shape(ws.tree), [a, c, b]);
  assert.deepEqual((ws.tree as Split).sizes, [1, 1, 1]);
  ws.openAt("d", session("d"), dropOn(ws, "d", a, "left")!);
  assert.deepEqual(shape(ws.tree), [ws.focused, a, c, b]);
});

test("the middle: its own project joins as a tab, another's splits the way it can", () => {
  const { ws, ids } = sideBySide("a", "b");
  const [a] = ids as [string];
  assert.deepEqual(ws.landing("a", session("a::terminal"), a, "center", room, canSplit), { pane: a });
  assert.deepEqual(dropOn(ws, "c", a, "center", true, "row"), { split: a, side: "right" });
  assert.deepEqual(dropOn(ws, "c", a, "center", true, "column"), { split: a, side: "bottom" });
  assert.equal(dropOn(ws, "c", a, "center", true, null), null);
  ws.openAt("a", session("a::terminal"), { pane: a });
  assert.deepEqual(ws.leaf(a)!.tabs, [session("a"), session("a::terminal")]);
  assert.equal(shownKey(ws.leaf(a)!), "a::terminal");
});

test("the middle of its own full pane splits instead", () => {
  const ws = new Workspace();
  const a = ws.focused;
  for (let at = 0; at < MAX_TABS; at++) ws.addTab(ws.leaf(a)!, "a", fileTab(`f${at}`));
  assert.deepEqual(ws.landing("a", session("a"), a, "center", room, canSplit), { split: a, side: "right" });
});

test("an empty pane takes it whole, whatever the zone, so no panes open just opens", () => {
  const ws = new Workspace();
  const root = ws.focused;
  for (const zone of ["center", "left", "top", "right", "bottom"] as const) assert.deepEqual(dropOn(ws, "a", root, zone, false, null), { pane: root });
  ws.openAt("a", session("a"), { pane: root });
  assert.equal(ws.tree.kind, "leaf");
  assert.equal(shownKey(ws.leaf(root)!), "a");
});

test("no room at the edge: no landing, and nothing changed", () => {
  const { ws, ids } = sideBySide("a", "b");
  const before = JSON.stringify(ws.tree);
  for (const zone of ["left", "right", "top", "bottom"] as const) assert.equal(dropOn(ws, "c", ids[0]!, zone, false), null);
  assert.equal(dropOn(ws, "c", "pane-gone", "left"), null);
  assert.equal(JSON.stringify(ws.tree), before);
});

test("a session already open stays where it is, wherever the drop was", () => {
  const { ws, ids } = sideBySide("a", "b");
  const [a, b] = ids as [string, string];
  ws.addTab(ws.leaf(b)!, "b", session("b::terminal"));
  const landing = dropOn(ws, "b", a, "left", false, null)!;
  assert.deepEqual(landing, { pane: b });
  ws.openAt("b", session("b"), landing);
  assert.equal(ws.leaves().length, 2);
  assert.equal(ws.leaf(b)!.tabs.length, 2);
  assert.equal(shownKey(ws.leaf(b)!), "b");
  assert.equal(ws.focused, b);
});

test("a drop splitting a zoomed pane lets go of the zoom, so the new pane is seen", () => {
  const { ws, ids } = sideBySide("a", "b");
  ws.toggleZoom(ids[0]!);
  ws.openAt("c", session("c"), dropOn(ws, "c", ids[0]!, "top")!);
  assert.equal(ws.zoomed, null);
  assert.equal(shownKey(ws.focusedLeaf()!), "c");
});

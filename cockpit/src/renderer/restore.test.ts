import { test } from "node:test";
import assert from "node:assert/strict";

import { highestPaneId, layoutOf, leaves, readLayout, restorable, type SavedPane } from "./restore.ts";

const readme = { nodeId: "srv", path: "/x/readme.md", name: "readme.md" };
const tree: SavedPane = {
  kind: "split", id: "pane-1", direction: "row", sizes: [1, 1], children: [
    { kind: "leaf", id: "pane-root", project: "pc::a", tabs: [{ kind: "session", key: "pc::a" }], active: 0 },
    { kind: "split", id: "pane-2", direction: "column", sizes: [2, 1], children: [
      { kind: "leaf", id: "pane-3", project: "srv::b", tabs: [{ kind: "session", key: "srv::b::terminal" }, { kind: "file", file: readme }], active: 1 },
      { kind: "leaf", id: "pane-4", project: null, tabs: [], active: 0 },
    ] },
  ],
};
// The project of a file, as main.ts derives it from the listed folders.
const fileProject = (nodeId: string, path: string) => (path.startsWith("/x/") ? `${nodeId}::b` : nodeId);

test("keeps only the executors of sessions still open", () => {
  const saved = layoutOf(tree, { "pc::a": "claude", "pc::old": "codex" });
  assert.equal(saved.version, 2);
  assert.deepEqual(saved.executors, { "pc::a": "claude" });
});

test("writes no editor or overlay", () => {
  const live: SavedPane = { kind: "leaf", id: "pane-root", project: "srv::b", active: 0,
    tabs: [{ kind: "file", file: { ...readme, editing: {}, overlay: {} } as typeof readme }] };
  const saved = layoutOf(live, {});
  assert.deepEqual(saved.tree, { kind: "leaf", id: "pane-root", project: "srv::b", active: 0, tabs: [{ kind: "file", file: readme }] });
});

test("v2 round-trips through text", () => {
  const saved = layoutOf(tree, {}, ["pc::a", "pc::bg"]);
  assert.deepEqual(readLayout(JSON.stringify(saved), fileProject), saved);
});

test("garbage or a wrong shape reads as nothing", () => {
  assert.equal(readLayout("{not json", fileProject), null);
  assert.equal(readLayout("null", fileProject), null);
  assert.equal(readLayout(JSON.stringify({ tree: { kind: "split", id: "s", children: [] }, executors: {} }), fileProject), null);
  assert.equal(readLayout(JSON.stringify({ version: 2, tree: { kind: "leaf", id: "p" }, executors: {} }), fileProject), null);
});

test("1.7.5 layouts: one pane per old shape", () => {
  const v1 = (leaf: object) => JSON.stringify({ tree: leaf, executors: {} });
  const only = (text: string) => leaves(readLayout(text, fileProject)!.tree)[0];
  assert.deepEqual(only(v1({ kind: "leaf", id: "p", sessionKey: "pc::a" })),
    { kind: "leaf", id: "p", project: "pc::a", tabs: [{ kind: "session", key: "pc::a" }], active: 0 });
  assert.deepEqual(only(v1({ kind: "leaf", id: "p", sessionKey: null, file: readme })),
    { kind: "leaf", id: "p", project: "srv::b", tabs: [{ kind: "file", file: readme }], active: 0 });
  // Same project: both, the file shown, as it lay on top before.
  assert.deepEqual(only(v1({ kind: "leaf", id: "p", sessionKey: "srv::b::terminal", file: readme })),
    { kind: "leaf", id: "p", project: "srv::b", tabs: [{ kind: "session", key: "srv::b::terminal" }, { kind: "file", file: readme }], active: 1 });
  assert.deepEqual(only(v1({ kind: "leaf", id: "p", sessionKey: null })),
    { kind: "leaf", id: "p", project: null, tabs: [], active: 0 });
});

test("1.7.5: a session under another project's file goes to the background", () => {
  const text = JSON.stringify({ tree: { kind: "leaf", id: "p", sessionKey: "pc::a", file: readme }, executors: { "pc::a": "claude" }, background: ["pc::z"] });
  const saved = readLayout(text, fileProject)!;
  assert.deepEqual(saved.tree, { kind: "leaf", id: "p", project: "srv::b", tabs: [{ kind: "file", file: readme }], active: 0 });
  assert.deepEqual(saved.background, ["pc::z", "pc::a"]);
});

test("1.7.5: splits keep their sizes", () => {
  const text = JSON.stringify({ tree: { kind: "split", id: "s", direction: "row", sizes: [3, 1], children: [
    { kind: "leaf", id: "a", sessionKey: null }, { kind: "leaf", id: "b", sessionKey: "pc::a" }] }, executors: {} });
  const saved = readLayout(text, fileProject)!;
  assert.equal(saved.tree.kind, "split");
  assert.deepEqual(saved.tree.kind === "split" && saved.tree.sizes, [3, 1]);
});

test("drops only the tabs whose machine or folder is gone, keeping every pane", () => {
  const saved = layoutOf(tree, {});
  const all = restorable(saved, () => true, () => true);
  assert.deepEqual(all.sessions, ["pc::a", "srv::b::terminal"]);
  assert.equal(all.files, 1);
  assert.deepEqual(all.gone, []);

  const noServer = restorable(saved, (key) => key.startsWith("pc::"), (id) => id === "pc");
  assert.deepEqual(noServer.sessions, ["pc::a"]);
  assert.equal(noServer.files, 0);
  assert.deepEqual(noServer.gone, ["srv::b::terminal", "/x/readme.md"]);
  const emptied = leaves(noServer.tree).find((leaf) => leaf.id === "pane-3")!;
  assert.deepEqual(emptied, { kind: "leaf", id: "pane-3", project: null, tabs: [], active: 0 });
  assert.equal(noServer.tree.kind, "split");
});

test("a partly gone pane keeps the rest, its shown tab in range", () => {
  const plan = restorable(layoutOf(tree, {}), () => true, (id) => id !== "srv");
  const pane = leaves(plan.tree).find((leaf) => leaf.id === "pane-3")!;
  assert.deepEqual(pane.tabs, [{ kind: "session", key: "srv::b::terminal" }]);
  assert.equal(pane.active, 0);
});

test("new pane ids start past the restored ones", () => {
  assert.equal(highestPaneId(tree), 4);
});

test("sessions running without a tab come back too, once", () => {
  const saved = layoutOf(tree, { "pc::a": "claude", "pc::bg": "codex", "pc::old": "codex" }, ["pc::a", "pc::bg"]);
  assert.deepEqual(saved.background, ["pc::bg"]);
  assert.deepEqual(saved.executors, { "pc::a": "claude", "pc::bg": "codex" });
  const plan = restorable({ ...saved, background: ["pc::bg", "pc::a"] }, (key) => key !== "srv::b::terminal", () => true);
  assert.deepEqual(plan.sessions, ["pc::a", "pc::bg"]);
  const gone = restorable({ ...saved, background: ["pc::bg", "pc::removed"] }, (key) => key !== "pc::removed", (id) => id === "pc");
  assert.ok(gone.gone.includes("pc::removed"));
});

test("a PC's own terminal is left out of a restore without counting as gone", () => {
  const own: SavedPane = { kind: "split", id: "pane-1", direction: "row", sizes: [1, 1], children: [
    { kind: "leaf", id: "pane-root", project: "pc", tabs: [{ kind: "session", key: "pc" }], active: 0 },
    { kind: "leaf", id: "pane-2", project: "pc::a", tabs: [{ kind: "session", key: "pc::a" }], active: 0 },
  ] };
  const saved = { ...layoutOf(own, { pc: "shell", "pc::a": "claude", srv: "shell" }), background: ["srv"] };
  // findByKey knows folders only; the node list knows both PCs.
  const plan = restorable(saved, (key) => key === "pc::a", (id) => id === "pc" || id === "srv");
  assert.deepEqual(plan.sessions, ["pc::a"]);
  assert.deepEqual(plan.gone, []);
  assert.deepEqual(leaves(plan.tree)[0], { kind: "leaf", id: "pane-root", project: null, tabs: [], active: 0 });
});

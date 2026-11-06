import { test } from "node:test";
import assert from "node:assert/strict";

import { bandOf, dropAllowed, dropZone, place, projectOf, projectOfFile, type LeafView } from "./tabs.ts";

test("a folder's terminal belongs to the folder's project", () => {
  assert.equal(projectOf("pc::a::terminal"), "pc::a");
  assert.equal(projectOf("pc::a"), "pc::a");
  assert.equal(projectOf("pc"), "pc");
});

test("a file belongs to the deepest folder holding it, else to its machine", () => {
  const repos = [{ id: "r", path: "/w" }, { id: "deep", path: "/w/app" }, { id: "x", path: "/wx" }];
  assert.equal(projectOfFile(repos, "pc", "/w/app/a.md"), "pc::deep");
  assert.equal(projectOfFile(repos, "pc", "/w/b.md"), "pc::r");
  assert.equal(projectOfFile(repos, "pc", "/wx/c.md"), "pc::x");
  assert.equal(projectOfFile(repos, "pc", "/elsewhere/d.md"), "pc");
});

const leaf = (id: string, project: string | null, tabs = project ? 1 : 0): LeafView => ({ id, project, tabs });
const yes = () => true;
const no = () => false;

test("goes to the focused pane when it is the project's and has room", () => {
  assert.deepEqual(place([leaf("p1", "a"), leaf("p2", "a")], "p2", "a", 6, yes), { pane: "p2" });
});

test("prefers another pane of the project over an empty one", () => {
  assert.deepEqual(place([leaf("p1", null), leaf("p2", "a"), leaf("p3", "b")], "p3", "a", 6, yes), { pane: "p2" });
});

test("takes the focused pane when it is empty, then any empty pane", () => {
  assert.deepEqual(place([leaf("p1", null), leaf("p2", null)], "p2", "a", 6, yes), { pane: "p2" });
  assert.deepEqual(place([leaf("p1", "b"), leaf("p2", null)], "p1", "a", 6, yes), { pane: "p2" });
});

test("splits beside a full pane of the project, else beside the focused one", () => {
  assert.deepEqual(place([leaf("p1", "b"), leaf("p2", "a", 6)], "p1", "a", 6, yes), { split: "p2" });
  assert.deepEqual(place([leaf("p1", "b"), leaf("p2", "c")], "p1", "a", 6, yes), { split: "p1" });
});

test("never takes another project's pane: blocked when nothing can split", () => {
  assert.deepEqual(place([leaf("p1", "b"), leaf("p2", "c")], "p1", "a", 6, no), { blocked: true });
});

test("a project keeps its band colour", () => {
  assert.equal(bandOf("pc::a"), bandOf("pc::a"));
  for (const id of ["pc", "pc::a", "srv::b", "x"]) assert.ok(bandOf(id) >= 0 && bandOf(id) < 6);
});

const rect = { left: 0, top: 0, width: 400, height: 200 };

test("a drop on the strip or the middle joins the pane; near an edge it splits", () => {
  assert.equal(dropZone(rect, 390, 10, 26), "center");   // on the strip, even at the right
  assert.equal(dropZone(rect, 200, 100, 26), "center");
  assert.equal(dropZone(rect, 350, 100, 26), "right");
  assert.equal(dropZone(rect, 200, 190, 26), "bottom");
  assert.equal(dropZone(rect, 395, 199, 26), "bottom");  // corner: the nearer edge, in proportion, wins
  assert.equal(dropZone(rect, 399, 190, 26), "right");
  assert.equal(dropZone(rect, 401, 100, 26), null);
});

test("a tab never lands in another project's pane", () => {
  const from = { id: "p1", project: "a", tabs: 2 };
  const other = { id: "p2", project: "b", tabs: 1 };
  for (const zone of ["center", "right", "bottom"] as const) assert.equal(dropAllowed(other, zone, "a", from, 6, true), false);
});

test("a full pane takes no tab in the middle, but splits at an edge", () => {
  const from = { id: "p1", project: "a", tabs: 2 };
  const full = { id: "p2", project: "a", tabs: 6 };
  assert.equal(dropAllowed(full, "center", "a", from, 6, true), false);
  assert.equal(dropAllowed(full, "right", "a", from, 6, true), true);
  assert.equal(dropAllowed(full, "right", "a", from, 6, false), false);
});

test("an empty pane takes any project; a lone tab cannot split off its own pane", () => {
  const lone = { id: "p1", project: "a", tabs: 1 };
  assert.equal(dropAllowed({ id: "p2", project: null, tabs: 0 }, "center", "a", lone, 6, true), true);
  assert.equal(dropAllowed(lone, "right", "a", lone, 6, true), false);
  assert.equal(dropAllowed(lone, "center", "a", lone, 6, true), true); // reorder in place
});

import { test } from "node:test";
import assert from "node:assert/strict";

import { HOLD_MS, holdOn, isProject, movedBy } from "./hold.ts";
import { build, shiftBranch, type MapInput } from "./model.ts";

test("a held press lifts a project after the wait, and only then", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const kind of ["folder", "merged"] as const) {
    const lifted: string[] = [];
    holdOn({ id: "f:a", kind }, (id) => lifted.push(id));
    t.mock.timers.tick(HOLD_MS - 1);
    assert.deepEqual(lifted, [], "not before the wait");
    t.mock.timers.tick(1);
    assert.deepEqual(lifted, ["f:a"]);
  }
});

test("a pan, a second finger or letting go calls the wait off", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const lifted: string[] = [];
  const off = holdOn({ id: "f:a", kind: "folder" }, (id) => lifted.push(id));
  t.mock.timers.tick(HOLD_MS - 1);
  off();
  t.mock.timers.tick(HOLD_MS * 2);
  assert.deepEqual(lifted, []);
});

test("only a project lifts: not a PC, a session, a subagent, a chip or empty ground", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const lifted: string[] = [];
  for (const kind of ["hub", "session", "sub", "chip"] as const) {
    assert.equal(isProject({ kind }), false);
    holdOn({ id: kind, kind }, (id) => lifted.push(id));
  }
  holdOn(undefined, (id) => lifted.push(id));
  t.mock.timers.tick(HOLD_MS * 2);
  assert.deepEqual(lifted, []);
});

test("drags add up, and a saved offset carries the project's sessions and subagents with it", () => {
  assert.deepEqual(movedBy(undefined, 5, -2), { x: 5, y: -2 });
  assert.deepEqual(movedBy({ x: 1, y: 1 }, 5, -2), { x: 6, y: -1 });
  const T = Date.now();
  const input: MapInput = {
    now: T,
    pcs: [{ id: "pc", label: "PC" }],
    folders: [{ id: "a", pc: "pc", label: "a" }, { id: "b", pc: "pc", label: "b" }],
    sessions: [
      { id: "s1", folder: "a", label: "one", mood: "working", workflow: { events: [{ kind: "subagent", at: T, description: "look", instructions: "" }] } },
      { id: "s2", folder: "a", label: "two", mood: "working" },
      { id: "s3", folder: "b", label: "three", mood: "idle" },
    ],
    delegations: [],
    shares: [],
  };
  const home = build(input);
  const moved = build(input, undefined, { "f:a": { x: 70, y: -30 } });
  const under = home.nodes.filter((n) => n.folder === "a");
  assert.ok(under.some((n) => n.kind === "session") && under.some((n) => n.kind === "sub"), "the project has sessions and a subagent");
  for (const n of under) {
    const m = moved.byId.get(n.id)!;
    assert.deepEqual([m.x, m.y], [n.x + 70, n.y - 30], n.id);
  }
  assert.deepEqual([moved.byId.get("f:b")!.x, moved.byId.get("h:pc")!.x], [home.byId.get("f:b")!.x, home.byId.get("h:pc")!.x], "nothing else moves");
  // A drag mid-way lands the same place as its saved offset.
  shiftBranch(home, "f:a", 70, -30);
  assert.equal(home.byId.get("s:s1")!.x, moved.byId.get("s:s1")!.x);
});

import { test } from "node:test";
import assert from "node:assert/strict";

import type { WorkflowItem } from "../../shared/ipc.ts";
import { boxOf, branchOf, build, cloud, footprint, level, linesOf, nextWaiting, nodeOfSession, nodeScale, type MapInput, type MapSession } from "./model.ts";

const T = new Date(2026, 9, 31, 12, 0).getTime();
const ev = (kind: "prompt" | "note" | "action", at: number, text: string): WorkflowItem => ({ kind, at, text });
const flow = (goal: string, last: string): MapSession["workflow"] => ({ events: [ev("prompt", T - 600000, goal), ev("action", T - 60000, last)] });

const input = (): MapInput => ({
  now: T,
  pcs: [{ id: "mac", label: "맥북" }, { id: "local", label: "이 PC", local: true }],
  folders: [
    { id: "local::a", pc: "local", label: "lepons" },
    { id: "local::b", pc: "local", label: "dotfiles" },
    { id: "local::c", pc: "local", label: "empty" },
    { id: "mac::d", pc: "mac", label: "ios" },
  ],
  sessions: [
    { id: "local::a", folder: "local::a", label: "Claude Code", mood: "working", workflow: { events: [ev("prompt", T - 600000, "Make the map"), { kind: "subagent", at: T - 300000, description: "explore", instructions: "look around" }] } },
    { id: "local::a::t", folder: "local::a", label: "터미널", mood: "idle" },
    { id: "local::a2", folder: "local::a", label: "Codex", mood: "waiting", workflow: flow("Pick a colour", "Edit paint.ts") },
    { id: "local::b", folder: "local::b", label: "Claude Code", mood: "done", workflow: { events: [ev("prompt", T - 600000, "dots"), ev("note", T - 60000, "Linked the dotfiles. Nothing else.")] } },
    { id: "mac::d", folder: "mac::d", label: "Claude Code", mood: "working", workflow: flow("Ship the build", "Bash · xcodebuild") },
  ],
  delegations: [{ id: "d1", from: "local", toFolder: "mac::d", running: true }],
  shares: [{ from: "local", to: "mac" }, { from: "mac", to: "local" }],
});

test("one constellation per PC, this PC first and to the left, the others packed to its right", () => {
  const m = build(input());
  const hubs = m.nodes.filter((n) => n.kind === "hub");
  assert.deepEqual(hubs.map((n) => n.id), ["h:local", "h:mac"]);
  assert.equal(hubs[0]!.local, true);
  const localMax = Math.max(...m.nodes.filter((n) => n.pc === "local").map((n) => n.x));
  const macMin = Math.min(...m.nodes.filter((n) => n.pc === "mac").map((n) => n.x));
  assert.ok(macMin > localMax, "the second constellation sits clear of the first");
  for (const n of m.nodes) if (n.kind === "folder" || n.kind === "merged") assert.equal(n.parent, `h:${n.pc}`);
});

test("a folder with one session is one merged pill; with more it branches into session pills", () => {
  const m = build(input());
  assert.equal(m.byId.get("f:local::b")!.kind, "merged");
  assert.equal(m.byId.get("f:local::b")!.session, "local::b");
  assert.equal(m.byId.get("f:mac::d")!.kind, "merged");
  assert.equal(m.byId.get("f:local::a")!.kind, "folder");
  assert.equal(m.byId.get("f:local::c")!.kind, "folder", "a folder with no session is a bare folder");
  assert.ok(m.byId.has("s:local::a") && m.byId.has("s:local::a2"));
  assert.equal(m.byId.has("s:local::a::t"), false, "a calmly closed session folds into the chip");
  assert.equal(m.byId.get("c:local::a")!.count, 1);
  assert.equal(nodeOfSession(m, "local::b")!.id, "f:local::b");
  assert.equal(nodeOfSession(m, "local::a2")!.id, "s:local::a2");
});

test("running subagents hang off their session; delegations and shares link hubs to folders and hubs (each pair once)", () => {
  const m = build(input());
  const sub = m.byId.get("a:local::a:1")!;
  assert.equal(sub.parent, "s:local::a");
  assert.equal(sub.instr, "look around");
  assert.ok(m.edges.some((e) => e.kind === "loop" && e.to === sub.id));
  assert.deepEqual(m.edges.filter((e) => e.kind === "delegation").map((e) => [e.from, e.to, e.live]), [["h:local", "f:mac::d", true]]);
  assert.equal(m.edges.filter((e) => e.kind === "share").length, 1);
});

test("summary lines: now + goal under working and waiting, one result line under done, a closed one says why", () => {
  const m = build(input());
  assert.deepEqual(m.byId.get("s:local::a2")!.lines, [{ at: T - 60000, text: "Edit paint.ts" }, { text: "Pick a colour", faint: true }]);
  assert.deepEqual(m.byId.get("s:local::a")!.lines![0], { at: T - 300000, text: "explore", agent: true });
  assert.deepEqual(m.byId.get("f:local::b")!.lines, [{ text: "Linked the dotfiles.", faint: true }]);
  assert.deepEqual(linesOf({ id: "x", folder: "f", label: "", mood: "failed", note: "auth_failed · 다시 연결", workflow: flow("old", "old step") }), [{ text: "auth_failed · 다시 연결", faint: true }]);
  assert.deepEqual(linesOf({ id: "x", folder: "f", label: "", mood: "idle", note: "closed" }), []);
  assert.deepEqual(linesOf({ id: "x", folder: "f", label: "", mood: "working" }), [], "no record yet: no lines, no crash");
  const long = "아주 긴 지시 ".repeat(30);
  assert.equal(Array.from(linesOf({ id: "x", folder: "f", label: "", mood: "waiting", workflow: flow(long, "x") })[1]!.text).length, 40);
});

test("the hub carries its PC line", () => {
  const m = build(input());
  assert.deepEqual(m.byId.get("h:local")!.counts, { working: 1, waiting: 1, done: 1, subagents: 1 });
  assert.deepEqual(m.byId.get("h:mac")!.counts, { working: 1, waiting: 0, done: 0, subagents: 0 });
});

test("the hub carries its PC's connection and OS, and makes room for its name and chip under the circle", () => {
  const i = input();
  i.pcs = [{ id: "local", label: "이 PC", local: true, state: "live", os: "Windows" }, { id: "mac", label: "맥북", state: "connecting" }];
  const m = build(i);
  const [mine, mac] = [m.byId.get("h:local")!, m.byId.get("h:mac")!];
  assert.deepEqual([mine.state, mine.os, mac.state, mac.os], ["live", "Windows", "connecting", undefined]);
  const [withChip] = footprint(mine), [bare] = footprint({ ...mine, os: undefined } as typeof mine);
  assert.ok(withChip!.x1 - withChip!.x0 > bare!.x1 - bare!.x0, "the chip widens it");
  assert.ok(bare!.y1 - mine.y > mine.y - bare!.y0, "a short name goes under the circle too");
});

test("the force layout runs only when a PC's folders or sessions change, not when moods or steps do", () => {
  const first = build(input());
  assert.equal(first.laidOut, true);
  const same = build(input(), first);
  assert.equal(same.laidOut, false);
  assert.deepEqual([same.byId.get("f:local::b")!.x, same.byId.get("f:local::b")!.y], [first.byId.get("f:local::b")!.x, first.byId.get("f:local::b")!.y]);
  const moody = input();
  moody.sessions[3]!.mood = "working";
  moody.sessions[3]!.workflow!.events.push(ev("action", T, "Edit x"));
  assert.equal(build(moody, first).laidOut, false);
  const grown = input();
  grown.sessions.push({ id: "local::b2", folder: "local::b", label: "Codex", mood: "working" });
  const regrown = build(grown, first);
  assert.equal(regrown.laidOut, true);
  assert.equal(regrown.byId.get("f:local::b")!.kind, "folder", "a second session splits the merged pill");
  assert.equal(build(input()).byId.get("f:local::a")!.x, first.byId.get("f:local::a")!.x, "the same input lays out the same way");
});

test("saved offsets move a hub's whole constellation, and a folder with its column on top of that", () => {
  const plain = build(input());
  const moved = build(input(), undefined, { "h:mac": { x: 100, y: -50 }, "f:mac::d": { x: 10, y: 0 }, "h:gone": { x: 999, y: 999 } });
  const d = (id: string) => [moved.byId.get(id)!.x - plain.byId.get(id)!.x, moved.byId.get(id)!.y - plain.byId.get(id)!.y];
  assert.deepEqual(d("h:mac"), [100, -50]);
  assert.deepEqual(d("f:mac::d"), [110, -50]);
  assert.deepEqual(d("h:local"), [0, 0]);
  const cluster = (m: typeof plain) => m.clusters.find((c) => c.id === "mac::d")!;
  assert.equal(cluster(moved).fx - cluster(plain).fx, 110, "the cloud moves with its folder");
});

test("branchOf and boxOf cover a folder and everything under it", () => {
  const m = build(input());
  const branch = branchOf(m, "f:local::a");
  assert.ok(branch.has("s:local::a") && branch.has("a:local::a:1") && branch.has("c:local::a"));
  assert.equal(branch.has("f:local::b"), false);
  const box = boxOf(m, branch);
  for (const id of branch) {
    const n = m.byId.get(id)!;
    assert.ok(n.x >= box.x0 && n.x <= box.x1 && n.y >= box.y0 && n.y <= box.y1);
  }
});

test("zoom levels: dots below 25%, pills to 60%, detail above; pills grow slower than the map", () => {
  assert.equal(level(0.24), "dots");
  assert.equal(level(0.25), "pills", "blocks show from 25%, under the 30% the map opens at");
  assert.equal(level(0.3), "pills");
  assert.equal(level(0.6), "pills");
  assert.equal(level(0.61), "detail");
  assert.equal(nodeScale(0.34), 1);
  assert.ok(nodeScale(0.5) > 1 && nodeScale(0.5) < 0.5 / 0.34);
  assert.equal(nodeScale(2), 1.15);
  assert.ok(Math.abs(nodeScale(0.25) / 0.25 - nodeScale(0.3) / 0.3) < 1e-9, "under 30% pills shrink with the map: never more world than at 30%");
});

test("clouds are seeded and follow activity", () => {
  const m = build(input());
  const busy = m.clusters.find((c) => c.id === "local::a")!;
  const quiet = m.clusters.find((c) => c.id === "local::c")!;
  assert.ok(busy.activity > quiet.activity);
  assert.deepEqual(cloud(busy), cloud(busy));
  assert.ok(cloud(busy).length > cloud(quiet).length);
});

test("nextWaiting goes round the waiting sessions", () => {
  const sessions = [{ id: "a", mood: "waiting" }, { id: "b", mood: "working" }, { id: "c", mood: "waiting" }] as MapSession[];
  assert.equal(nextWaiting({ sessions }), "a");
  assert.equal(nextWaiting({ sessions }, "a"), "c");
  assert.equal(nextWaiting({ sessions }, "c"), "a");
  assert.equal(nextWaiting({ sessions: [] }), undefined);
});

test("an empty input builds an empty map with a sane box", () => {
  const m = build({ now: T, pcs: [], folders: [], sessions: [], delegations: [], shares: [] });
  assert.equal(m.nodes.length, 0);
  assert.ok(m.bounds.x1 > m.bounds.x0);
  const lone = build({ now: T, pcs: [{ id: "p", label: "p" }], folders: [], sessions: [], delegations: [], shares: [] });
  assert.equal(lone.nodes.length, 1);
});

/** A busy PC: a big folder with every kind of row, a merged one with subagents, and folders on both sides. */
const busy = (): MapInput => {
  const sub = (at: number, description: string, back?: number, agentType?: string): WorkflowItem => ({ kind: "subagent", at, description, instructions: `조사해: ${description}`, ...(agentType ? { agentType } : {}), ...(back === undefined ? {} : { result: `${description} 끝냈습니다. 자세한 건 아래.`, resultAt: back }) });
  const long = "아주 긴 세션 제목이 들어가서 알약이 넓어지는 경우를 본다 ".repeat(3);
  return {
    now: T,
    pcs: [{ id: "local", label: "이 PC", local: true }, { id: "vm", label: "ubuntu-vm-with-a-long-name" }],
    folders: ["big", "one", "two", "three", "four"].map((id) => ({ id: `local::${id}`, pc: "local", label: id === "big" ? "lepons-monorepo-with-long-name" : id })).concat([{ id: "vm::r", pc: "vm", label: "relay" }]),
    sessions: [
      { id: "b1", folder: "local::big", label: "Claude Code", mood: "working", fresh: true, workflow: { title: long, events: [ev("prompt", T - 900000, "지도를 다시 그려 줘. ".repeat(20)), ...[1, 2, 3, 4, 5].map((i) => sub(T - 800000 + i * 1000, `조사 ${i}`, T - 600000 + i * 1000, i === 5 ? "Explore" : undefined)), sub(T - 300000, "아직 도는 것"), ev("action", T - 1000, "Edit model.ts")] } },
      { id: "b2", folder: "local::big", label: "Codex", mood: "waiting", workflow: flow("Pick a colour", "Edit paint.ts") },
      { id: "b3", folder: "local::big", label: "Claude Code", mood: "done", workflow: { events: [ev("prompt", T - 600000, "dots"), ev("note", T - 60000, "Linked the dotfiles. Nothing else.")] } },
      { id: "b4", folder: "local::big", label: "터미널", mood: "idle" },
      { id: "o1", folder: "local::one", label: "Claude Code", mood: "working", workflow: { events: [ev("prompt", T - 600000, "Two agents"), sub(T - 500000, "a"), sub(T - 400000, "b")] } },
      { id: "t1", folder: "local::two", label: "Claude Code", mood: "done", workflow: { events: [ev("prompt", T - 600000, "x"), ev("note", T - 60000, "Done here.")] } },
      { id: "t2", folder: "local::two", label: "Codex", mood: "failed", note: "auth" },
      { id: "h1", folder: "local::three", label: "Claude Code", mood: "waiting", workflow: flow("Ship", "Bash") },
      { id: "r1", folder: "vm::r", label: "Claude Code", mood: "working", workflow: flow("Ping", "Edit server.ts") },
      { id: "r2", folder: "vm::r", label: "Codex", mood: "waiting", workflow: flow("Docker", "Read Dockerfile") },
    ],
    delegations: [],
    shares: [{ from: "local", to: "vm" }],
  };
};

test("blocks take room: nothing one node draws overlaps another, at 25%, 30%, 45% and 60%", () => {
  // With a room too: the other ways of sitting the PCs together (in a row, under this PC) must keep apart as well.
  for (const [data, room] of [input(), busy()].flatMap((d) => [[d, undefined], [d, { w: 2400, h: 500 }], [d, { w: 600, h: 1800 }]] as const)) {
    const m = build(data, undefined, {}, room);
    for (const z of [0.25, 0.3, 0.45, 0.6]) {
      const boxes = m.nodes.flatMap((n) => footprint(n, z).map((b) => ({ id: n.id, b })));
      for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
          const p = boxes[i]!, q = boxes[j]!;
          if (p.id === q.id) continue;
          const meet = p.b.x0 < q.b.x1 && q.b.x0 < p.b.x1 && p.b.y0 < q.b.y1 && q.b.y0 < p.b.y1;
          assert.ok(!meet, `${p.id} and ${q.id} overlap at ${z}`);
        }
      }
    }
    for (const n of m.nodes) for (const b of footprint(n)) assert.ok(b.x0 >= m.bounds.x0 && b.x1 <= m.bounds.x1 && b.y0 >= m.bounds.y0 && b.y1 <= m.bounds.y1, `${n.id} inside the bounds the view fits`);
  }
});

test("a session's rows: running subagents, then the newest three back as blocks; the rest fold into +n 끝남", () => {
  const m = build(busy());
  const subs = m.nodes.filter((n) => n.kind === "sub" && n.session === "b1");
  assert.deepEqual(subs.map((n) => [n.label, n.mood]), [["아직 도는 것", "working"], ["조사 5", "done"], ["조사 4", "done"], ["조사 3", "done"]]);
  assert.equal(subs[1]!.agentType, "Explore");
  assert.equal(subs[1]!.result, "조사 5 끝냈습니다.");
  assert.equal(subs[0]!.since, T - 300000);
  // Two subagents not shown, one calmly closed session.
  assert.equal(m.byId.get("c:local::big")!.count, 3);
  const rows = m.nodes.filter((n) => n.folder === "local::big" && n.kind !== "folder").sort((a, b) => a.y - b.y).map((n) => n.id);
  assert.deepEqual(rows.slice(0, 5), ["s:b1", ...subs.map((n) => n.id)]);
  assert.equal(rows.at(-1), "c:local::big", "the chip last");
  const back = busy();
  back.sessions[0]!.workflow!.events = back.sessions[0]!.workflow!.events.map((e) => (e.kind === "subagent" && e.description === "아직 도는 것" ? { ...e, result: "끝.", resultAt: T } : e));
  assert.equal(build(back).byId.get(subs[0]!.id)!.mood, "done", "a subagent coming back keeps its node");
});

test("a folder's block: what its busiest session is doing, and its counts", () => {
  const m = build(busy());
  assert.match(m.byId.get("f:local::big")!.doing!, /^지도를 다시 그려 줘\. .*…$/);
  assert.equal(Array.from(m.byId.get("f:local::big")!.doing!).length, 80);
  assert.deepEqual(m.byId.get("f:local::big")!.stat, { sessions: 4, working: 1, waiting: 1, done: 6 });
  assert.equal(m.byId.get("f:local::two")!.doing, undefined, "nothing running: counts only");
  assert.equal(m.byId.get("f:local::one")!.stat, undefined, "a merged pill has its session's lines instead");
});

test("a share read one way flows one way; read both ways it says so", () => {
  const one = build(busy()).edges.find((e) => e.kind === "share")!;
  assert.deepEqual([one.from, one.to, one.both], ["h:local", "h:vm", undefined]);
  const both = build({ ...busy(), shares: [{ from: "vm", to: "local" }, { from: "local", to: "vm" }] }).edges.filter((e) => e.kind === "share");
  assert.equal(both.length, 1);
  assert.equal(both[0]!.both, true);
});

test("a worktree's folder is joined to its original's by a branch edge", () => {
  const base = input();
  const m = build({ ...base, folders: base.folders.map((f) => (f.id === "local::c" ? { ...f, worktreeOf: "local::a" } : f)) });
  assert.deepEqual(m.edges.filter((e) => e.kind === "branch").map((e) => [e.from, e.to, e.live]), [["f:local::a", "f:local::c", false]]);
  assert.equal(build(base).edges.some((e) => e.kind === "branch"), false);
});

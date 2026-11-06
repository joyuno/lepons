import { test } from "node:test";
import assert from "node:assert/strict";

import type { MapInput } from "./model.ts";

// Just enough of a browser for the view, panel and painter to run under node:
// elements keep what is set on them and their listeners, a 2D context
// swallows every call, animation frames wait until the test flushes them,
// and the theme's variables answer per <html data-theme>.
type Listener = (event: Record<string, unknown>) => void;
class FakeElement {
  [key: string]: unknown;
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  listeners = new Map<string, Listener[]>();
  classes = new Set<string>();
  classList = {
    toggle: (name: string, on?: boolean) => { const v = on ?? !this.classes.has(name); if (v) this.classes.add(name); else this.classes.delete(name); return v; },
    add: (name: string) => this.classes.add(name),
    remove: (name: string) => this.classes.delete(name),
    contains: (name: string) => this.classes.has(name),
  };
  hidden = false;
  textContent = "";
  innerHTML = "";
  clientWidth = 1400;
  clientHeight = 860;
  width = 0;
  height = 0;
  addEventListener(type: string, run: Listener) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), run]); }
  removeEventListener() {}
  append(...items: unknown[]) { for (const item of items) if (typeof item === "string") this.textContent += item; }
  replaceChildren() {}
  setAttribute(name: string, value: string) { this[`@${name}`] = value; }
  setPointerCapture() {}
  getBoundingClientRect() { return { left: 0, top: 0 }; }
  querySelector() { return null; }
  getContext() { return new Proxy({}, { get: (target: Record<string | symbol, unknown>, key) => (key in target ? target[key] : () => ({ width: 0, addColorStop() {} })), set: () => true }); }
  fire(type: string, event: Record<string, unknown> = {}) { for (const run of this.listeners.get(type) ?? []) run({ preventDefault() {}, button: 0, pointerId: 1, clientX: 0, clientY: 0, type, ...event }); }
}
let frames: Array<(now: number) => void> = [];
const flush = () => { for (let i = 0; i < 5 && frames.length; i++) { const now = frames; frames = []; for (const run of now) run(performance.now() + 10000); } };
let themeChanged: () => void = () => {};
const store = new Map<string, string>();
const root = new FakeElement();
const created: FakeElement[] = [];
const vars: Record<"light" | "dark", Record<string, string>> = {
  dark: { "--ground": "#11161d", "--panel": "#171e26", "--go": "#3fb950", "--live": "#e8a33d" },
  light: { "--ground": "#f3f4f6", "--panel": "#e9ebef", "--go": "#1a7f37", "--live": "#b8720f" },
};
Object.assign(globalThis, {
  window: { devicePixelRatio: 1 },
  document: {
    hidden: false, body: new FakeElement(), documentElement: root,
    createElement() { const el = new FakeElement(); created.push(el); return el; },
    addEventListener() {}, removeEventListener() {},
  },
  getComputedStyle: () => ({ getPropertyValue: (name: string) => vars[root.dataset["theme"] === "light" ? "light" : "dark"][name] ?? "" }),
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  ResizeObserver: class { observe() {} disconnect() {} },
  MutationObserver: class { constructor(run: () => void) { themeChanged = run; } observe() {} disconnect() {} },
  requestAnimationFrame: (run: (now: number) => void) => frames.push(run),
  cancelAnimationFrame() {},
  localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) },
});

const { createWorkflowMap } = await import("./view.ts");
const { build, footprint, ZOOM_MIN } = await import("./model.ts");
const { ease, Painter, themeFrom } = await import("./paint.ts");

const T = Date.now();
const input = (waiting = 2): MapInput => ({
  now: T,
  pcs: [{ id: "local", label: "이 PC", local: true }],
  folders: [{ id: "local::a", pc: "local", label: "lepons" }, { id: "local::b", pc: "local", label: "web" }],
  sessions: [
    { id: "local::a", folder: "local::a", label: "Claude Code", mood: waiting > 0 ? "waiting" : "done", workflow: { events: [{ kind: "prompt", at: T - 60000, text: "Fix the cart" }] } },
    { id: "local::a2", folder: "local::a", label: "Codex", mood: "working", workflow: { events: [{ kind: "action", at: T - 1000, text: "Edit a.ts", labels: ["Edit a.ts"] }] } },
    { id: "local::b", folder: "local::b", label: "Claude Code", mood: waiting > 1 ? "waiting" : "idle" },
  ],
  delegations: [],
  shares: [],
});

function mount(start: MapInput) {
  let data = start;
  const host = new FakeElement();
  const pill = new FakeElement();
  const gone: string[] = [];
  const map = createWorkflowMap(host as unknown as HTMLElement, pill as unknown as HTMLButtonElement, {
    input: () => data,
    show: () => map.setVisible(true),
    goTo: (id) => gone.push(id),
    question: () => ({ text: "Proceed?", options: [{ n: 1, label: "Yes" }, { n: 2, label: "No" }] }),
    history: () => [],
    translate: async (text) => ({ ok: true, text }),
  });
  return { map, host, pill, gone, set: (next: MapInput) => (data = next) };
}

test("the title bar pill counts waiting sessions while the map is closed, and hides while it is open", () => {
  const { map, pill, set } = mount(input(2));
  map.refresh();
  assert.equal(pill.hidden, false);
  assert.match(pill.textContent, /2/);
  map.setVisible(true);
  assert.equal(pill.hidden, true, "the map's own strip says it while open");
  map.setVisible(false);
  set(input(0));
  map.refresh();
  assert.equal(pill.hidden, true);
  set(input(1));
  map.refresh();
  assert.equal(pill.hidden, false);
});

test("the pill opens the map on the next waiting session, round and round, with its panel", () => {
  const { map, pill } = mount(input(2));
  map.refresh();
  pill.fire("click");
  flush();
  assert.equal(map.state().selected, "s:local::a", "a session in a two-session folder: its own pill");
  assert.equal(map.state().panel, true);
  pill.fire("click");
  assert.equal(map.state().selected, "f:local::b", "a single-session folder: the merged pill");
  pill.fire("click");
  assert.equal(map.state().selected, "s:local::a");
  assert.equal(map.escape(), true, "Esc closes the panel first");
  assert.equal(map.state().panel, false);
  assert.equal(map.escape(), false, "then there is nothing left for the map to close");
});

test("double-clicking a hub focuses its branch; Esc goes back to everything", () => {
  const { map, host } = mount(input(1));
  map.setVisible(true);
  flush();
  const hub = build(input(1)).byId.get("h:local")!;
  const { view } = map.state();
  const canvas = created.findLast((el) => el.listeners.has("dblclick"))!;
  canvas.fire("dblclick", { clientX: hub.x * view.zoom + view.tx, clientY: hub.y * view.zoom + view.ty });
  assert.equal(map.state().focus, "h:local");
  assert.equal(map.escape(), true);
  assert.equal(map.state().focus, null);
  void host;
});

test("a theme switch re-reads the app's colours and repaints, but only while the map is on screen", () => {
  const { map } = mount(input(1));
  root.dataset["theme"] = "dark";
  map.setVisible(true);
  flush();
  const before = map.state();
  assert.equal(before.bg, "#11161d", "the darker surface is the ground");
  root.dataset["theme"] = "light";
  themeChanged();
  flush();
  const after = map.state();
  assert.equal(after.themeReads, before.themeReads + 1);
  assert.equal(after.bg, "#e9ebef", "light: the darker of ground and panel");
  assert.ok(after.renders > before.renders, "the scene was drawn again");
  map.setVisible(false);
  root.dataset["theme"] = "dark";
  themeChanged();
  assert.equal(map.state().themeReads, after.themeReads, "closed: nothing is read until it opens");
  map.setVisible(true);
  assert.equal(map.state().bg, "#11161d", "opening picks up a switch made while it was closed");
});

test("the layout runs once per structure: a mood change repaints without laying out again", () => {
  const { map, set } = mount(input(1));
  map.setVisible(true);
  const runs = map.state().laidOut;
  set(input(0));
  map.refresh();
  assert.equal(map.state().laidOut, runs);
  const more = input(0);
  more.sessions.push({ id: "local::b2", folder: "local::b", label: "Codex", mood: "working" });
  set(more);
  map.refresh();
  assert.equal(map.state().laidOut, runs + 1);
});

test("자동 관전 is remembered, and turning it on brings the newest active session into view", () => {
  store.delete("workflowMapFollow");
  const { map } = mount(input(1));
  map.setVisible(true);
  const follow = created.findLast((el) => el.className === "wmTog")!;
  const before = map.state().view;
  follow.fire("click");
  flush();
  assert.equal(map.state().follow, true);
  assert.equal(store.get("workflowMapFollow"), "1");
  assert.notDeepEqual(map.state().view, before);
  const again = mount(input(1));
  assert.equal(again.map.state().follow, true);
});

const canvasOf = () => created.findLast((el) => el.listeners.has("dblclick"))!;
const twoPcs = (): MapInput => {
  const data = input(1);
  data.pcs.push({ id: "vm", label: "ubuntu-vm" });
  data.folders.push({ id: "vm::r", pc: "vm", label: "relay" });
  data.sessions.push({ id: "vm::r", folder: "vm::r", label: "Claude Code", mood: "working" });
  return data;
};
/** The overview's room in the 1400x860 window: its thin margins, under the strip. */
const ROOM = { w: 1360, h: 786 };
/** Whether the model's whole box is on the visible map (left of no panel, below the strip). */
function fits(map: { state(): { view: { zoom: number; tx: number; ty: number } } }, data: MapInput) {
  const b = build(data, undefined, {}, ROOM).bounds, v = map.state().view;
  return b.x0 * v.zoom + v.tx >= 0 && b.x1 * v.zoom + v.tx <= 1400 && b.y0 * v.zoom + v.ty >= 44 && b.y1 * v.zoom + v.ty <= 860;
}

test("the overview keeps fitting every constellation as PCs arrive, until the operator moves it; ⛶ fits all again", () => {
  const { map, set } = mount(input(1));
  map.setVisible(true);
  flush();
  assert.ok(map.state().view.zoom <= 1, "a small map is never blown past 100%");
  set(twoPcs());
  map.refresh();
  flush();
  assert.ok(fits(map, twoPcs()), "a PC that arrived after the first open is fitted in too");
  canvasOf().fire("wheel", { deltaY: -300, clientX: 700, clientY: 400 });
  const mine = map.state().view;
  const more = twoPcs();
  more.folders.push({ id: "vm::s", pc: "vm", label: "site" });
  set(more);
  map.refresh();
  assert.deepEqual(map.state().view, mine, "the operator's own zoom is kept");
  map.setVisible(false);
  map.setVisible(true);
  assert.deepEqual(map.state().view, mine, "and kept across closing and reopening");
  created.findLast((el) => el.textContent === "⛶")!.fire("click");
  flush();
  assert.ok(fits(map, more));
});

test("dragged offsets of removed folders are pruned; closing gives back the scene bitmaps", () => {
  store.set("workflowMapOffsets", JSON.stringify({ "f:local::a": { x: 10, y: 0 }, "f:gone::x": { x: 5, y: 5 } }));
  const { map } = mount(input(1));
  map.setVisible(true);
  assert.deepEqual(Object.keys(JSON.parse(store.get("workflowMapOffsets")!)), ["f:local::a"]);
  const canvas = canvasOf();
  assert.ok((canvas.width as number) > 0);
  map.setVisible(false);
  assert.equal(canvas.width, 0);
  map.setVisible(true);
  assert.ok((canvas.width as number) > 0);
  store.delete("workflowMapOffsets");
});

test("the map opens at 30%, where blocks read; a map too big for that zooms out only as far as its PCs and folders need", () => {
  const { map } = mount(input(1));
  map.setVisible(true);
  flush();
  assert.equal(map.state().view.zoom, 0.3);
  const many = input(1);
  for (let i = 0; i < 14; i++) {
    many.folders.push({ id: `local::m${i}`, pc: "local", label: `folder-${i}` });
    many.sessions.push({ id: `local::m${i}`, folder: `local::m${i}`, label: "Claude Code", mood: "working", workflow: { events: [{ kind: "prompt", at: T, text: "goal" }, { kind: "action", at: T, text: "Edit x", labels: ["Edit x"] }] } });
  }
  const big = mount(many);
  big.map.setVisible(true);
  flush();
  const v = big.map.state().view;
  assert.ok(v.zoom < 0.3);
  allOnScreen(many, v);
});

/** Every box every node draws (pills, blocks, columns) inside the window under the strip, at the view's zoom. */
function allOnScreen(data: MapInput, v: { zoom: number; tx: number; ty: number }) {
  for (const n of build(data, undefined, {}, ROOM).nodes) {
    for (const b of footprint(n, v.zoom)) {
      const [x0, x1, y0, y1] = [b.x0 * v.zoom + v.tx, b.x1 * v.zoom + v.tx, b.y0 * v.zoom + v.ty, b.y1 * v.zoom + v.ty];
      assert.ok(x0 >= 0 && x1 <= 1400 && y0 >= 44 && y1 <= 860, `${n.id} on screen: ${x0.toFixed(0)}..${x1.toFixed(0)}, ${y0.toFixed(0)}..${y1.toFixed(0)} at z=${v.zoom.toFixed(3)}`);
    }
  }
}

/**
 * Three PCs as the prototype's fixture has them: this PC with folders on
 * both sides and subagents out to the left, a Mac with a long column of
 * sessions, a VM with two.
 */
function threePcs(): MapInput {
  const at = T - 60000;
  const working = (id: string, folder: string, subs = 0): MapInput["sessions"][number] => ({
    id, folder, label: "Claude Code", mood: "working",
    workflow: { title: `${id} 작업`, events: [{ kind: "prompt", at: at - 600000, text: "목표를 정리해 주세요" }, ...Array.from({ length: subs }, (_, i) => ({ kind: "subagent" as const, at: at - 300000, description: `조사 ${i}`, instructions: "look" })), { kind: "action", at, text: "Edit a.ts", labels: ["Edit a.ts"] }] },
  });
  const done = (id: string, folder: string): MapInput["sessions"][number] => ({ id, folder, label: "Claude Code", mood: "done", workflow: { title: `${id} 정리`, events: [{ kind: "prompt", at: at - 600000, text: "고쳐 주세요" }, { kind: "note", at, text: "고쳤습니다." }] } });
  return {
    now: T,
    pcs: [{ id: "local", label: "이 PC", local: true, state: "live", os: "Windows" }, { id: "mac", label: "맥북", state: "live" }, { id: "vm", label: "ubuntu-vm", state: "connecting" }],
    folders: [
      { id: "local::lepons", pc: "local", label: "lepons" }, { id: "local::digest", pc: "local", label: "ai-tech-digest" },
      { id: "local::poc", pc: "local", label: "demo-app" }, { id: "local::dot", pc: "local", label: "dotfiles" },
      { id: "mac::ios", pc: "mac", label: "lepons-ios" }, { id: "mac::web", pc: "mac", label: "lepons-web" },
      { id: "vm::relay", pc: "vm", label: "relay-server" },
    ],
    sessions: [
      working("local::lepons", "local::lepons", 2), done("local::lepons2", "local::lepons"), done("local::lepons3", "local::lepons"), done("local::lepons4", "local::lepons"), done("local::lepons5", "local::lepons"),
      working("local::digest", "local::digest", 2), working("local::poc", "local::poc"), done("local::poc2", "local::poc"), done("local::dot", "local::dot"),
      working("mac::ios", "mac::ios", 1), done("mac::ios2", "mac::ios"), done("mac::ios3", "mac::ios"), done("mac::ios4", "mac::ios"), done("mac::web", "mac::web"),
      working("vm::relay", "vm::relay"), done("vm::relay2", "vm::relay"),
    ],
    delegations: [], shares: [],
  };
}

test("the opening view shows every node whole, centred: at 30% when it fits there, the PCs sat together to make it fit", () => {
  const data = threePcs();
  const { map } = mount(data);
  map.setVisible(true);
  flush();
  const v = map.state().view;
  allOnScreen(data, v);
  const b = build(data, undefined, {}, ROOM).bounds;
  const fitsAt30 = (b.x1 - b.x0) * 0.3 <= ROOM.w && (b.y1 - b.y0) * 0.3 <= ROOM.h;
  if (fitsAt30) assert.equal(v.zoom, 0.3);
  else assert.ok(v.zoom < 0.3);
  // Centred: as much room left as right, above as below (under the strip).
  const [l, r, t, u] = [b.x0 * v.zoom + v.tx, 1400 - (b.x1 * v.zoom + v.tx), b.y0 * v.zoom + v.ty - 44, 860 - (b.y1 * v.zoom + v.ty)];
  assert.ok(Math.abs(l - r) < 1 && Math.abs(t - u) < 1, `centred: ${l} ${r} ${t} ${u}`);
  // Laid out for the window: shown larger than the PCs stacked side by side would be.
  const side = build(data).bounds;
  assert.ok(v.zoom > Math.min(ROOM.w / (side.x1 - side.x0), ROOM.h / (side.y1 - side.y0)), "sitting the PCs together for the window shows them larger");
});

test("a map that fits nowhere near 30% zooms out under the old 12% floor rather than leave a folder off screen", () => {
  const data = input(1);
  for (let i = 0; i < 90; i++) {
    data.folders.push({ id: `local::m${i}`, pc: "local", label: `folder-${i}` });
    data.sessions.push({ id: `local::m${i}`, folder: `local::m${i}`, label: "Claude Code", mood: "working", workflow: { events: [{ kind: "prompt", at: T, text: "goal" }, { kind: "action", at: T, text: "Edit x", labels: ["Edit x"] }] } });
  }
  const { map } = mount(data);
  map.setVisible(true);
  flush();
  const v = map.state().view;
  assert.ok(v.zoom < ZOOM_MIN, `zoom ${v.zoom}`);
  allOnScreen(data, v);
});

/** Nothing working, waiting, shared or handed off: nothing on it moves. */
const still = (): MapInput => ({ ...input(0), sessions: input(0).sessions.map((s) => ({ ...s, mood: "done" as const })) });

test("the frame loop runs only while something moves: still map idles, a share or a working session keeps it going", () => {
  frames = [];
  const { map, set } = mount(still());
  map.setVisible(true);
  flush();
  assert.equal(frames.length, 0, "nothing moves: no frame is asked for");
  const shared = twoPcs();
  shared.sessions = shared.sessions.map((s) => ({ ...s, mood: "done" as const }));
  shared.shares = [{ from: "local", to: "vm" }];
  set(shared);
  map.refresh();
  flush();
  assert.ok(frames.length > 0, "a share's dashes flow");
  set(input(1));
  map.refresh();
  flush();
  assert.ok(frames.length > 0, "working and waiting sessions move");
  map.setVisible(false);
  frames = [];
  map.refresh();
  flush();
  assert.equal(frames.length, 0, "closed: no frames");
});

test("reduced motion: nothing animates and the loop stops, the map still drawn", () => {
  const saved = globalThis.matchMedia;
  Object.assign(globalThis, { matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }) });
  try {
    frames = [];
    const busy = twoPcs();
    busy.shares = [{ from: "local", to: "vm" }];
    busy.delegations = [{ id: "d", from: "local", toFolder: "vm::r", running: true }];
    const { map, set } = mount(busy);
    map.setVisible(true);
    flush();
    assert.equal(frames.length, 0);
    const before = map.state().renders;
    assert.ok(before > 0, "drawn once");
    const more = twoPcs();
    more.sessions.push({ id: "local::new", folder: "local::b", label: "Codex", mood: "working" });
    set(more);
    map.refresh();
    flush();
    assert.equal(frames.length, 0, "a new node does not bloom either");
  } finally {
    Object.assign(globalThis, { matchMedia: saved });
  }
});

test("a node that appears blooms in for a moment; the nodes there at first open do not", () => {
  frames = [];
  const { map, set } = mount(still());
  map.setVisible(true);
  flush();
  assert.equal(frames.length, 0, "first open: no bloom");
  const more = still();
  more.sessions.push({ id: "local::b2", folder: "local::b", label: "Codex", mood: "done" });
  set(more);
  map.refresh();
  const r0 = map.state().renders;
  // One frame at bloom time redraws the scene and asks for another...
  const now = frames;
  frames = [];
  for (const run of now) run(performance.now());
  assert.ok(map.state().renders > r0);
  assert.ok(frames.length > 0, "still blooming");
  // ...and once it is over, the loop stops.
  flush();
  assert.equal(frames.length, 0);
});

test("a node gone (or off screen) before its bloom ends does not keep the loop re-rendering", () => {
  frames = [];
  const { map, set } = mount(still());
  map.setVisible(true);
  flush();
  const more = still();
  more.sessions.push({ id: "local::b2", folder: "local::b", label: "Codex", mood: "done" });
  set(more);
  map.refresh();
  // Removed before any frame drew it: its bloom never reaches the paint loop's own clean-up.
  set(still());
  map.refresh();
  flush();
  assert.equal(frames.length, 0, "the loop stops");
});

/** Where a node sits on screen in an open map: built the way the view builds it, under the view's own transform. */
function onScreen(map: { state(): { view: { zoom: number; tx: number; ty: number } } }, data: MapInput, id: string, offsets = {}) {
  const n = build(data, undefined, offsets, ROOM).byId.get(id)!, v = map.state().view;
  return { clientX: n.x * v.zoom + v.tx, clientY: n.y * v.zoom + v.ty };
}
const savedSpots = () => JSON.parse(store.get("workflowMapOffsets") ?? "{}") as Record<string, { x: number; y: number }>;

test("a long press lifts a project; the drag moves it, its release keeps it, and no panel opens", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  store.delete("workflowMapOffsets");
  const data = input(1);
  const { map } = mount(data);
  map.setVisible(true);
  flush();
  const canvas = canvasOf(), at = onScreen(map, data, "f:local::a"), view = { ...map.state().view };
  canvas.fire("pointerdown", at);
  t.mock.timers.tick(349);
  assert.equal(map.state().lifted, null);
  t.mock.timers.tick(1);
  assert.equal(map.state().lifted, "f:local::a");
  canvas.fire("pointermove", { clientX: at.clientX + 60, clientY: at.clientY + 30 });
  canvas.fire("pointerup", { clientX: at.clientX + 60, clientY: at.clientY + 30 });
  flush();
  assert.equal(map.state().lifted, null);
  assert.equal(map.state().selected, null, "a long press is not a click");
  assert.deepEqual(map.state().view, view, "the map itself did not pan");
  const z = view.zoom;
  assert.deepEqual(savedSpots(), { "f:local::a": { x: 60 / z, y: 30 / z } });
  // A map opened later (a restart) draws it there, sessions included: a press lands on it at the new place.
  const again = mount(data);
  again.map.setVisible(true);
  flush();
  const moved = onScreen(again.map, data, "f:local::a", savedSpots());
  canvasOf().fire("pointerdown", moved);
  t.mock.timers.tick(350);
  assert.equal(again.map.state().lifted, "f:local::a");
  canvasOf().fire("pointerup", moved);
  store.delete("workflowMapOffsets");
});

test("new data mid-drag leaves the lifted project under the pointer", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  store.delete("workflowMapOffsets");
  const data = input(1);
  const { map, set } = mount(data);
  map.setVisible(true);
  flush();
  const canvas = canvasOf(), at = onScreen(map, data, "f:local::a");
  const to = { clientX: at.clientX + 90, clientY: at.clientY + 45 };
  canvas.fire("pointerdown", at);
  t.mock.timers.tick(350);
  canvas.fire("pointermove", to);
  set({ ...data, now: data.now + 1000 });
  map.refresh();
  flush();
  canvas.fire("pointerup", to);
  flush();
  canvas.fire("pointerdown", to);
  t.mock.timers.tick(350);
  assert.equal(map.state().lifted, "f:local::a", "still under the pointer, and hit there");
  canvas.fire("pointerup", to);
  store.delete("workflowMapOffsets");
});

test("a plain drag from a project pans; it never lifts or saves, however long it goes on", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  store.delete("workflowMapOffsets");
  const data = input(1);
  const { map } = mount(data);
  map.setVisible(true);
  flush();
  const canvas = canvasOf(), at = onScreen(map, data, "f:local::a"), tx = map.state().view.tx;
  canvas.fire("pointerdown", at);
  canvas.fire("pointermove", { clientX: at.clientX + 40, clientY: at.clientY });
  t.mock.timers.tick(1000);
  assert.equal(map.state().lifted, null);
  assert.equal(map.state().view.tx, tx + 40);
  canvas.fire("pointerup", { clientX: at.clientX + 40, clientY: at.clientY });
  assert.deepEqual(savedSpots(), {});
});

test("a click on a project still selects it, a wheel during a press calls the lift off, and a press on a PC moves it at once as before", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  store.delete("workflowMapOffsets");
  const data = input(1);
  const { map } = mount(data);
  map.setVisible(true);
  flush();
  const canvas = canvasOf(), merged = onScreen(map, data, "f:local::b");
  canvas.fire("pointerdown", merged);
  canvas.fire("pointerup", merged);
  t.mock.timers.tick(1000);
  assert.equal(map.state().selected, "f:local::b");
  assert.equal(map.state().lifted, null);
  map.escape();
  flush();

  canvas.fire("pointerdown", merged);
  canvas.fire("wheel", { deltaY: -1, ...merged });
  t.mock.timers.tick(1000);
  assert.equal(map.state().lifted, null, "a pinch is not a long press");
  canvas.fire("pointerup", merged);
  map.escape();
  flush();

  const hub = onScreen(map, data, "h:local"), tx = map.state().view.tx;
  canvas.fire("pointerdown", hub);
  assert.equal(map.state().lifted, null);
  canvas.fire("pointermove", { clientX: hub.clientX + 30, clientY: hub.clientY });
  canvas.fire("pointerup", { clientX: hub.clientX + 30, clientY: hub.clientY });
  assert.equal(map.state().view.tx, tx, "the view stays");
  assert.ok(savedSpots()["h:local"], "the PC moved and was saved");
  store.delete("workflowMapOffsets");
});

test("the one curve is the app's: quick off the mark, settling, and exact at both ends", () => {
  assert.equal(ease(-1), 0);
  assert.equal(ease(1.5), 1);
  assert.ok(ease(0.25) > 0.5 && ease(0.5) > 0.85 && ease(0.75) > 0.97, "cubic-bezier(0.2, 0, 0, 1)");
  for (let p = 0; p < 1; p += 0.05) assert.ok(ease(p + 0.05) >= ease(p), "only ever forward");
});

test("a subagent that starts sends one dot along its edge, gone once it arrives; one there from the start, or under reduced motion, sends none", () => {
  const data = (subagent: boolean): MapInput => ({ ...input(0), sessions: [{ id: "local::a", folder: "local::a", label: "Claude Code", mood: "working", workflow: { events: [{ kind: "prompt", at: T - 60000, text: "Fix the cart" }, ...(subagent ? [{ kind: "subagent" as const, at: T, description: "look", instructions: "" }] : [])] } }] });
  const dots = (p: unknown) => (p as { anims: Array<{ flow: number }> }).anims.filter((a) => a.flow === 3).length;
  const painter = (first: MapInput) => {
    const p = new Painter(new FakeElement() as unknown as HTMLCanvasElement, build(first, undefined, {}, ROOM), themeFrom(() => "", true), { fresh: "", folded: () => "", agent: (s) => s, hub: ["", "", "", ""], block: { running: "", under: "", minutes: "", hours: "", done: "", sessions: "", working: "", waiting: "", doneToday: "" } });
    p.resize(1400, 860, 1);
    p.view = { zoom: 0.6, tx: 700, ty: 400 };
    return p;
  };
  const started = painter(data(false));
  started.frame(performance.now());
  started.setModel(build(data(true), undefined, {}, ROOM));
  started.frame(performance.now());
  assert.equal(dots(started), 1);
  started.frame(performance.now() + 400);
  assert.equal(dots(started), 0, "arrived: nothing left to draw each frame");
  const already = painter(data(true));
  already.frame(performance.now());
  assert.equal(dots(already), 0);
  const calm = painter(data(false));
  calm.reduced = true;
  calm.setModel(build(data(true), undefined, {}, ROOM));
  calm.frame(performance.now());
  assert.equal(dots(calm), 0);
  const away = painter(data(false));
  away.frame(performance.now());
  away.release();
  away.setModel(build(data(true), undefined, {}, ROOM));
  away.frame(performance.now());
  assert.equal(dots(away), 0, "it started while nobody was looking");
});

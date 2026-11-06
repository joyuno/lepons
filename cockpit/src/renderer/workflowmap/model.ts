import { forceCollide, forceLink, forceSimulation, forceX } from "d3-force";
import type { SessionWorkflow } from "../../shared/ipc.ts";
import { chars, doingOf, finishedSubagents, finishedToday, oneLine, pcCounts, runningSubagents, sentences, summarize, type FolderCounts, type PcCounts } from "./summary.ts";

/*
 * The workflow map without a canvas: what is on it and where it sits, in
 * world units. No DOM here; paint.ts turns it into pixels.
 *
 * Each PC is a constellation of its own (spec 10.1): hub -> folder -> session
 * -> subagent, this PC first. A folder with one session is one pill (10.2).
 * Pills and their summary blocks are NOT world-sized (see nodeScale): they
 * are drawn at a size on screen, so the layout makes room for them at the
 * smallest zoom that still draws them (30%), where they take the most world.
 * Rows stack, and whole folders (pill, block and column) are pushed apart
 * after the force layout, so nothing drawn at pill zoom overlaps.
 */

export type Mood = "working" | "waiting" | "done" | "failed" | "idle";

export interface MapSession {
  /** The session key. */
  id: string;
  folder: string;
  label: string;
  mood: Mood;
  /** Why it is not running (closed, failed): said instead of its old record's story. */
  note?: string;
  /** Has steps the operator has not seen on the map yet. */
  fresh?: boolean;
  workflow?: SessionWorkflow;
}

/** A PC's OS, for the chip by its name; absent when not known. */
export type PcOs = "Windows" | "macOS" | "Linux";
/** A PC's connection, as the rail's lamp says it: its hub's ring. */
export type PcLamp = "live" | "connecting" | "failed" | "off";

export interface MapInput {
  now: number;
  /** `status`: the PC's state in words, for its panel; `state`: the same for its ring. */
  pcs: Array<{ id: string; label: string; local?: boolean; status?: string; state?: PcLamp; os?: PcOs }>;
  folders: Array<{ id: string; pc: string; label: string }>;
  sessions: MapSession[];
  /** PC-to-PC handoffs, from the handing PC to the folder it went to. */
  delegations: Array<{ id: string; from: string; toFolder: string; running: boolean; instructions?: string; at?: number }>;
  /** PCs reading each other's folders: `from` owns the folder, `to` reads it. */
  shares: Array<{ from: string; to: string }>;
}

export type NodeKind = "hub" | "folder" | "merged" | "session" | "sub" | "chip";
/** A line under a pill: `at` puts a time before it; `agent` words it as a subagent step. */
export interface Line { at?: number; text: string; agent?: boolean; faint?: boolean }
export interface MNode {
  id: string;
  kind: NodeKind;
  pc: string;
  label: string;
  /** hub/folder/merged: centre. session/sub/chip: middle of the edge facing the folder. */
  x: number;
  y: number;
  /** +1: the branch grows right; -1: left. */
  side: 1 | -1;
  parent?: string;
  mood?: Mood;
  fresh?: number;
  /** On a path to something working: its edge is tinted. */
  live?: boolean;
  /** The summary under the pill (spec 11.1). */
  lines?: Line[];
  /** sub: what it was handed, whole (the hover tip). */
  instr?: string;
  /** sub: its kind of agent ("Explore"), when the record says. */
  agentType?: string;
  /** sub: when it was sent out. */
  since?: number;
  /** sub, back: the first sentence of what it said. */
  result?: string;
  /** folder: what its busiest session is doing, and its counts (its block). */
  doing?: string;
  stat?: FolderCounts;
  /** chip: how many are folded. */
  count?: number;
  /** session/merged/sub: the session key. */
  session?: string;
  folder?: string;
  local?: boolean;
  /** hub: its PC line, connection and OS. */
  counts?: PcCounts;
  state?: PcLamp;
  os?: PcOs;
}
/** `both`: a share read both ways. */
export interface MEdge { from: string; to: string; kind: "tree" | "loop" | "delegation" | "share"; live: boolean; both?: boolean }
export interface Cluster { id: string; pc: string; fx: number; fy: number; side: 1 | -1; colX: number; top: number; bottom: number; activity: number }
export interface Box { x0: number; y0: number; x1: number; y1: number }
/** Folder positions per PC, kept while the PC's structure holds. */
type Placement = { key: string; at: Map<string, { x: number; y: number }> };
export interface MapModel {
  nodes: MNode[];
  edges: MEdge[];
  byId: Map<string, MNode>;
  clusters: Cluster[];
  bounds: Box;
  placements: Map<string, Placement>;
  /** Whether this build ran the force layout for any PC. */
  laidOut: boolean;
  /** The input's clock: a running subagent's time out is counted to it. */
  now: number;
}

export const ZOOM_MIN = 0.12;
export const ZOOM_MAX = 2;
/** The map opens (and ⛶ fits) at this zoom when every folder fits there. */
export const ZOOM_HOME = 0.3;
export type Level = "dots" | "pills" | "detail";
/** Pills and their blocks from 25%; under that, dots and names. */
export const level = (z: number): Level => (z < 0.25 ? "dots" : z <= 0.6 ? "pills" : "detail");
/**
 * Pill size factor: pills grow slower than the map (27px at 34%, 30px at
 * 50%). Under 30% they shrink with the map, so they never take more world
 * than at 30%, the zoom the layout makes room for.
 */
export const nodeScale = (z: number): number => (z < ZOOM_HOME ? Math.pow(ZOOM_HOME / 0.34, 0.3) * (z / ZOOM_HOME) : Math.min(1.15, Math.pow(z / 0.34, 0.3)));

/**
 * Sizes on screen in px at nodeScale 1: paint.ts draws to them, the layout
 * makes room for them. A block is at most `blockW` wide and two lines tall.
 */
export const PX = { pill: 26, gap: 5, line: 16, padY: 5, padX: 8, blockW: 220, indent: 12, sub: 0.95, rowGap: 8, chip: 20, hubR: 24 };
export const blockH = (lines: number): number => (lines ? PX.padY * 2 + PX.line * lines : 0);
/** At and under 30% a size on screen takes the most world (see nodeScale). */
const Z_PILLS = ZOOM_HOME;
/** World units `px` takes on screen at zoom `z`. */
const wu = (px: number, z = Z_PILLS) => (px * nodeScale(z)) / z;

// ---- layout constants (world units), tight enough that a few PCs' folders all show at 30%
const FOLDER_R = wu(150); // hub centre -> folder centre
const COL_DX = wu(110); // folder centre -> column's inner edge, at least
const SUB_INSET = wu(30); // subagents sit this far back toward the folder
const PACK_GAP = wu(40);
const WIDE = /[ᄀ-ᇿ⺀-꓏가-힯豈-﫿︰-﹏＀-｠￠-￦]/;
/** Rough width of text on screen in px: wide (CJK, Hangul) characters an em, the rest a little over half. Room is made from it; paint measures. */
export const estW = (text: string, size: number): number => chars(text).reduce((w, ch) => w + (WIDE.test(ch) ? 1 : 0.62), 0) * size;
/** A pill's width on screen (paint.ts pillNode): pads, dot, the name clipped as paint clips it, a "New" badge. */
const pillW = (n: Pick<MNode, "kind" | "label" | "fresh">) => 39 + Math.min(n.kind === "folder" || n.kind === "merged" ? 220 : 250, estW(n.label, 12.5)) + (n.fresh ? 48 : 0);
/** Lines in a pill's block: a folder's doing and counts, else its summary lines. */
export const blockLines = (n: Pick<MNode, "kind" | "lines" | "doing" | "stat">): number =>
  n.kind === "folder" ? (n.doing ? 1 : 0) + (n.stat && (n.stat.sessions || n.stat.working || n.stat.waiting || n.stat.done) ? 1 : 0) : n.lines?.length ?? 0;
/** A row's height for what it draws on screen, and how far down it its node sits. */
const row = (px: number, at: number) => ({ h: wu(px + PX.rowGap), mid: wu(PX.rowGap / 2 + at) });

/**
 * What a node draws at pill zoom `z`, as world boxes: its pill (or card,
 * circle, chip) and its block. paint.ts draws inside these; the layout keeps
 * them apart at 30%, where they are largest.
 */
export function footprint(n: MNode, z = Z_PILLS): Box[] {
  const u = (px: number) => wu(px, z);
  const box = (x0: number, y0: number, x1: number, y1: number): Box => ({ x0: Math.min(x0, x1), y0, x1: Math.max(x0, x1), y1 });
  const { x, y, side } = n;
  if (n.kind === "hub") {
    // Its circle, and its name (with its OS chip) under it. Its PC line (45%+) is drawn only where it is clear, so takes no room.
    const half = u(Math.max(PX.hubR + 3, (Math.min(220, estW(n.label, 12.5)) + (n.os ? 16 + estW(n.os, 10) : 0)) / 2));
    return [box(x - half, y - u(PX.hubR + 3), x + half, y + u(PX.hubR + 20))];
  }
  if (n.kind === "chip") return [box(x, y - u(PX.chip / 2), x + side * u(30 + estW("+00 finished", 11.5)), y + u(PX.chip / 2))];
  if (n.kind === "sub") return [box(x, y - u(blockH(2) * PX.sub) / 2, x + side * u(PX.blockW * PX.sub), y + u(blockH(2) * PX.sub) / 2)];
  const w = u(pillW(n)), top = y - u(PX.pill / 2), under = y + u(PX.pill / 2 + PX.gap);
  const lines = blockLines(n);
  if (n.kind === "session") {
    const out = [box(x, top, x + side * w, y + u(PX.pill / 2))];
    if (lines) out.push(box(x + side * u(PX.indent), under, x + side * u(PX.indent + PX.blockW), under + u(blockH(lines))));
    return out;
  }
  // Folder, merged: the pill centred; the block under it grows toward the hub, away from its column.
  const out = [box(x - w / 2, top, x + w / 2, y + u(PX.pill / 2))];
  if (lines) out.push(box(x + side * w / 2, under, x + side * (w / 2 - u(PX.blockW)), under + u(blockH(lines))));
  return out;
}

const order: Record<Mood, number> = { working: 0, waiting: 1, failed: 2, done: 3, idle: 4 };
const newest = (s: MapSession) => s.workflow?.events.at(-1)?.at ?? 0;

/**
 * The lines under a pill (spec 11.1). Working and waiting: what it is doing
 * now, then what it was asked. Resting: what came of it. A session that is
 * not running says why instead of retelling its last record.
 */
export function linesOf(s: MapSession): Line[] {
  if (s.note !== undefined) return s.mood === "failed" ? [{ text: oneLine(s.note, 60), faint: true }] : [];
  const sum = summarize(s.workflow);
  if (s.mood === "working" || s.mood === "waiting") {
    const out: Line[] = [];
    if (sum.now) out.push({ at: sum.now.at, text: sum.now.text, ...(sum.now.kind === "subagent" ? { agent: true } : {}) });
    if (sum.goal) out.push({ text: oneLine(sum.goal, 40), faint: true });
    return out;
  }
  if (s.mood === "done" && sum.result) return [{ text: sentences(sum.result, 1, 80), faint: true }];
  return [];
}

/** How busy a folder looks: steps in the last quarter hour, more while working. 0..~1.3. */
function activityOf(sessions: MapSession[], now: number): number {
  let a = 0;
  for (const s of sessions) {
    const recent = (s.workflow?.events ?? []).filter((e) => now - e.at < 15 * 60000).length;
    a += Math.min(1, recent / 12) + (s.mood === "working" ? 0.3 : 0);
  }
  return Math.min(1.3, a);
}

interface Row { node: Omit<MNode, "x" | "y" | "side">; h: number; mid: number; inset?: number }
/** Finished subagents shown under a session; the rest fold into its folder's "+n 끝남". */
const SHOWN_BACK = 3;

/**
 * Lays the input out; a PC whose folders and sessions are the same as in
 * `previous` keeps its folders where they were. `room`: the map's room on
 * screen in px, which picks how the PCs' constellations sit together.
 */
export function build(input: MapInput, previous?: MapModel, offsets: Record<string, { x: number; y: number }> = {}, room?: { w: number; h: number }): MapModel {
  const nodes: MNode[] = [];
  const edges: MEdge[] = [];
  const clusters: Cluster[] = [];
  const placements = new Map<string, Placement>();
  let laidOut = false;
  const consts: Array<{ pc: string; nodes: MNode[]; boxes: Box[] }> = [];

  // This PC's constellation first, whatever order the input has them in.
  const pcs = [...input.pcs].sort((a, b) => Number(!!b.local) - Number(!!a.local));
  for (const pc of pcs) {
    const folders = input.folders.filter((f) => f.pc === pc.id);
    const mineSessions = input.sessions.filter((s) => folders.some((f) => f.id === s.folder));
    const hub: MNode = { id: `h:${pc.id}`, kind: "hub", pc: pc.id, label: pc.label, x: 0, y: 0, side: 1, ...(pc.local ? { local: true } : {}), ...(pc.state ? { state: pc.state } : {}), ...(pc.os ? { os: pc.os } : {}), counts: pcCounts(mineSessions, input.now) };
    const mine: MNode[] = [hub];
    const cols = folders.map((f) => {
      const all = mineSessions.filter((s) => s.folder === f.id).sort((a, b) => order[a.mood] - order[b.mood] || newest(b) - newest(a));
      const merged = all.length === 1 ? all[0] : undefined;
      // Sessions closed calmly fold into "+n 오늘 끝" with the subagents that came back.
      const open = merged ? [] : all.filter((s) => s.mood !== "idle");
      const rows: Row[] = [];
      let shownToday = 0;
      const addSubs = (s: MapSession, parent: string) => {
        if (s.mood !== "working" && s.mood !== "waiting") return;
        const events = s.workflow?.events ?? [];
        const back = finishedSubagents(s.workflow).slice(0, SHOWN_BACK);
        shownToday += finishedToday(back, input.now);
        for (const e of [...runningSubagents(s.workflow), ...back]) {
          const done = e.result !== undefined;
          const node: Row["node"] = {
            // By its place in the record: the same subagent keeps its node when it comes back.
            id: `a:${s.id}:${events.indexOf(e)}`, kind: "sub", pc: pc.id, label: e.description.trim() || oneLine(e.instructions, 80), instr: e.instructions,
            ...(e.agentType ? { agentType: e.agentType } : {}), since: e.at, ...(done && e.result ? { result: sentences(e.result, 1, 80) } : {}),
            mood: done ? "done" : s.mood === "working" ? "working" : "idle", parent, live: !done && s.mood === "working", session: s.id, folder: f.id,
          };
          rows.push({ node, ...row(blockH(2) * PX.sub, (blockH(2) * PX.sub) / 2), inset: SUB_INSET });
        }
      };
      for (const s of open) {
        const lines = linesOf(s);
        const label = s.workflow?.title ? oneLine(s.workflow.title, 60) : s.label;
        rows.push({ node: { id: `s:${s.id}`, kind: "session", pc: pc.id, label, mood: s.mood, ...(s.fresh ? { fresh: 1 } : {}), parent: `f:${f.id}`, live: s.mood === "working", ...(lines.length ? { lines } : {}), session: s.id, folder: f.id }, ...row(PX.pill + (lines.length ? PX.gap + blockH(lines.length) : 0), PX.pill / 2) });
        addSubs(s, `s:${s.id}`);
      }
      if (merged) addSubs(merged, `f:${f.id}`);
      const folded = (merged ? 0 : all.length - open.length) + all.reduce((n, s) => n + finishedToday(s.workflow?.events ?? [], input.now), 0) - shownToday;
      if (folded > 0) rows.push({ node: { id: `c:${f.id}`, kind: "chip", pc: pc.id, label: "", count: folded, parent: `f:${f.id}`, folder: f.id }, ...row(PX.chip, PX.chip / 2) });
      const height = rows.reduce((a, r) => a + r.h, 0);
      const mergedLines = merged ? linesOf(merged) : [];
      const fresh = open.filter((s) => s.fresh).length;
      const busiest = all[0] && (all[0].mood === "working" || all[0].mood === "waiting") ? doingOf(all[0].workflow) : undefined;
      const { working, waiting, done } = pcCounts(all, input.now);
      const fnode: MNode = merged
        ? { id: `f:${f.id}`, kind: "merged", pc: pc.id, label: f.label, x: 0, y: 0, side: 1, parent: hub.id, mood: merged.mood, ...(merged.fresh ? { fresh: 1 } : {}), live: merged.mood === "working", session: merged.id, folder: f.id, ...(mergedLines.length ? { lines: mergedLines } : {}) }
        : { id: `f:${f.id}`, kind: "folder", pc: pc.id, label: f.label, x: 0, y: 0, side: 1, parent: hub.id, ...(fresh ? { fresh } : {}), live: open.some((s) => s.mood === "working"), folder: f.id, ...(busiest ? { doing: busiest } : {}), stat: { sessions: all.length, working, waiting, done } };
      // The column clears its folder's pill: subagents (set back toward the folder) included.
      const half = wu(pillW(fnode)) / 2;
      const dx = Math.max(fnode.kind === "merged" && !rows.length ? COL_DX * 0.8 : COL_DX, half + wu(24) + (rows.some((r) => r.inset) ? SUB_INSET : 0));
      // Everything the folder draws, relative to its centre, for a column growing right (mirrored for the left).
      const lines = blockLines(fnode);
      const colW = Math.max(wu(PX.indent + PX.blockW), ...rows.map((r) => (r.node.kind === "session" ? wu(pillW(r.node)) : 0)));
      const ext: Box = {
        x0: Math.min(-half, half - (lines ? wu(PX.blockW) : 0), rows.length ? dx - SUB_INSET : 0),
        x1: Math.max(half, rows.length ? dx + colW : 0),
        y0: Math.min(-wu(PX.pill / 2), -height / 2),
        y1: Math.max(wu(PX.pill / 2 + (lines ? PX.gap + blockH(lines) : 0)), height / 2),
      };
      return { f, rows, height, dx, ext, activity: activityOf(all, input.now), fnode, sessions: all.map((s) => s.id), r: Math.max(wu(40), (ext.y1 - ext.y0) / 2 + wu(12)) };
    });

    // The force layout runs only when the PC's folders or their sessions changed.
    const key = JSON.stringify(cols.map((c) => [c.f.id, c.sessions]));
    const kept = previous?.placements.get(pc.id);
    let forced: Map<string, { x: number; y: number }>;
    if (kept?.key === key) forced = kept.at;
    else {
      forced = place(hub.id, cols);
      laidOut = true;
    }
    placements.set(pc.id, { key, at: forced });
    // Blocks grow and shrink with moods and steps: what they draw is kept apart on every build, from the same start.
    const at = separate(hub, cols, forced);

    for (const c of cols) {
      const p = at.get(c.fnode.id) ?? { x: FOLDER_R, y: 0 };
      const side = p.x >= 0 ? 1 : -1;
      Object.assign(c.fnode, { x: p.x, y: p.y, side });
      mine.push(c.fnode);
      edges.push({ from: hub.id, to: c.fnode.id, kind: "tree", live: !!c.fnode.live });
      const colX = p.x + side * c.dx;
      let y = p.y - c.height / 2;
      for (const r of c.rows) {
        const n: MNode = { ...r.node, x: colX - side * (r.inset ?? 0), y: y + r.mid, side } as MNode;
        mine.push(n);
        edges.push({ from: n.parent!, to: n.id, kind: n.kind === "sub" && n.parent!.startsWith("s:") ? "loop" : "tree", live: !!n.live });
        y += r.h;
      }
      clusters.push({ id: c.f.id, pc: pc.id, fx: p.x, fy: p.y, side, colX, top: p.y - c.height / 2, bottom: p.y + c.height / 2, activity: c.activity });
    }
    consts.push({ pc: pc.id, nodes: mine, boxes: mine.flatMap((n) => footprint(n)) });
  }

  const shifts = arrange(consts.map((c) => c.boxes), room);
  consts.forEach((c, i) => {
    const [dx, dy] = shifts[i]!;
    for (const n of c.nodes) { n.x += dx; n.y += dy; }
    for (const k of clusters) if (k.pc === c.pc) { k.fx += dx; k.fy += dy; k.colX += dx; k.top += dy; k.bottom += dy; }
    nodes.push(...c.nodes);
  });

  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const d of input.delegations) {
    const a = byId.get(`h:${d.from}`), b = byId.get(`f:${d.toFolder}`);
    if (a && b) edges.push({ from: a.id, to: b.id, kind: "delegation", live: d.running });
  }
  const pairs = new Map<string, MEdge>();
  for (const s of input.shares) {
    if (s.from === s.to || !byId.has(`h:${s.from}`) || !byId.has(`h:${s.to}`)) continue;
    const pair = [s.from, s.to].sort().join("\0");
    const seen = pairs.get(pair);
    if (seen) { if (seen.from !== `h:${s.from}`) seen.both = true; continue; }
    const e: MEdge = { from: `h:${s.from}`, to: `h:${s.to}`, kind: "share", live: false };
    pairs.set(pair, e);
    edges.push(e);
  }

  const model: MapModel = { nodes, edges, byId, clusters, bounds: { x0: 0, y0: 0, x1: 0, y1: 0 }, placements, laidOut, now: input.now };
  // Where the operator dragged things: hubs first, so a folder's own offset lands on top of its PC's.
  const ids = Object.keys(offsets).filter((id) => byId.has(id)).sort((a, b) => Number(b.startsWith("h:")) - Number(a.startsWith("h:")));
  for (const id of ids) shiftBranch(model, id, offsets[id]!.x, offsets[id]!.y);
  model.bounds = nodes.length ? boxOf(model, new Set(nodes.map((n) => n.id))) : { x0: -400, y0: -300, x1: 400, y1: 300 };
  return model;
}

/** Everything some nodes draw at 30%, one box. */
const unionOf = (ns: Iterable<MNode>): Box => hull([...ns].flatMap((n) => footprint(n)));
function hull(bs: Box[], dx = 0, dy = 0): Box {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const b of bs) { x0 = Math.min(x0, b.x0); y0 = Math.min(y0, b.y0); x1 = Math.max(x1, b.x1); y1 = Math.max(y1, b.y1); }
  return { x0: x0 + dx, y0: y0 + dy, x1: x1 + dx, y1: y1 + dy };
}
const moved = (bs: Box[], dx: number, dy: number): Box[] => bs.map((b) => ({ x0: b.x0 + dx, y0: b.y0 + dy, x1: b.x1 + dx, y1: b.y1 + dy }));

/**
 * How far boxes `mine` must move along x (or y) to sit past every box of
 * `placed` they would otherwise meet, PACK_GAP apart: they slide in as close
 * as what is drawn allows, not just past the other's whole box.
 */
function clearOf(placed: Box[], mine: Box[], axis: "x" | "y"): number {
  let d = -Infinity;
  for (const q of mine) {
    for (const p of placed) {
      const meet = axis === "x" ? q.y0 < p.y1 + PACK_GAP && p.y0 < q.y1 + PACK_GAP : q.x0 < p.x1 + PACK_GAP && p.x0 < q.x1 + PACK_GAP;
      if (meet) d = Math.max(d, axis === "x" ? p.x1 + PACK_GAP - q.x0 : p.y1 + PACK_GAP - q.y0);
    }
  }
  if (d > -Infinity) return d;
  const a = hull(placed), b = hull(mine);
  return axis === "x" ? a.x1 + PACK_GAP - b.x0 : a.y1 + PACK_GAP - b.y0;
}

/**
 * Where each PC's constellation goes (a shift per constellation; this PC's
 * first, at the origin). Three ways: the others stacked to its right, in a
 * row under it, or all in one row; with `room` (px on screen) the one shown
 * largest there wins, ties to the earlier. Each slides in against what is
 * already placed.
 */
function arrange(consts: Box[][], room?: { w: number; h: number }): Array<[number, number]> {
  if (consts.length < 2) return consts.map(() => [0, 0]);
  const [first, ...rest] = consts;
  const mid = (b: Box, axis: "x" | "y") => (axis === "x" ? (b.x0 + b.x1) / 2 : (b.y0 + b.y1) / 2);
  /** The rest one after another along `axis`, each slid against those before it; then the group centred on this PC's across it, and slid against it. */
  const group = (axis: "x" | "y"): Array<[number, number]> => {
    const across = axis === "x" ? "y" : "x";
    const out: Array<[number, number]> = [];
    const placed: Box[] = [];
    for (const c of rest) {
      const ac = -mid(hull(c), across);
      const base: [number, number] = axis === "x" ? [0, ac] : [ac, 0];
      const d = placed.length ? clearOf(placed, moved(c, ...base), axis) : 0;
      const at: [number, number] = axis === "x" ? [d, ac] : [ac, d];
      out.push(at);
      placed.push(...moved(c, ...at));
    }
    // A row (along x) sits under this PC centred on it; a stack (along y) to its right, centred on it.
    const shift = mid(hull(first!), axis) - mid(hull(placed), axis);
    const centred = out.map(([x, y]): [number, number] => (axis === "x" ? [x + shift, y] : [x, y + shift]));
    const all = centred.flatMap(([x, y], i) => moved(rest[i]!, x, y));
    const d = clearOf(first!, all, across);
    return [[0, 0], ...centred.map(([x, y]): [number, number] => (across === "x" ? [x + d, y] : [x, y + d]))];
  };
  /** All in one row: each slid against everything before it, centred on this PC's middle. */
  const row = (): Array<[number, number]> => {
    const out: Array<[number, number]> = [[0, 0]];
    const placed = [...first!];
    const cy = mid(hull(first!), "y");
    for (const c of rest) {
      const dy = cy - mid(hull(c), "y"), dx = clearOf(placed, moved(c, 0, dy), "x");
      out.push([dx, dy]);
      placed.push(...moved(c, dx, dy));
    }
    return out;
  };
  const ways = [group("y"), ...(room ? [group("x"), row()] : [])];
  const fit = (way: Array<[number, number]>) => {
    const b = hull(way.flatMap(([x, y], i) => moved(consts[i]!, x, y)));
    return Math.min(room!.w / (b.x1 - b.x0), room!.h / (b.y1 - b.y0));
  };
  return room ? ways.reduce((best, way) => (fit(way) > fit(best) * 1.01 ? way : best)) : ways[0]!;
}

/** Folder centres around a hub: each side's folders fanned out, then untangled by d3-force. */
function place(hubId: string, cols: Array<{ fnode: MNode; r: number }>): Map<string, { x: number; y: number }> {
  // Sides: biggest columns first, each to the lighter side; the first goes right.
  const load = { 1: 0, [-1]: 0 } as Record<1 | -1, number>;
  const sideOf = new Map<string, 1 | -1>();
  for (const c of [...cols].sort((a, b) => b.r - a.r)) {
    const s: 1 | -1 = load[1] <= load[-1] ? 1 : -1;
    sideOf.set(c.fnode.id, s);
    load[s] += c.r * 2;
  }
  type SimN = { id: string; x: number; y: number; r: number; side: 1 | -1; fx?: number; fy?: number };
  const sim: SimN[] = [{ id: hubId, x: 0, y: 0, r: wu(30), side: 1, fx: 0, fy: 0 }];
  for (const s of [1, -1] as const) {
    const mine = cols.filter((c) => sideOf.get(c.fnode.id) === s);
    mine.forEach((c, i) => {
      const a = mine.length === 1 ? 0 : -1.05 + (2.1 * i) / (mine.length - 1);
      sim.push({ id: c.fnode.id, x: s * Math.cos(a) * FOLDER_R, y: Math.sin(a) * FOLDER_R * 1.25, r: c.r, side: s });
    });
  }
  // d3-force only untangles: links hold the ring, collide keeps columns apart, forceX keeps each side.
  forceSimulation(sim)
    .force("link", forceLink<SimN, { source: string; target: SimN | string }>(sim.slice(1).map((n) => ({ source: hubId, target: n.id }))).id((d) => d.id).distance(FOLDER_R).strength(0.6))
    .force("collide", forceCollide<SimN>((d) => d.r).strength(0.9).iterations(3))
    .force("x", forceX<SimN>((d) => d.side * FOLDER_R * 0.8).strength(0.12))
    .stop()
    .tick(300);
  return new Map(sim.slice(1).map((n) => [n.id, { x: n.x, y: n.y }]));
}

/**
 * Collide sees circles; what a folder draws (pill, block, column) is a box.
 * Boxes that still meet, the hub's included, move apart vertically: the hub
 * stays, of two folders the outer one moves outward.
 */
function separate(hub: MNode, cols: Array<{ fnode: MNode; ext: Box }>, forced: Map<string, { x: number; y: number }>): Map<string, { x: number; y: number }> {
  const units = [
    { id: hub.id, n: { x: 0, y: 0 }, rel: unionOf([hub]), fixed: true },
    ...cols.map((c) => {
      const n = { ...(forced.get(c.fnode.id) ?? { x: FOLDER_R, y: 0 }) }, e = c.ext;
      // A column growing left is the right one mirrored.
      return { id: c.fnode.id, n, rel: n.x >= 0 ? e : { x0: -e.x1, x1: -e.x0, y0: e.y0, y1: e.y1 }, fixed: false };
    }),
  ];
  const GAP = wu(10);
  for (let pass = 0; pass < 100; pass++) {
    let moved = false;
    for (let i = 0; i < units.length; i++) {
      for (let j = i + 1; j < units.length; j++) {
        const a = units[i]!, b = units[j]!;
        if (a.n.x + a.rel.x1 + GAP <= b.n.x + b.rel.x0 || b.n.x + b.rel.x1 + GAP <= a.n.x + a.rel.x0) continue;
        const bBelow = b.n.y > a.n.y || (b.n.y === a.n.y && j > i);
        const over = bBelow ? a.n.y + a.rel.y1 + GAP - (b.n.y + b.rel.y0) : b.n.y + b.rel.y1 + GAP - (a.n.y + a.rel.y0);
        if (over <= 0) continue;
        const moveB = a.fixed || (!b.fixed && Math.abs(b.n.y) >= Math.abs(a.n.y));
        if (moveB) b.n.y += bBelow ? over : -over;
        else a.n.y += bBelow ? -over : over;
        moved = true;
      }
    }
    if (!moved) break;
  }
  return new Map(units.slice(1).map((u) => [u.id, u.n]));
}

/** A hub's or folder's branch: it and everything under it. */
export function branchOf(m: Pick<MapModel, "nodes">, id: string): Set<string> {
  const out = new Set([id]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const n of m.nodes) if (n.parent && out.has(n.parent) && !out.has(n.id)) { out.add(n.id); grew = true; }
  }
  return out;
}

/** Moves a hub or folder with everything under it, clouds included (a drag, or a saved offset). */
export function shiftBranch(m: MapModel, id: string, dx: number, dy: number): void {
  const ids = branchOf(m, id);
  for (const n of m.nodes) if (ids.has(n.id)) { n.x += dx; n.y += dy; }
  for (const k of m.clusters) if (ids.has(`f:${k.id}`)) { k.fx += dx; k.fy += dy; k.colX += dx; k.top += dy; k.bottom += dy; }
}

/** World box of a set of nodes: everything they draw at pill zoom, with a margin. */
export function boxOf(m: Pick<MapModel, "byId">, ids: Set<string>): Box {
  const b = unionOf([...ids].flatMap((id) => m.byId.get(id) ?? []));
  const pad = wu(16);
  return { x0: b.x0 - pad, y0: b.y0 - pad, x1: b.x1 + pad, y1: b.y1 + pad };
}

/** The waiting session after `current`, round and round, for the "확인 필요" pill. */
export function nextWaiting(input: Pick<MapInput, "sessions">, current?: string): string | undefined {
  const waiting = input.sessions.filter((s) => s.mood === "waiting").map((s) => s.id);
  if (waiting.length === 0) return undefined;
  return waiting[(waiting.indexOf(current ?? "") + 1) % waiting.length];
}

/** The map node that shows a session: its own pill, or its folder's merged one. */
export function nodeOfSession(m: MapModel, session: string): MNode | undefined {
  return m.byId.get(`s:${session}`) ?? m.nodes.find((n) => n.kind === "merged" && n.session === session);
}

/** Seeded RNG (mulberry32): the same folder always gets the same cloud. */
export function rng(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const hash = (s: string) => [...s].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) | 0, 7);

/**
 * A cluster's particle cloud in world units, relative to the folder: a fan
 * from the folder toward its column, densest a third of the way out, plus a
 * thin halo. Count follows activity.
 */
export function cloud(c: Cluster, perActivity = 1100): Float32Array {
  const r = rng(hash(c.id));
  const n = Math.round(70 + c.activity * perActivity);
  const out = new Float32Array(n * 3); // dx, dy, alpha
  const span = c.colX - c.fx;
  const halfH = Math.max(220, (c.bottom - c.top) / 2);
  const g = () => (r() + r() + r() - 1.5) / 1.5; // ~normal in [-1, 1]
  for (let i = 0; i < n; i++) {
    const halo = r() < 0.22;
    const t = halo ? r() * 1.6 - 0.45 : -0.3 + Math.pow(r(), 0.9) * 1.25;
    const spread = halo ? halfH * 1.5 : 50 + halfH * Math.min(1.1, Math.max(0.15, t * 1.3));
    out[i * 3] = span * t + (halo ? g() * 200 : g() * 60);
    out[i * 3 + 1] = g() * spread;
    out[i * 3 + 2] = halo ? 0.3 + r() * 0.35 : 0.45 + r() * 0.55;
  }
  return out;
}

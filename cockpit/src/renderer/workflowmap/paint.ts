import { agentBlock, chars, folderBlock, type BlockWords } from "./summary.ts";
import { blockH, blockLines, cloud, level, nodeScale, PX, type Cluster, type Line, type MapModel, type MEdge, type MNode, type Mood } from "./model.ts";

/*
 * Canvas painter. One cached scene per view (pills and words drawn first,
 * then edges, clouds, stars and ground slid in behind them with
 * destination-over, so edges can leave pills measured in the same pass), and
 * on top of it what changes per frame, each only where it means something:
 * dashes flowing along PC-to-PC shares and running handoffs, a soft
 * dot travelling into each working session, one small dot along the edge of a
 * subagent that has just started, and a pulse round each waiting ring, and a
 * dashed ring turning slowly round each PC still connecting.
 * Lines and dots run under the pills (a clip leaves the pills out).
 * A node that appears blooms in, re-rendering the scene for a quarter
 * second. A pan or zoom re-renders the scene once; an idle map with
 * something moving costs one blit and a few strokes and sprite draws a
 * frame, and allocates nothing. Under reduced motion nothing moves and the
 * frames stop.
 *
 * Colours are the app's own (spec 11): themeFrom() reads Lepons' CSS
 * variables, the same ones the rail's lamps use.
 */

export interface Theme {
  dark: boolean;
  bg: string; edge: string; edgeLive: string; deleg: string; share: string;
  fill: string; border: string; borderLive: string; borderWait: string; shadow: string;
  text: string; muted: string; working: string; glow: string; waiting: string; failed: string; idle: string; done: string;
  hubFill: string; hubRing: string; hubRingLocal: string;
  particle: string; star: string; card: string; tlTime: string; tlText: string; badgeBg: string; badgeText: string;
  capsule: string; sans: string; mono: string;
}

/** "r,g,b" from a CSS colour as custom properties hold it (#rgb, #rrggbb, rgb(), rgba()). Grey when unreadable. */
export function rgbOf(colour: string): [number, number, number] {
  const c = colour.trim();
  let m = /^#([0-9a-f]{3})$/i.exec(c);
  if (m) return [...m[1]!].map((d) => parseInt(d + d, 16)) as [number, number, number];
  m = /^#([0-9a-f]{6})/i.exec(c);
  if (m) return [0, 2, 4].map((i) => parseInt(m![1]!.slice(i, i + 2), 16)) as [number, number, number];
  const f = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(c);
  if (f) return [Number(f[1]), Number(f[2]), Number(f[3])];
  return [128, 128, 128];
}
const trip = (c: string) => rgbOf(c).join(",");
const lum = (c: string) => { const [r, g, b] = rgbOf(c); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
/** `a` moved toward `b` by `t`. */
const mix = (a: string, b: string, t: number) => { const x = rgbOf(a), y = rgbOf(b); return `rgb(${x.map((v, i) => Math.round(v + (y[i]! - v) * t)).join(",")})`; };

/**
 * The map's colours from the app's theme variables. Pills sit on the lighter
 * of the two surfaces and the ground on the darker, so they read raised in
 * either theme without a colour of their own.
 */
export function themeFrom(v: (name: string) => string, dark: boolean): Theme {
  const ground = v("--ground"), panel = v("--panel"), raise = v("--raise"), line = v("--line"), text = v("--text"), muted = v("--muted");
  const go = v("--go"), live = v("--live"), stop = v("--stop"), idle = v("--idle"), link = v("--link");
  const [bg, fill] = lum(ground) <= lum(panel) ? [ground, panel] : [panel, ground];
  return {
    dark,
    bg, fill, edge: mix(line, muted, 0.3), edgeLive: mix(go, bg, 0.35), deleg: link, share: `rgba(${trip(muted)},${dark ? 0.55 : 0.6})`,
    border: line, borderLive: mix(go, fill, 0.25), borderWait: live, shadow: dark ? "rgba(0,0,0,.5)" : "rgba(0,0,0,.14)",
    text, muted, working: go, glow: trip(go), waiting: live, failed: stop, idle, done: go,
    hubFill: raise, hubRing: muted, hubRingLocal: text,
    particle: trip(text), star: trip(muted), card: `rgba(${trip(fill)},${dark ? 0.86 : 0.9})`, tlTime: text, tlText: muted, badgeBg: text, badgeText: bg,
    capsule: `rgba(${trip(bg)},.9)`,
    sans: v("--sans") || '"Pretendard Variable", "Segoe UI", sans-serif',
    mono: v("--mono") || '"JetBrains Mono", Consolas, monospace',
  };
}

/** The words the canvas writes, in the app's language. */
export interface Words {
  fresh: string;
  folded(n: number): string;
  agent(text: string): string;
  hub: [working: string, waiting: string, done: string, subagents: string];
  /** The summary blocks words, as templates (summary.ts fills them). */
  block: BlockWords;
}

export interface View { zoom: number; tx: number; ty: number }
/** `r`: its corner radius, so lines drawn over the scene can pass under its exact shape. */
interface Hit { id: string; x: number; y: number; w: number; h: number; r: number }
/**
 * A line or dot redrawn every frame, in screen px: a quadratic (cx2 unused)
 * or cubic from (x1, y1) to (x2, y2). `flow`: 0 a share's slow dashes, 1 a
 * running handoff's fast ones, 2 a dot travelling into a working session,
 * 3 the one dot of a subagent starting (`phase`: when it set off).
 */
interface Anim { flow: 0 | 1 | 2 | 3; cubic: boolean; x1: number; y1: number; cx1: number; cy1: number; cx2: number; cy2: number; x2: number; y2: number; both: boolean; phase: number; alpha: number }
/** Constant dash patterns: a frame sets them without making arrays. */
const DASH_SHARE = [3, 6], DASH_DELEG = [6, 5], DASH_SPIN = [5, 4], NO_DASH: number[] = [];
const BLOOM_MS = 220, DOT_MS = 1600, PULSE_MS = 1600, TRAVEL_MS = 360, LIFT_MS = 120, LIFT_PX = 3;

/** The app's one curve, cubic-bezier(0.2, 0, 0, 1), for what the canvas moves itself: 0 to 1 over 0 to 1. */
export function ease(p: number): number {
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  // Solve x(t) = p by bisection, then read y(t): x = 3(1-t)²t·0.2 + t³, y = 3(1-t)t² + t³.
  let lo = 0, hi = 1;
  for (let i = 0; i < 20; i++) {
    const t = (lo + hi) / 2;
    if (3 * (1 - t) * (1 - t) * t * 0.2 + t * t * t < p) lo = t; else hi = t;
  }
  const t = (lo + hi) / 2;
  return 3 * (1 - t) * t * t + t * t * t;
}

export const hm = (at: number) => { const d = new Date(at); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };

export class Painter {
  private ctx: CanvasRenderingContext2D;
  private canvas: HTMLCanvasElement;
  private scene = document.createElement("canvas");
  private clouds = new Map<string, { key: string; c: HTMLCanvasElement; ox: number; oy: number }>();
  private starTile: HTMLCanvasElement | null = null;
  private widths = new Map<string, number>();
  private hits: Hit[] = [];
  private hubLines: Array<{ n: MNode; x: number; y: number; k: number }> = [];
  private anims: Anim[] = [];
  /** What the per-frame lines pass under: x, y, w, h, r of each shape they cross. */
  private covers: number[] = [];
  /** Waiting rings: x, y, r. */
  private waits: number[] = [];
  /** Connecting hubs' rings: x, y, r, line width, alpha. */
  private spins: number[] = [];
  private dotSprite: HTMLCanvasElement | null = null;
  /** Nodes on the map last time, to tell the new ones; null until the first non-empty map (those do not bloom). */
  private known: Set<string> | null = null;
  /** New nodes' first moment (performance.now()). */
  private births = new Map<string, number>();
  /** Subagents just started, when their dot set off (performance.now()). */
  private travels = new Map<string, number>();
  /** Which project the lift below is for, and since when. */
  private liftedAt: { id: string; at: number } | null = null;
  private now = 0;
  private dirty = true;
  /** Pills' half widths as painted, for edges that leave a pill. */
  private halfW = new Map<string, number>();
  /** Particles per unit of activity. */
  density = 1100;
  w = 0; h = 0; dpr = 1;
  view: View = { zoom: 0.34, tx: 0, ty: 0 };
  theme: Theme;
  words: Words;
  model: MapModel;
  focus: Set<string> | null = null;
  selected: string | null = null;
  /** The project being moved: it wears a ring and a drop above everything else. */
  lifted: string | null = null;
  reduced = false;
  /** How many scenes were rendered: tests read it to see a repaint happen. */
  renders = 0;

  constructor(canvas: HTMLCanvasElement, model: MapModel, theme: Theme, words: Words) {
    this.canvas = canvas;
    this.model = model;
    this.theme = theme;
    this.words = words;
    this.ctx = canvas.getContext("2d")!;
    if (model.nodes.length) this.known = new Set(model.nodes.map((n) => n.id));
  }
  invalidate() { this.dirty = true; }
  setTheme(t: Theme) { this.theme = t; this.clouds.clear(); this.starTile = null; this.dotSprite = null; this.widths.clear(); this.dirty = true; }
  setModel(m: MapModel) {
    this.model = m;
    // A cloud is keyed by its shape and activity, so only folders that are gone give theirs back here.
    const ids = new Set(m.clusters.map((c) => c.id));
    for (const id of this.clouds.keys()) if (!ids.has(id)) this.clouds.delete(id);
    if (m.nodes.length) {
      const at = performance.now();
      if (this.known && !this.reduced) for (const n of m.nodes) if (!this.known.has(n.id)) {
        this.births.set(n.id, at);
        if (n.kind === "sub" && n.live) this.travels.set(n.id, at);
      }
      this.known = new Set(m.nodes.map((n) => n.id));
    }
    this.dirty = true;
  }
  resize(w: number, h: number, dpr: number) {
    this.w = w; this.h = h; this.dpr = dpr;
    for (const c of [this.canvas, this.scene]) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
    this.canvas.style.width = `${w}px`; this.canvas.style.height = `${h}px`;
    this.dotSprite = null;
    this.dirty = true;
  }
  /** Drops cached bitmaps (map hidden): they are the bulk of its memory. */
  release() {
    this.clouds.clear(); this.starTile = null; this.dotSprite = null; this.dirty = true;
    // What arrives while it is away did not start in front of anyone.
    this.known = null;
  }
  /** Cached clouds, for tests. */
  get cloudCount() { return this.clouds.size; }

  hit(x: number, y: number): string | null {
    for (let i = this.hits.length - 1; i >= 0; i--) {
      const r = this.hits[i]!;
      if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return r.id;
    }
    return null;
  }

  /** Draws one frame; true while something on screen still moves. */
  frame(now: number): boolean {
    // A 0-wide canvas (not laid out yet, or resized to 0 to give its memory back) has nothing to draw, and drawImage of it throws.
    if (!this.scene.width || !this.scene.height) return false;
    this.now = now;
    // A bloom re-renders the scene each frame it lasts.
    const blooming = this.births.size > 0;
    if (blooming) this.dirty = true;
    // A dot that has arrived leaves the per-frame list, or the frames would never stop.
    for (const [id, at] of this.travels) if (now - at >= TRAVEL_MS) { this.travels.delete(id); this.dirty = true; }
    if (this.dirty) { this.renderLayers(); this.dirty = false; }
    const c = this.ctx;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.drawImage(this.scene, 0, 0);
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    if (this.anims.length) this.drawAnims(c, now);
    if (this.waits.length && !this.reduced) this.drawPulses(c, now);
    if (this.spins.length) this.drawSpins(c, now);
    if (this.liftedAt?.id !== (this.lifted ?? undefined)) this.liftedAt = this.lifted ? { id: this.lifted, at: now } : null;
    const lifting = this.liftedAt !== null && !this.reduced && now - this.liftedAt.at < LIFT_MS;
    if (this.lifted) this.drawLift(c, this.lifted, this.reduced ? LIFT_PX : LIFT_PX * ease((now - this.liftedAt!.at) / LIFT_MS));
    c.setTransform(1, 0, 0, 1, 0, 0);
    return blooming || lifting || (!this.reduced && (this.anims.length > 0 || this.waits.length > 0 || this.spins.length > 0));
  }

  /** A lifted project: what it draws (its pill, and the block under it), picked out and raised `rise` px off the map. */
  private drawLift(c: CanvasRenderingContext2D, id: string, rise: number) {
    const d = this.dpr;
    for (const r of this.hits) {
      if (r.id !== id) continue;
      c.save();
      c.shadowColor = this.theme.shadow; c.shadowBlur = 16; c.shadowOffsetY = 6;
      c.fillStyle = this.theme.fill;
      c.beginPath(); c.roundRect(r.x, r.y - rise, r.w, r.h, r.r); c.fill();
      c.shadowColor = "transparent";
      c.clip();
      c.drawImage(this.scene, r.x * d, r.y * d, r.w * d, r.h * d, r.x, r.y - rise, r.w, r.h);
      c.restore();
    }
    c.strokeStyle = this.theme.text; c.lineWidth = 2.5;
    c.beginPath();
    for (const r of this.hits) if (r.id === id) c.roundRect(r.x - 3, r.y - rise - 3, r.w + 6, r.h + 6, r.r + 3);
    c.stroke();
  }

  /** Shares' and handoffs' dashes, and the dots into working sessions, under every pill they cross. */
  private drawAnims(c: CanvasRenderingContext2D, now: number) {
    const t = this.theme, cv = this.covers;
    c.save();
    if (cv.length) {
      c.beginPath();
      c.rect(0, 0, this.w, this.h);
      for (let i = 0; i < cv.length; i += 5) c.roundRect(cv[i]!, cv[i + 1]!, cv[i + 2]!, cv[i + 3]!, cv[i + 4]!);
      c.clip("evenodd");
    }
    const sec = now / 1000;
    for (let i = 0; i < this.anims.length; i++) {
      const a = this.anims[i]!;
      c.globalAlpha = a.alpha;
      if (a.flow >= 2) {
        if (this.reduced) continue;
        const once = a.flow === 3;
        const p = once ? ease((now - a.phase) / TRAVEL_MS) : (now / DOT_MS + a.phase) % 1, q = 1 - p;
        let x: number, y: number;
        if (a.cubic) {
          x = q * q * q * a.x1 + 3 * q * q * p * a.cx1 + 3 * q * p * p * a.cx2 + p * p * p * a.x2;
          y = q * q * q * a.y1 + 3 * q * q * p * a.cy1 + 3 * q * p * p * a.cy2 + p * p * p * a.y2;
        } else {
          x = q * q * a.x1 + 2 * q * p * a.cx1 + p * p * a.x2;
          y = q * q * a.y1 + 2 * q * p * a.cy1 + p * p * a.y2;
        }
        if (once) {
          c.fillStyle = t.working;
          c.beginPath(); c.arc(x, y, 2.5, 0, Math.PI * 2); c.fill();
          continue;
        }
        // Fades in leaving the parent and out reaching the child.
        c.globalAlpha = a.alpha * Math.sin(p * Math.PI);
        const s = this.dot2();
        c.drawImage(s, x - 7, y - 7, 14, 14);
        continue;
      }
      // Dashes flow from the sharing PC to the reader, or the handing PC to the folder; both ways, they swing back and forth.
      const speed = a.flow === 1 ? 36 : 12;
      let run = (sec + a.phase) * speed;
      if (a.both) { const m = (sec + a.phase) % 8; run = (m < 4 ? m : 8 - m) * speed; }
      c.setLineDash(a.flow === 1 ? DASH_DELEG : DASH_SHARE);
      c.lineDashOffset = this.reduced ? 0 : -run;
      c.strokeStyle = a.flow === 1 ? t.deleg : t.share;
      c.lineWidth = a.flow === 1 ? 1.6 : 1.3;
      c.beginPath();
      c.moveTo(a.x1, a.y1);
      if (a.cubic) c.bezierCurveTo(a.cx1, a.cy1, a.cx2, a.cy2, a.x2, a.y2);
      else c.quadraticCurveTo(a.cx1, a.cy1, a.x2, a.y2);
      c.stroke();
    }
    c.setLineDash(NO_DASH);
    c.lineDashOffset = 0;
    c.globalAlpha = 1;
    c.restore();
  }

  /** A soft light dot: the theme's working colour, fading out from the middle. */
  private dot2(): HTMLCanvasElement {
    if (this.dotSprite) return this.dotSprite;
    const s = document.createElement("canvas");
    s.width = s.height = Math.ceil(14 * this.dpr);
    const x = s.getContext("2d")!;
    x.scale(this.dpr, this.dpr);
    const g = x.createRadialGradient(7, 7, 0, 7, 7, 7);
    g.addColorStop(0, `rgba(${this.theme.glow},1)`);
    g.addColorStop(0.35, `rgba(${this.theme.glow},0.85)`);
    g.addColorStop(1, `rgba(${this.theme.glow},0)`);
    x.fillStyle = g; x.fillRect(0, 0, 14, 14);
    this.dotSprite = s;
    return s;
  }

  /** Each waiting ring breathes out: a second ring grows from it and fades. */
  private drawPulses(c: CanvasRenderingContext2D, now: number) {
    const p = (now % PULSE_MS) / PULSE_MS, w = this.waits;
    c.strokeStyle = this.theme.waiting;
    c.lineWidth = 1.5;
    c.globalAlpha = 0.7 * (1 - p);
    for (let i = 0; i < w.length; i += 3) {
      c.beginPath();
      c.arc(w[i]!, w[i + 1]!, w[i + 2]! * (1 + 0.7 * p), 0, Math.PI * 2);
      c.stroke();
    }
    c.globalAlpha = 1;
  }

  /** A connecting PC's ring: amber dashes going round, once in about eight seconds; still under reduced motion. */
  private drawSpins(c: CanvasRenderingContext2D, now: number) {
    const s = this.spins;
    c.strokeStyle = this.theme.waiting;
    c.setLineDash(DASH_SPIN);
    const turn = this.reduced ? 0 : ((now / 8000) % 1) * Math.PI * 2;
    for (let i = 0; i < s.length; i += 5) {
      c.globalAlpha = s[i + 4]!;
      c.lineWidth = s[i + 3]!;
      c.save();
      c.translate(s[i]!, s[i + 1]!);
      c.rotate(turn);
      c.beginPath(); c.arc(0, 0, s[i + 2]!, 0, Math.PI * 2); c.stroke();
      c.restore();
    }
    c.setLineDash(NO_DASH);
    c.globalAlpha = 1;
  }

  // ---------- helpers
  private sx(n: { x: number }) { return n.x * this.view.zoom + this.view.tx; }
  private sy(n: { y: number }) { return n.y * this.view.zoom + this.view.ty; }
  private measure(c: CanvasRenderingContext2D, font: string, text: string) {
    const key = font + "\u0000" + text;
    let w = this.widths.get(key);
    if (w === undefined) { c.font = font; w = c.measureText(text).width; this.widths.set(key, w); }
    return w;
  }
  private clip(c: CanvasRenderingContext2D, font: string, text: string, max: number) {
    if (this.measure(c, font, text) <= max) return text;
    const g = chars(text);
    let lo = 0, hi = g.length;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (this.measure(c, font, g.slice(0, mid).join("") + "…") <= max) lo = mid; else hi = mid - 1; }
    return g.slice(0, lo).join("").trimEnd() + "…";
  }
  private dim(id: string) { return this.focus !== null && !this.focus.has(id); }

  // ---------- layers
  private renderLayers() {
    this.renders++;
    // Widths are keyed by font, whose size follows the zoom: dropped now and then, or every zoom step keeps its own.
    if (this.widths.size > 4000) this.widths.clear();
    const t = this.theme, z = this.view.zoom, lv = level(z), k = nodeScale(z);
    this.hits = []; this.hubLines = []; this.anims = []; this.waits = []; this.spins = []; this.halfW.clear();
    // Pills first: they measure what the edges leave from. Everything after goes behind them.
    const o = this.scene.getContext("2d")!;
    o.globalCompositeOperation = "source-over";
    o.setTransform(1, 0, 0, 1, 0, 0); o.clearRect(0, 0, this.scene.width, this.scene.height);
    o.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    o.textBaseline = "middle";
    const vis = (n: MNode) => { const x = this.sx(n), y = this.sy(n); return x > -700 && x < this.w + 700 && y > -200 && y < this.h + 200; };
    // A bloom ends by the clock, drawn or not: one off screen or already gone would otherwise re-render every frame for ever.
    for (const [id, born] of this.births) if (this.now - born >= BLOOM_MS || !this.model.byId.has(id)) this.births.delete(id);
    for (const n of this.model.nodes) {
      if (!vis(n)) continue;
      o.globalAlpha = this.dim(n.id) ? 0.2 : 1;
      const born = this.births.get(n.id);
      const p = born === undefined ? 1 : Math.min(1, Math.max(0, (this.now - born) / BLOOM_MS));
      if (p >= 1) this.births.delete(n.id);
      if (p < 1) {
        // Blooms in: from 85% and clear to full size and colour.
        const sc = 0.85 + 0.15 * (1 - Math.pow(1 - p, 3)), x = this.sx(n), y = this.sy(n);
        o.save();
        o.globalAlpha *= p;
        o.translate(x, y); o.scale(sc, sc); o.translate(-x, -y);
      }
      if (lv === "dots") this.dotNode(o, n); else this.pillNode(o, n, k);
      if (p < 1) o.restore();
    }
    // A PC line goes under its hub only where nothing else is: the strip says the same.
    for (const h of this.hubLines) this.hubSummary(o, h.n, h.x, h.y, h.k);
    o.globalAlpha = 1;
    o.globalCompositeOperation = "destination-over";
    for (const e of this.model.edges) this.edge(o, e, lv === "dots", k);
    o.setLineDash([]);
    this.coversFor();
    for (const cl of this.model.clusters) {
      // Only clouds on screen are drawn and kept: off-screen ones give their bitmap back.
      const x0 = (Math.min(cl.fx, cl.colX) - 700) * z + this.view.tx, x1 = (Math.max(cl.fx, cl.colX) + 700) * z + this.view.tx;
      const y0 = (cl.top - 600) * z + this.view.ty, y1 = (cl.bottom + 600) * z + this.view.ty;
      if (x1 < 0 || x0 > this.w || y1 < 0 || y0 > this.h) { this.clouds.delete(cl.id); continue; }
      o.globalAlpha = this.focus && !this.focus.has(`f:${cl.id}`) ? 0.15 : 1;
      this.cloud(o, cl);
    }
    o.globalAlpha = 1;
    this.stars(o);
    o.setTransform(1, 0, 0, 1, 0, 0);
    o.fillStyle = t.bg; o.fillRect(0, 0, this.scene.width, this.scene.height);
    o.globalCompositeOperation = "source-over";
  }

  private stars(c: CanvasRenderingContext2D) {
    const T = 384;
    if (!this.starTile) {
      const s = document.createElement("canvas");
      s.width = s.height = T * this.dpr;
      const x = s.getContext("2d")!;
      x.scale(this.dpr, this.dpr);
      let seed = 99;
      const r = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
      for (let i = 0; i < 26; i++) { x.fillStyle = `rgba(${this.theme.star},${0.12 + r() * 0.3})`; x.fillRect(r() * T, r() * T, 1.1, 1.1); }
      this.starTile = s;
    }
    const ox = ((this.view.tx % T) + T) % T, oy = ((this.view.ty % T) + T) % T;
    for (let x = ox - T; x < this.w; x += T) for (let y = oy - T; y < this.h; y += T) c.drawImage(this.starTile, x, y, T, T);
  }

  /** A cluster's cloud, re-rendered only when the zoom moves by more than ~9%, its shape or activity changes, or the theme does. */
  private cloud(c: CanvasRenderingContext2D, cl: Cluster) {
    const z = this.view.zoom;
    const bucket = Math.round(Math.log2(z) * 8);
    const zb = Math.pow(2, bucket / 8);
    const key = `${bucket}|${Math.round(cl.activity * 20)}|${Math.round(cl.colX - cl.fx)}|${Math.round(cl.bottom - cl.top)}`;
    let e = this.clouds.get(cl.id);
    if (!e || e.key !== key) {
      const pts = cloud(cl, this.density);
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let i = 0; i < pts.length; i += 3) { x0 = Math.min(x0, pts[i]!); x1 = Math.max(x1, pts[i]!); y0 = Math.min(y0, pts[i + 1]!); y1 = Math.max(y1, pts[i + 1]!); }
      const W = Math.ceil((x1 - x0) * zb + 4), H = Math.ceil((y1 - y0) * zb + 4);
      const cv = document.createElement("canvas");
      // Cached at 1x whatever the screen density: grain needs no Retina sharpness, and this quarters its memory at dpr 2.
      cv.width = W; cv.height = H;
      const x = cv.getContext("2d")!;
      const d = this.theme.dark ? 1.2 : 1.35;
      for (let i = 0; i < pts.length; i += 3) {
        x.fillStyle = `rgba(${this.theme.particle},${pts[i + 2]! * (this.theme.dark ? 0.6 : 0.55)})`;
        const q = i % 18 === 0 ? d * 1.5 : d;
        x.fillRect((pts[i]! - x0) * zb + 2, (pts[i + 1]! - y0) * zb + 2, q, q);
      }
      e = { key, c: cv, ox: x0, oy: y0 };
      this.clouds.set(cl.id, e);
    }
    const s = z / zb; // the cached cloud is stretched by under ±5% between buckets
    c.drawImage(e.c, (cl.fx + e.ox) * z + this.view.tx - 2 * s, (cl.fy + e.oy) * z + this.view.ty - 2 * s, e.c.width * s, e.c.height * s);
  }

  // ---------- edges
  private anchorOut(n: MNode): [number, number] {
    const x = this.sx(n), y = this.sy(n);
    if (n.kind === "folder" || n.kind === "merged") return [x + n.side * (this.halfW.get(n.id) ?? 0), y];
    return [x, y];
  }
  private edge(c: CanvasRenderingContext2D, e: MEdge, dots: boolean, k: number) {
    const a = this.model.byId.get(e.from), b = this.model.byId.get(e.to);
    if (!a || !b) return;
    const t = this.theme;
    const dim = this.dim(a.id) || this.dim(b.id);
    c.globalAlpha = dim ? 0.15 : 1;
    c.beginPath();
    if (e.kind === "delegation" || e.kind === "share") {
      const [x1, y1] = [this.sx(a), this.sy(a)], [x2, y2] = [this.sx(b), this.sy(b)];
      const mx = (x1 + x2) / 2, my = (y1 + y2) / 2, bend = 0.12;
      const cx = mx - (y2 - y1) * bend, cy = my + (x2 - x1) * bend;
      // Drawn every frame instead, flowing.
      if (e.kind === "share" || e.live) {
        this.anims.push({ flow: e.kind === "share" ? 0 : 1, cubic: false, x1, y1, cx1: cx, cy1: cy, cx2: 0, cy2: 0, x2, y2, both: !!e.both, phase: 0, alpha: dim ? 0.15 : 1 });
        return;
      }
      c.moveTo(x1, y1);
      c.quadraticCurveTo(cx, cy, x2, y2);
      // A handoff that finished or failed: still, plain.
      c.setLineDash(DASH_DELEG);
      c.strokeStyle = t.edge;
      c.lineWidth = 1;
      c.stroke();
      c.setLineDash(NO_DASH);
      return;
    }
    c.strokeStyle = e.live ? t.edgeLive : t.edge;
    c.lineWidth = e.live ? 1.4 : 0.9;
    // Into a working session: a dot travels it, each its own moment so they do not march in step.
    const travel = !dim && (b.kind === "session" || b.kind === "merged") && b.mood === "working";
    const phase = travel ? (Math.abs(b.y) * 0.013 + Math.abs(b.x) * 0.007) % 1 : 0;
    const setOff = dim ? undefined : this.travels.get(b.id);
    if (a.kind === "hub") {
      // Hub spoke: a gentle quadratic, its ends hidden under the hub and the pill.
      const [x1, y1, x2, y2] = [this.sx(a), this.sy(a), this.sx(b), this.sy(b)];
      const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
      const cx = mx + (y2 - y1) * 0.08, cy = my - (x2 - x1) * 0.08;
      c.moveTo(x1, y1);
      c.quadraticCurveTo(cx, cy, x2, y2);
      if (travel) this.anims.push({ flow: 2, cubic: false, x1, y1, cx1: cx, cy1: cy, cx2: 0, cy2: 0, x2, y2, both: false, phase, alpha: 1 });
    } else if (e.kind === "loop" && !dots) {
      // Session -> its subagent: a C that leaves and enters on the folder side.
      const x1 = this.sx(a), y1 = this.sy(a), x2 = this.sx(b), y2 = this.sy(b);
      const back = Math.min(x1 * a.side, x2 * a.side) * a.side - a.side * 16 * k;
      c.moveTo(x1, y1);
      c.bezierCurveTo(back, y1, back, y2, x2, y2);
      if (setOff !== undefined) this.anims.push({ flow: 3, cubic: true, x1, y1, cx1: back, cy1: y1, cx2: back, cy2: y2, x2, y2, both: false, phase: setOff, alpha: 1 });
    } else {
      const [x1, y1] = dots ? [this.sx(a), this.sy(a)] : this.anchorOut(a);
      const x2 = this.sx(b) + (dots ? b.side * 5 : 0), y2 = this.sy(b);
      const dx = Math.abs(x2 - x1) * 0.5;
      c.moveTo(x1, y1);
      c.bezierCurveTo(x1 + b.side * dx, y1, x2 - b.side * dx, y2, x2, y2);
      if (travel) this.anims.push({ flow: 2, cubic: true, x1, y1, cx1: x1 + b.side * dx, cy1: y1, cx2: x2 - b.side * dx, cy2: y2, x2, y2, both: false, phase, alpha: 1 });
      if (setOff !== undefined) this.anims.push({ flow: 3, cubic: true, x1, y1, cx1: x1 + b.side * dx, cy1: y1, cx2: x2 - b.side * dx, cy2: y2, x2, y2, both: false, phase: setOff, alpha: 1 });
    }
    c.stroke();
  }

  /** The shapes the per-frame lines cross (pills, blocks, hubs), from this scene's hit boxes: only those near a line. */
  private coversFor() {
    const out: number[] = [];
    if (this.anims.length) {
      const boxes = this.anims.map((a) => {
        const xs = [a.x1, a.cx1, a.x2, ...(a.cubic ? [a.cx2] : [])], ys = [a.y1, a.cy1, a.y2, ...(a.cubic ? [a.cy2] : [])];
        return [Math.min(...xs) - 8, Math.min(...ys) - 8, Math.max(...xs) + 8, Math.max(...ys) + 8] as const;
      });
      for (const r of this.hits) {
        if (r.x > this.w || r.y > this.h || r.x + r.w < 0 || r.y + r.h < 0) continue;
        if (boxes.some(([x0, y0, x1, y1]) => r.x < x1 && r.x + r.w > x0 && r.y < y1 && r.y + r.h > y0)) out.push(r.x, r.y, r.w, r.h, r.r);
      }
    }
    this.covers = out;
  }

  // ---------- nodes, dots level (< 30%)
  private dotNode(c: CanvasRenderingContext2D, n: MNode) {
    const t = this.theme, x = this.sx(n), y = this.sy(n);
    if (n.kind === "hub") {
      this.hub(c, n, x, y, 16, 1, `700 11px ${t.sans}`);
      return;
    }
    if (n.kind === "folder" || n.kind === "merged") {
      const mood = n.kind === "merged" ? n.mood! : undefined;
      if (mood === "working") this.dot(c, x, y, "working", 7.5);
      else {
        c.beginPath(); c.arc(x, y, 6, 0, Math.PI * 2);
        c.fillStyle = t.bg; c.fill();
        c.lineWidth = 1.5; c.strokeStyle = mood === "waiting" ? t.waiting : mood === "failed" ? t.failed : t.hubRing; c.stroke();
        if (mood === "waiting" && !this.dim(n.id)) this.waits.push(x, y, 6);
      }
      c.font = `700 11.5px ${t.sans}`; c.fillStyle = t.text; c.textAlign = "center";
      c.fillText(n.label, x, y - 16);
      const fw = this.measure(c, c.font, n.label);
      if (n.fresh) this.badge(c, n.kind === "folder" ? `${this.words.fresh} ${n.fresh}` : this.words.fresh, x + fw / 2 + 6, y - 16, 0.82);
      this.hits.push({ id: n.id, x: x - Math.max(10, fw / 2), y: y - 24, w: Math.max(20, fw), h: 32, r: 6 });
      return;
    }
    const cx = x + n.side * 5;
    if (n.kind === "chip") {
      c.beginPath(); c.arc(cx, y, 3.2, 0, Math.PI * 2);
      c.setLineDash([1.5, 1.5]); c.lineWidth = 1; c.strokeStyle = t.muted; c.stroke(); c.setLineDash([]);
      return;
    }
    const mood = n.mood ?? "idle";
    const big = mood === "working" && n.kind === "session";
    this.dot(c, cx, y, mood, n.kind === "sub" ? 3 : big ? 7 : 4.2);
    if (mood === "waiting" && n.kind === "session" && !this.dim(n.id)) this.waits.push(cx, y, 4.2);
    if (n.kind === "session" && (mood === "working" || mood === "waiting" || n.id === this.selected)) {
      c.font = `500 11.5px ${t.sans}`; c.fillStyle = t.text; c.textAlign = n.side > 0 ? "left" : "right";
      c.fillText(this.clip(c, c.font, n.label, 220), cx + n.side * 15, y + 0.5);
    }
    this.hits.push({ id: n.id, x: cx - 8, y: y - 8, w: 16, h: 16, r: 8 });
  }

  /**
   * A PC hub: a monitor drawn in a fixed-size circle, its name (and OS chip)
   * under it. The ring is its connection, as the rail's lamp: live green,
   * connecting amber dashes going round, failed red, off dimmed. This PC's
   * ring is heavier and carries a dot; another PC's carries a link arrow.
   */
  private hub(c: CanvasRenderingContext2D, n: MNode, x: number, y: number, r: number, k: number, font: string) {
    const t = this.theme, local = n.local ?? false, state = n.state;
    const off = state === "off", a = c.globalAlpha;
    c.save();
    c.shadowColor = t.shadow; c.shadowBlur = 10 * k; c.shadowOffsetY = 2 * k;
    c.beginPath(); c.arc(x, y, r + 2.5 * k, 0, Math.PI * 2); c.fillStyle = t.fill; c.fill();
    c.restore();
    c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2);
    c.fillStyle = t.hubFill; c.fill();
    const lw = (local ? 2.4 : 1.5) * k;
    c.lineWidth = lw;
    if (state === "connecting") {
      // A faint track; the dashes go round it every frame.
      c.globalAlpha = a * 0.25; c.strokeStyle = t.waiting; c.stroke(); c.globalAlpha = a;
      this.spins.push(x, y, r, lw, a);
    } else {
      c.strokeStyle = state === "live" ? t.working : state === "failed" ? t.failed : local ? t.hubRingLocal : t.hubRing;
      if (off) c.globalAlpha = a * 0.45;
      c.stroke();
    }
    // The monitor: a screen, its neck and foot, in the ink of the words.
    const ink = off ? t.muted : t.text;
    const sw = r * 0.98, sh = r * 0.66, sy = y - r * 0.44;
    c.lineWidth = Math.max(1, 1.5 * k); c.strokeStyle = ink; c.lineCap = "round"; c.lineJoin = "round";
    c.beginPath(); c.roundRect(x - sw / 2, sy, sw, sh, r * 0.09); c.stroke();
    c.beginPath();
    c.moveTo(x, sy + sh); c.lineTo(x, sy + sh + r * 0.22);
    c.moveTo(x - r * 0.24, sy + sh + r * 0.24); c.lineTo(x + r * 0.24, sy + sh + r * 0.24);
    c.stroke();
    // Its badge on the ring, lower right: this PC's dot, another PC's arrow out.
    const br = r * 0.34, bx = x + r * 0.72, by = y + r * 0.72;
    c.beginPath(); c.arc(bx, by, br, 0, Math.PI * 2); c.fillStyle = t.fill; c.fill();
    c.lineWidth = Math.max(0.8, 1 * k); c.strokeStyle = t.border; c.stroke();
    if (local) { c.beginPath(); c.arc(bx, by, br * 0.45, 0, Math.PI * 2); c.fillStyle = ink; c.fill(); }
    else {
      const q = br * 0.42;
      c.lineWidth = Math.max(1, 1.2 * k); c.strokeStyle = ink;
      c.beginPath(); c.moveTo(bx - q, by + q); c.lineTo(bx + q, by - q); c.moveTo(bx - q * 0.2, by - q); c.lineTo(bx + q, by - q); c.lineTo(bx + q, by + q * 0.2); c.stroke();
    }
    c.lineCap = "butt"; c.lineJoin = "miter";
    c.globalAlpha = a;
    // The name under the circle, the OS chip after it, the two centred together.
    const name = this.clip(c, font, n.label, 220 * k), nw = this.measure(c, font, name);
    const chipFont = `600 ${10 * k}px ${t.sans}`, cw = n.os ? this.measure(c, chipFont, n.os) + 10 * k : 0, gap = n.os ? 6 * k : 0;
    const ny = y + r + 12 * k, left = x - (nw + gap + cw) / 2;
    c.font = font; c.fillStyle = off ? t.muted : t.text; c.textAlign = "left"; c.fillText(name, left, ny + 0.5);
    if (n.os) {
      const cx = left + nw + gap, ch = 14 * k;
      c.fillStyle = t.capsule; c.beginPath(); c.roundRect(cx, ny - ch / 2, cw, ch, 4 * k); c.fill();
      c.lineWidth = 1; c.strokeStyle = t.border; c.stroke();
      c.font = chipFont; c.fillStyle = t.muted; c.fillText(n.os, cx + 5 * k, ny + 0.5);
    }
    this.hits.push({ id: n.id, x: x - r, y: y - r, w: 2 * r, h: 2 * r, r });
  }

  /** Status dot, as the rail's lamps: working filled; waiting a ring; done a hollow ring; idle and failed filled. */
  private dot(c: CanvasRenderingContext2D, x: number, y: number, mood: Mood, r: number) {
    const t = this.theme;
    c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2);
    switch (mood) {
      case "working": c.fillStyle = t.working; c.fill(); break;
      case "failed": c.fillStyle = t.failed; c.fill(); break;
      case "idle": c.fillStyle = t.idle; c.fill(); break;
      case "waiting": c.fillStyle = t.fill; c.fill(); c.lineWidth = Math.max(1.6, r * 0.42); c.strokeStyle = t.waiting; c.beginPath(); c.arc(x, y, r - c.lineWidth / 2, 0, Math.PI * 2); c.stroke(); break;
      case "done": c.fillStyle = t.fill; c.fill(); c.lineWidth = Math.max(1.2, r * 0.3); c.strokeStyle = t.done; c.beginPath(); c.arc(x, y, r - c.lineWidth / 2, 0, Math.PI * 2); c.stroke(); break;
    }
  }

  private badge(c: CanvasRenderingContext2D, text: string, x: number, y: number, k: number): number {
    const t = this.theme, font = `700 ${10.5 * k}px ${t.mono}`;
    const w = this.measure(c, font, text) + 11 * k, h = 16 * k;
    c.fillStyle = t.badgeBg; c.beginPath(); c.roundRect(x, y - h / 2, w, h, h / 2); c.fill();
    c.fillStyle = t.badgeText; c.font = font; c.textAlign = "left"; c.fillText(text, x + 5.5 * k, y + 0.5 * k);
    return w;
  }

  // ---------- nodes, pill levels (30%+)
  private pillNode(c: CanvasRenderingContext2D, n: MNode, k: number) {
    const t = this.theme, x = this.sx(n), y = this.sy(n);
    if (n.kind === "hub") {
      const r = 24 * k;
      this.hub(c, n, x, y, r, k, `700 ${12.5 * k}px ${t.sans}`);
      if (this.view.zoom >= 0.45 && n.counts && !this.dim(n.id)) this.hubLines.push({ n, x, y: y + r + 34 * k, k });
      return;
    }
    if (n.kind === "chip") {
      const font = `500 ${11.5 * k}px ${t.sans}`;
      const label = this.words.folded(n.count ?? 0);
      const w = this.measure(c, font, label) + 30 * k, h = 20 * k;
      const left = n.side > 0 ? x : x - w;
      c.fillStyle = t.capsule; c.beginPath(); c.roundRect(left, y - h / 2, w, h, h / 2); c.fill();
      c.beginPath(); c.arc(left + 11 * k, y, 4 * k, 0, Math.PI * 2);
      c.setLineDash([1.6 * k, 1.6 * k]); c.lineWidth = 1.1 * k; c.strokeStyle = t.muted; c.stroke(); c.setLineDash([]);
      c.fillStyle = t.muted; c.font = font; c.textAlign = "left"; c.fillText(label, left + 20 * k, y + 0.5);
      this.hits.push({ id: n.id, x: left, y: y - h / 2, w, h, r: h / 2 });
      return;
    }
    if (n.kind === "sub") { this.agentCard(c, n, k * PX.sub); return; }
    const isFolder = n.kind === "folder" || n.kind === "merged";
    const s = k;
    const H = PX.pill * s, padX = 11 * s, dotR = 5 * s;
    const font = `${isFolder ? 650 : 600} ${12.5 * s}px ${t.sans}`;
    const mood: Mood = n.kind === "folder" ? this.folderMood(n) : n.mood ?? "idle";
    const label = this.clip(c, font, n.label, (isFolder ? 220 : 250) * s);
    const lw = this.measure(c, font, label);
    const badgeText = n.fresh ? (n.kind === "folder" ? `${this.words.fresh} ${n.fresh}` : this.words.fresh) : "";
    const bw = badgeText ? this.measure(c, `700 ${10.5 * s}px ${t.mono}`, badgeText) + 11 * s : 0;
    const lead = !isFolder && bw > 0; // sessions wear "New" in front, folders "New n" after the name
    const W = padX + (lead ? bw + 7 * s : 0) + dotR * 2 + 7 * s + lw + (bw && !lead ? 8 * s + bw : 0) + padX;
    const left = isFolder ? x - W / 2 : n.side > 0 ? x : x - W;
    if (isFolder) this.halfW.set(n.id, W / 2);
    const top = y - H / 2;
    const live = mood === "working" && n.kind !== "folder";

    if (blockLines(n) && !this.dim(n.id)) this.pillBlock(c, n, left, W, top + H + PX.gap * s, s);
    // Pill body: raised on the ground with a hairline and a soft drop.
    c.save();
    c.shadowColor = t.shadow; c.shadowBlur = 10 * s; c.shadowOffsetY = 2 * s;
    c.fillStyle = t.fill; c.beginPath(); c.roundRect(left, top, W, H, H / 2); c.fill();
    c.restore();
    const sel = n.id === this.selected;
    c.lineWidth = live ? (sel ? 2.2 : 1.6) : sel ? 1.5 : 1;
    c.strokeStyle = live ? t.borderLive : sel ? t.text : mood === "waiting" && n.kind !== "folder" ? t.borderWait : t.border;
    c.beginPath(); c.roundRect(left + 0.5, top + 0.5, W - 1, H - 1, (H - 1) / 2); c.stroke();
    let cx = left + padX;
    if (lead) { this.badge(c, badgeText, cx - 3 * s, y, s); cx += bw + 4 * s; }
    this.dot(c, cx + dotR, y, mood, mood === "idle" ? dotR * 0.82 : dotR);
    cx += dotR * 2 + 7 * s;
    c.fillStyle = t.text; c.font = font; c.textAlign = "left"; c.fillText(label, cx, y + 0.5 * s);
    cx += lw + 8 * s;
    if (bw && !lead) this.badge(c, badgeText, cx, y, s);
    this.hits.push({ id: n.id, x: left, y: top, w: W, h: H, r: H / 2 });
    if (mood === "waiting" && n.kind !== "folder" && !this.dim(n.id)) this.waits.push(left + padX + (lead ? bw + 4 * s : 0) + dotR, y, dotR);
  }

  private folderMood(n: MNode): Mood {
    const kids = this.model.nodes.filter((m) => m.parent === n.id && m.kind === "session");
    for (const m of ["working", "waiting", "failed"] as Mood[]) if (kids.some((s) => s.mood === m)) return m;
    return "idle";
  }

  /**
   * The block under a pill (spec 11.1, always shown from 30%). A session's
   * sits indented under it, growing outward; a folder's grows toward the
   * hub, away from its column, so the column's edges never pass under it.
   */
  private pillBlock(c: CanvasRenderingContext2D, n: MNode, pillLeft: number, pillW: number, top: number, k: number) {
    let rows: Array<[time: string, text: string, strong: boolean]>;
    if (n.kind === "folder") {
      const [doing, counts] = folderBlock(n.doing, n.stat ?? { sessions: 0, working: 0, waiting: 0, done: 0 }, this.words.block);
      rows = [...(doing ? [["", doing, true] as [string, string, boolean]] : []), ...(counts ? [["", counts, false] as [string, string, boolean]] : [])];
    } else rows = (n.lines ?? []).map((l: Line): [string, string, boolean] => [l.at ? hm(l.at) : "", l.agent ? this.words.agent(l.text) : l.text, !l.faint]);
    if (!rows.length) return;
    const session = n.kind === "session";
    const x = session ? (n.side > 0 ? pillLeft + PX.indent * k : pillLeft + pillW - PX.indent * k) : n.side > 0 ? pillLeft + pillW : pillLeft;
    this.block(c, n.id, rows, x, session ? n.side > 0 : n.side < 0, top, k);
  }

  /** A summary card for node `id`: up to two lines, a time column when a line has one; `x` is its left edge when `fromLeft`, else its right. */
  private block(c: CanvasRenderingContext2D, id: string, rows: Array<[time: string, text: string, strong: boolean]>, x: number, fromLeft: boolean, top: number, k: number) {
    const t = this.theme;
    const fT = `600 ${11.5 * k}px ${t.mono}`, fS = `500 ${11.5 * k}px ${t.sans}`, fX = `400 ${11 * k}px ${t.sans}`;
    const pad = PX.padX * k, lh = PX.line * k, maxW = PX.blockW * k;
    const tw = rows.some((r) => r[0]) ? this.measure(c, fT, "00:00") + 7 * k : 0;
    const texts = rows.map(([, text, strong]) => this.clip(c, strong ? fS : fX, text, maxW - pad * 2 - tw));
    const W = Math.min(maxW, pad * 2 + tw + Math.max(...texts.map((s, i) => this.measure(c, rows[i]![2] ? fS : fX, s))));
    const H = blockH(rows.length) * k;
    const left = fromLeft ? x : x - W;
    this.card(c, left, top, W, H, 6 * k, t.border, 1);
    // A press on the block picks its pill.
    this.hits.push({ id, x: left, y: top, w: W, h: H, r: 6 * k });
    c.textAlign = "left";
    rows.forEach(([time, , strong], i) => {
      const yy = top + PX.padY * k + lh * (i + 0.5);
      if (time) { c.font = fT; c.fillStyle = t.tlTime; c.fillText(time, left + pad, yy); }
      c.font = strong ? fS : fX; c.fillStyle = strong ? t.text : t.tlText;
      c.fillText(texts[i]!, left + pad + tw, yy);
    });
  }

  private card(c: CanvasRenderingContext2D, left: number, top: number, w: number, h: number, r: number, line: string, lw: number) {
    c.fillStyle = this.theme.card; c.beginPath(); c.roundRect(left, top, w, h, r); c.fill();
    c.lineWidth = lw; c.strokeStyle = line; c.beginPath(); c.roundRect(left + 0.5, top + 0.5, w - 1, h - 1, Math.max(0, r - 0.5)); c.stroke();
  }

  /** A subagent: a card of its own, what it was asked (and its kind of agent), then how long it has been out or what came back. */
  private agentCard(c: CanvasRenderingContext2D, n: MNode, s: number) {
    const t = this.theme, x = this.sx(n), y = this.sy(n);
    const running = n.mood !== "done";
    const [asked, status] = agentBlock({ asked: n.label, running, ...(n.since === undefined ? {} : { since: n.since }), ...(n.result ? { result: n.result } : {}) }, this.model.now, this.words.block);
    const pad = PX.padX * s, lh = PX.line * s, dotR = 3.6 * s, maxW = PX.blockW * s, H = blockH(2) * s;
    const f1 = `600 ${11.5 * s}px ${t.sans}`, f2 = `400 ${11 * s}px ${t.sans}`, fTag = `600 ${9.5 * s}px ${t.mono}`;
    // The default kind says nothing; a named one (Explore, Plan) does.
    const tag = n.agentType && n.agentType !== "general-purpose" ? this.clip(c, fTag, n.agentType, 72 * s) : "";
    const tagW = tag ? this.measure(c, fTag, tag) + 8 * s : 0;
    const textX = pad + dotR * 2 + 6 * s;
    const l1 = this.clip(c, f1, asked, maxW - textX - pad - (tagW ? tagW + 6 * s : 0));
    const l2 = this.clip(c, f2, status, maxW - textX - pad);
    const w1 = this.measure(c, f1, l1);
    const W = Math.min(maxW, textX + Math.max(w1 + (tagW ? tagW + 6 * s : 0), this.measure(c, f2, l2)) + pad);
    const left = n.side > 0 ? x : x - W, top = y - H / 2;
    const mood = n.mood ?? "idle", live = mood === "working", sel = n.id === this.selected;
    this.card(c, left, top, W, H, 6 * s, live ? t.borderLive : sel ? t.text : t.border, live ? 1.4 : sel ? 1.5 : 1);
    const y1 = top + PX.padY * s + lh / 2, y2 = y1 + lh;
    this.dot(c, left + pad + dotR, y1, mood, mood === "idle" ? dotR * 0.82 : dotR);
    c.textAlign = "left"; c.font = f1; c.fillStyle = t.text; c.fillText(l1, left + textX, y1 + 0.5 * s);
    if (tag) {
      const tx = left + textX + w1 + 6 * s, th = 13 * s;
      c.fillStyle = t.border; c.beginPath(); c.roundRect(tx, y1 - th / 2, tagW, th, 3 * s); c.fill();
      c.font = fTag; c.fillStyle = t.muted; c.fillText(tag, tx + 4 * s, y1 + 0.5 * s);
    }
    c.font = f2; c.fillStyle = t.tlText; c.fillText(l2, left + textX, y2 + 0.5 * s);
    this.hits.push({ id: n.id, x: left, y: top, w: W, h: H, r: 6 * s });
  }

  private hubSummary(c: CanvasRenderingContext2D, hub: MNode, x: number, y: number, k: number) {
    const t = this.theme, n = hub.counts!;
    const [w, q, d, a] = this.words.hub;
    const parts: Array<[string, string, string]> = [[w + " ", String(n.working), t.working], [q + " ", String(n.waiting), n.waiting ? t.waiting : t.text], [d + " ", String(n.done), t.muted], [a + " ", String(n.subagents), t.muted]];
    const fL = `500 ${11 * k}px ${t.sans}`, fN = `700 ${11 * k}px ${t.sans}`, gap = 9 * k;
    const W = parts.reduce((s, [l, v]) => s + this.measure(c, fL, l) + this.measure(c, fN, v), 0) + gap * (parts.length - 1) + 16 * k, H = 19 * k;
    const x0 = x - W / 2, y0 = y - H / 2;
    if (this.hits.some((r) => r.id !== hub.id && r.x < x0 + W && r.x + r.w > x0 && r.y < y0 + H && r.y + r.h > y0)) return;
    c.fillStyle = t.capsule; c.beginPath(); c.roundRect(x - W / 2, y - H / 2, W, H, 5 * k); c.fill();
    this.hits.push({ id: hub.id, x: x0, y: y0, w: W, h: H, r: 5 * k });
    let cx = x - W / 2 + 8 * k;
    c.textAlign = "left";
    for (const [l, v, col] of parts) {
      c.font = fL; c.fillStyle = col; c.fillText(l, cx, y + 0.5); cx += this.measure(c, fL, l);
      c.font = fN; c.fillText(v, cx, y + 0.5); cx += this.measure(c, fN, v) + gap;
    }
  }
}

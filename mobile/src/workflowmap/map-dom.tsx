"use dom";

import { useEffect, useRef, useState } from "react";

import { holdOn, movedBy, type Spot } from "../../../cockpit/src/renderer/workflowmap/hold.ts";
import { blockLines, build, footprint, nodeOfSession, shiftBranch, ZOOM_HOME, ZOOM_MAX, ZOOM_MIN, type MapInput, type MapModel, type MNode } from "../../../cockpit/src/renderer/workflowmap/model.ts";
import { Painter, themeFrom, type Theme, type View, type Words } from "../../../cockpit/src/renderer/workflowmap/paint.ts";
import type { BlockWords } from "../../../cockpit/src/renderer/workflowmap/summary.ts";

/** The app's theme tokens (ui.tsx), named as the cockpit's CSS variables they stand for. */
export interface MapPalette {
  dark: boolean;
  ground: string; panel: string; raise: string; line: string; text: string; muted: string;
  go: string; live: string; stop: string; idle: string; link: string;
}
/** Painter words as templates: functions do not cross into the web view. */
export interface MapWords { fresh: string; folded: string; agent: string; hub: [string, string, string, string]; block: BlockWords }

const SANS = '-apple-system, system-ui, "Segoe UI", Roboto, sans-serif';
const MONO = "ui-monospace, Menlo, monospace";
const themeOf = (p: MapPalette): Theme => {
  const vars: Record<string, string> = {
    "--ground": p.ground, "--panel": p.panel, "--raise": p.raise, "--line": p.line, "--text": p.text, "--muted": p.muted,
    "--go": p.go, "--live": p.live, "--stop": p.stop, "--idle": p.idle, "--link": p.link, "--sans": SANS, "--mono": MONO,
  };
  return { ...themeFrom((name) => vars[name] ?? "", p.dark), done: p.muted };
};
const wordsOf = (w: MapWords): Words => ({
  fresh: w.fresh,
  folded: (n) => w.folded.replace("{n}", String(n)),
  agent: (text) => w.agent.replace("{text}", text),
  hub: w.hub,
  block: w.block,
});

interface Engine {
  setInput(input: MapInput, spots: Record<string, Spot>): void;
  setPalette(palette: MapPalette): void;
  setWords(words: MapWords): void;
  setActive(on: boolean): void;
  setSelected(session: string | undefined): void;
  destroy(): void;
}

/**
 * The cockpit's workflow map (model.ts, paint.ts: its files, word for word)
 * in a web view, one PC's constellation. Watch only: a tap on a session
 * calls `onPick` back in the app, which opens its sheet. It centers the map
 * on open and as it grows, until a pan or pinch moves it. A long press lifts
 * a project; where it is dropped goes to `onMoved`, for the app to keep.
 */
export default function WorkflowMapView(props: {
  input: MapInput;
  palette: MapPalette;
  words: MapWords;
  /** False while another tab is in front: no frames, cached bitmaps given back. */
  active: boolean;
  /** Where this PC's projects were moved, by node id. */
  spots: Record<string, Spot>;
  /** The session whose sheet is open, outlined on the map. */
  selected?: string;
  onPick: (session: string) => Promise<void>;
  onMoved: (pc: string, id: string, spot: Spot) => Promise<void>;
  /**
   * What the map is doing, for the app to show or test on: "drawn WxH @dpr z=…"
   * once a frame is on the canvas, "error: …" when the web view fails.
   */
  onReport?: (state: string) => Promise<void>;
  dom?: import("expo/dom").DOMProps;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const engine = useRef<Engine | undefined>(undefined);
  const latest = useRef(props);
  latest.current = props;
  // A failure inside the web view is otherwise invisible: show it instead of a blank map.
  const [failed, setFailedState] = useState<string | undefined>(undefined);
  const said = useRef("");
  const report = (state: string) => {
    if (state === said.current) return;
    said.current = state;
    void latest.current.onReport?.(state);
  };
  const setFailed = (error: string) => {
    setFailedState(error);
    report(`error: ${error}`);
  };
  const guard = (run: () => void) => {
    try {
      run();
    } catch (error) {
      setFailed(String(error));
    }
  };

  useEffect(() => {
    const onError = (event: ErrorEvent) => setFailed(String(event.message));
    window.addEventListener("error", onError);
    document.body.style.margin = "0";
    document.body.style.overflow = "hidden";
    guard(() => {
      engine.current = createEngine(canvas.current!, latest.current, (session) => void latest.current.onPick(session), (pc, id, spot) => void latest.current.onMoved(pc, id, spot), report);
    });
    return () => {
      window.removeEventListener("error", onError);
      engine.current?.destroy();
      engine.current = undefined;
    };
  }, []);
  useEffect(() => guard(() => engine.current?.setInput(props.input, props.spots)), [props.input, props.spots]);
  useEffect(() => guard(() => engine.current?.setPalette(props.palette)), [props.palette]);
  useEffect(() => guard(() => engine.current?.setWords(props.words)), [props.words]);
  useEffect(() => guard(() => engine.current?.setActive(props.active)), [props.active]);
  useEffect(() => guard(() => engine.current?.setSelected(props.selected)), [props.selected]);

  if (failed) return <p style={{ font: `14px ${SANS}`, color: props.palette.muted, padding: 16 }}>{failed}</p>;
  return <canvas ref={canvas} style={{ position: "fixed", inset: 0, width: "100%", height: "100%", display: "block", touchAction: "none", userSelect: "none", WebkitUserSelect: "none", WebkitTouchCallout: "none" }} />;
}

function createEngine(canvas: HTMLCanvasElement, first: { input: MapInput; palette: MapPalette; words: MapWords; active: boolean; spots: Record<string, Spot> }, pick: (session: string) => void, moved: (pc: string, id: string, spot: Spot) => void, report: (state: string) => void): Engine {
  let spots = first.spots;
  let pcId = first.input.pcs[0]?.id ?? "";
  let model: MapModel = build(first.input, undefined, spots);
  const painter = new Painter(canvas, model, themeOf(first.palette), wordsOf(first.words));
  painter.reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let active = first.active;
  let selected: string | undefined;
  /** The operator moved the view: it stays where they put it. */
  let userView = false;
  /** Lowest zoom: under the cockpit's when that is what fits the whole map on a phone. */
  let low = ZOOM_MIN;
  let raf = 0;
  /** The painter's render count last reported. */
  let seen = 0;

  const kick = () => {
    if (active && !raf) raf = requestAnimationFrame(tick);
  };
  const tick = (now: number) => {
    raf = 0;
    if (!active) return;
    const more = painter.frame(now);
    if (painter.renders !== seen && painter.w) {
      seen = painter.renders;
      const v = painter.view;
      report(`drawn ${painter.w}x${painter.h} @${+painter.dpr.toFixed(2)} z=${v.zoom.toFixed(3)} t=${Math.round(v.tx)},${Math.round(v.ty)} n=${model.nodes.length} iw=${innerWidth}x${innerHeight} vv=${visualViewport?.width}x${visualViewport?.height}@${visualViewport?.scale}`);
    }
    if (more && !document.hidden) kick();
  };
  const setView = (v: View) => {
    painter.view = { ...v, zoom: Math.min(ZOOM_MAX, Math.max(low, v.zoom)) };
    painter.invalidate();
    kick();
  };
  /**
   * The whole constellation on screen, its words included. Words are drawn
   * at one size whatever the zoom, so the world box (sized for the cockpit's
   * wide window) cannot say what fits a phone: each node's words are
   * measured as the dots level draws them, and the zoom is the largest that
   * keeps them all inside when zoomed out. Start at the pill level so the
   * summaries are visible; a pinch can still zoom out to the fitted view.
   */
  const fit = () => {
    const w = painter.w, h = painter.h, nodes = model.nodes;
    if (w <= 0 || h <= 0 || !nodes.length) return;
    const M = 12, TOP = 26, BOTTOM = 36; // edge margin; a folder's name above its dot, the PC's below its circle
    const ext = nodes.map((n) => extent(n, painter.words.fresh, n.kind === "session" && (n.mood === "working" || n.mood === "waiting" || n.id === painter.selected)));
    let z = 0.24;
    for (let i = 0; i < nodes.length; i++) {
      for (let j = 0; j < nodes.length; j++) {
        const dx = nodes[i]!.x - nodes[j]!.x;
        if (dx > 0) z = Math.min(z, (w - 2 * M - ext[i]!.r - ext[j]!.l) / dx);
      }
    }
    const ys = nodes.map((n) => n.y), y0 = Math.min(...ys), y1 = Math.max(...ys);
    if (y1 > y0) z = Math.min(z, (h - 2 * M - TOP - BOTTOM) / (y1 - y0));
    z = Math.max(0.02, z);
    low = Math.min(ZOOM_MIN, z);
    z = Math.max(ZOOM_HOME, z);
    let left = Infinity, right = -Infinity;
    nodes.forEach((n, i) => {
      left = Math.min(left, n.x * z - ext[i]!.l);
      right = Math.max(right, n.x * z + ext[i]!.r);
    });
    let tx = (w - left - right) / 2, ty = (h - (y0 * z - TOP) - (y1 * z + BOTTOM)) / 2;
    const target = nodes.find((n) => (n.kind === "session" || n.kind === "merged") && blockLines(n) > 0)
      ?? nodes.find((n) => n.kind === "folder" && blockLines(n) > 0);
    if (target) {
      const boxes = footprint(target, z);
      const x0 = Math.min(...boxes.map((b) => b.x0)) * z, x1 = Math.max(...boxes.map((b) => b.x1)) * z;
      const y0 = Math.min(...boxes.map((b) => b.y0)) * z, y1 = Math.max(...boxes.map((b) => b.y1)) * z;
      if (x0 + tx < M || x1 + tx > w - M) tx = (w - x0 - x1) / 2;
      if (y0 + ty < M || y1 + ty > h - M) ty = (h - y0 - y1) / 2;
    }
    setView({ zoom: z, tx, ty });
  };
  /**
   * Sized from the visual viewport, what is on screen, and refitted when it
   * changes: a WKWebView's frame settles after the page loads, and iOS drew
   * the first map for another size, off to the right.
   */
  const resize = () => {
    const vv = visualViewport;
    painter.resize(vv?.width ?? innerWidth, vv?.height ?? innerHeight, devicePixelRatio || 1);
    if (!userView) fit();
    kick();
  };
  const mark = () => {
    painter.selected = selected ? nodeOfSession(model, selected)?.id ?? null : null;
    // A selected session shows its name: fit again so it stays on screen.
    if (!userView) fit();
    painter.invalidate();
    kick();
  };

  // ---- touch: one finger pans, two pinch; a tap that did not move picks; a long press on a project lifts it.
  const points = new Map<number, { x: number; y: number }>();
  let pan: { x: number; y: number; view: View; moved: boolean } | null = null;
  let pinch: { dist: number; mid: { x: number; y: number }; view: View } | null = null;
  let lift: { pointer: number; id: string; x: number; y: number; dx: number; dy: number } | null = null;
  let holdOff = () => {};
  const where = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const pair = () => {
    const [a, b] = [...points.values()];
    return { dist: Math.max(1, Math.hypot(a!.x - b!.x, a!.y - b!.y)), mid: { x: (a!.x + b!.x) / 2, y: (a!.y + b!.y) / 2 } };
  };
  const drop = () => {
    if (!lift) return;
    const { id, dx, dy } = lift;
    lift = null;
    points.clear();
    pan = null;
    painter.lifted = null;
    if (dx || dy) {
      const spot = movedBy(spots[id], dx, dy);
      spots = { ...spots, [id]: spot };
      moved(pcId, id, spot);
    }
    kick();
  };
  const down = (e: PointerEvent) => {
    if (lift) return; // another finger while a project is up: it stays with the first
    canvas.setPointerCapture(e.pointerId);
    points.set(e.pointerId, where(e));
    if (points.size === 1) {
      const at = where(e);
      pan = { ...at, view: { ...painter.view }, moved: false };
      const id = painter.hit(at.x, at.y);
      holdOff = holdOn(id ? model.byId.get(id) : undefined, (project) => {
        lift = { pointer: e.pointerId, id: project, ...points.get(e.pointerId)!, dx: 0, dy: 0 };
        pan!.moved = true; // a long press is not a tap
        userView = true;
        painter.lifted = project;
        kick();
      });
    } else if (points.size === 2) {
      holdOff();
      pinch = { ...pair(), view: { ...painter.view } };
      if (pan) pan.moved = true; // a pinch is never a tap
    }
  };
  const move = (e: PointerEvent) => {
    if (lift) {
      if (e.pointerId !== lift.pointer) return;
      const p = where(e), z = painter.view.zoom, dx = (p.x - lift.x) / z, dy = (p.y - lift.y) / z;
      shiftBranch(model, lift.id, dx - lift.dx, dy - lift.dy);
      lift.dx = dx;
      lift.dy = dy;
      painter.invalidate();
      kick();
      return;
    }
    if (!points.has(e.pointerId)) return;
    points.set(e.pointerId, where(e));
    if (pinch && points.size >= 2) {
      const now = pair(), v = pinch.view;
      const zoom = Math.min(ZOOM_MAX, Math.max(low, v.zoom * (now.dist / pinch.dist)));
      // The world point under the fingers' first midpoint follows the midpoint.
      const wx = (pinch.mid.x - v.tx) / v.zoom, wy = (pinch.mid.y - v.ty) / v.zoom;
      userView = true;
      setView({ zoom, tx: now.mid.x - wx * zoom, ty: now.mid.y - wy * zoom });
    } else if (pan && points.size === 1) {
      const p = where(e), dx = p.x - pan.x, dy = p.y - pan.y;
      if (!pan.moved && Math.abs(dx) + Math.abs(dy) < 8) return;
      holdOff();
      pan.moved = true;
      userView = true;
      setView({ ...pan.view, tx: pan.view.tx + dx, ty: pan.view.ty + dy });
    }
  };
  const up = (e: PointerEvent) => {
    if (lift) {
      if (e.pointerId === lift.pointer) drop();
      return;
    }
    holdOff();
    if (!points.delete(e.pointerId)) return;
    if (points.size < 2) pinch = null;
    if (points.size === 1) {
      // One finger left after a pinch: it pans on from here.
      const [p] = [...points.values()];
      pan = { ...p!, view: { ...painter.view }, moved: true };
      return;
    }
    if (points.size > 0) return;
    const tap = pan && !pan.moved && e.type === "pointerup";
    pan = null;
    if (!tap) return;
    const p = where(e);
    const id = painter.hit(p.x, p.y);
    const node = id ? model.byId.get(id) : undefined;
    if (node?.session) pick(node.session);
  };
  canvas.addEventListener("pointerdown", down);
  canvas.addEventListener("pointermove", move);
  canvas.addEventListener("pointerup", up);
  canvas.addEventListener("pointercancel", up);
  // A long press must not open anything of the web view's own.
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  window.addEventListener("resize", resize);
  visualViewport?.addEventListener("resize", resize);
  const onHidden = () => {
    if (document.hidden) painter.release();
    else kick();
  };
  document.addEventListener("visibilitychange", onHidden);
  resize();

  return {
    setInput(input, next) {
      spots = next;
      pcId = input.pcs[0]?.id ?? "";
      model = build(input, model, spots);
      // New data mid-drag: what is held stays under the finger.
      if (lift) shiftBranch(model, lift.id, lift.dx, lift.dy);
      painter.setModel(model);
      mark();
    },
    setPalette(palette) {
      painter.setTheme(themeOf(palette));
      kick();
    },
    setWords(words) {
      painter.words = wordsOf(words);
      painter.invalidate();
      kick();
    },
    setActive(on) {
      active = on;
      if (on) {
        painter.invalidate();
        kick();
      } else {
        holdOff();
        drop();
        cancelAnimationFrame(raf);
        raf = 0;
        painter.release();
      }
    },
    setSelected(session) {
      selected = session;
      mark();
    },
    destroy() {
      holdOff();
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      visualViewport?.removeEventListener("resize", resize);
      document.removeEventListener("visibilitychange", onHidden);
      painter.release();
    },
  };
}

const measurer = document.createElement("canvas").getContext("2d")!;
const textW = (font: string, text: string) => {
  measurer.font = font;
  return measurer.measureText(text).width;
};
/** How far a node's drawing reaches left and right of it on screen at the dots level: paint.ts dotNode's sizes and fonts. */
function extent(n: MNode, fresh: string, named: boolean): { l: number; r: number } {
  if (n.kind === "hub") {
    // Its name centred under its 16px circle.
    const half = Math.max(16, Math.min(220, textW(`700 11px ${SANS}`, n.label)) / 2);
    return { l: half, r: half };
  }
  if (n.kind === "folder" || n.kind === "merged") {
    const half = Math.max(10, textW(`700 11.5px ${SANS}`, n.label) / 2);
    const badge = n.fresh ? 6 + textW(`700 ${10.5 * 0.82}px ${MONO}`, n.kind === "folder" ? `${fresh} ${n.fresh}` : fresh) + 11 * 0.82 : 0;
    return { l: half, r: half + badge };
  }
  // Session, subagent, chip: a dot 5px out; a session's name 15px past it, growing outward.
  const out = 13 + (named ? 15 + Math.min(220, textW(`500 11.5px ${SANS}`, n.label)) : 0);
  return n.side > 0 ? { l: 8, r: out } : { l: out, r: 8 };
}

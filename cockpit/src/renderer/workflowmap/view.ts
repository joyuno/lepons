import { t } from "../../i18n/i18n.ts";
import { attachHover, hideTip, showTipAt } from "../hover.ts";
import { holdOn, isProject, movedBy, type Spot } from "./hold.ts";
import { boxOf, branchOf, build, nextWaiting, nodeOfSession, shiftBranch, ZOOM_HOME, ZOOM_MAX, ZOOM_MIN, type Box, type MapInput, type MapModel, type MNode } from "./model.ts";
import { ease, Painter, themeFrom, type View, type Words } from "./paint.ts";
import { renderPanel, type PanelDeps } from "./panel.ts";
import { oneLine, summarize } from "./summary.ts";

/*
 * The workflow view: the map, its strip, zoom bar, focus bar and right
 * panel. Watch only (spec 10.3): nothing here types into a session.
 *
 * Frames run only while something moves and the map is on screen; hidden,
 * it gives its cached bitmaps back. Colours are re-read from the app's theme
 * whenever <html data-theme> changes.
 */

export interface WorkflowMapDeps extends Omit<PanelDeps, "close"> {
  input(): MapInput;
  /** Bring the map on screen (the title bar's pill was pressed elsewhere). */
  show(): void;
}

export interface WorkflowMap {
  /** Re-reads the input: the pill always, the map while on screen. Cheap when nothing changed. */
  refresh(): void;
  setVisible(on: boolean): void;
  /** Selects the next waiting session and brings it into view. */
  showWaiting(): void;
  /** Esc: leaves focus, else closes the panel or list. False when there was nothing to close. */
  escape(): boolean;
  /** For tests. */
  state(): { selected: string | null; lifted: string | null; focus: string | null; follow: boolean; themeReads: number; renders: number; laidOut: number; view: View; bg: string; panel: boolean };
}

const TOP = 44;
const PANEL = 376;
const OFFSETS = "workflowMapOffsets";
const FOLLOW = "workflowMapFollow";

function h<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}
const button = (className: string, text: string, hint: string, run: () => void): HTMLButtonElement => {
  const b = h("button", className, text);
  b.type = "button";
  // A sign alone ("−", "⛶") says nothing to a screen reader.
  if ([...text].length <= 1) b.setAttribute("aria-label", hint);
  attachHover(b, () => hint);
  b.addEventListener("click", run);
  return b;
};

const words = (): Words => ({
  fresh: t("wfmap.new"),
  folded: (n) => t("wfmap.folded", { n }),
  agent: (text) => t("wfmap.agentStep", { text }),
  hub: [t("wfmap.working"), t("wfmap.waitingWord"), t("wfmap.doneToday"), t("wfmap.subagents")],
  // Templates, unfilled: summary.ts fills them.
  block: {
    running: t("wfmap.agentRunning"), under: t("wfmap.underMinute"), minutes: t("wfmap.minutes"), hours: t("wfmap.hours"), done: t("wfmap.agentDone"),
    sessions: t("wfmap.sessionCount"), working: t("wfmap.hubWorking"), waiting: t("wfmap.hubWaiting"), doneToday: t("wfmap.hubDone"),
  },
});

export function createWorkflowMap(host: HTMLElement, pill: HTMLButtonElement, deps: WorkflowMapDeps): WorkflowMap {
  // ---------- DOM
  const canvas = h("canvas", "wmCanvas");
  canvas.setAttribute("aria-label", t("workflow.toggle"));
  const crumb = h("div", "wmCrumb");
  const need = button("wmNeed", "", t("wfmap.needHint"), () => setNeedList(!!needList.hidden));
  const needList = h("ul", "wmNeedList");
  needList.hidden = true;
  const setNeedList = (open: boolean) => { needList.hidden = !open; need.setAttribute("aria-expanded", String(open)); };
  need.setAttribute("aria-expanded", "false");
  const needBox = h("div", "wmNeedBox");
  needBox.append(need, needList);
  const sum = h("div", "wmSum");
  const follow = button("wmTog", t("wfmap.follow"), t("wfmap.followHint"), () => setFollow(!following));
  const strip = h("div", "wmStrip");
  strip.append(crumb, needBox, sum, h("div", "wmSp"), follow);
  const pct = h("span", "wmPct");
  const zoom = h("div", "wmZoom");
  zoom.append(
    button("", "−", t("wfmap.zoomOut"), () => zoomAt(0.8, mapW() / 2, host.clientHeight / 2)),
    pct,
    button("", "+", t("wfmap.zoomIn"), () => zoomAt(1.25, mapW() / 2, host.clientHeight / 2)),
    button("", "⛶", t("wfmap.fit"), () => (focusSet ? fitBox(boxOf(model, focusSet)) : fitAll(true))),
  );
  const focusCrumb = h("span", "wmFocusCrumb");
  const focusBar = h("div", "wmFocus");
  const back = button("wmFocusBack", "", t("wfmap.backHint"), () => unfocus());
  back.append(t("wfmap.back") + " ", h("kbd", "", "Esc"));
  focusBar.append(focusCrumb, back);
  focusBar.hidden = true;
  const panel = h("aside", "wmPanel");
  panel.hidden = true;
  const empty = h("div", "wmEmpty", t("workflow.empty"));
  empty.hidden = true;
  host.replaceChildren(canvas, strip, zoom, focusBar, panel, empty);

  // ---------- state
  let input: MapInput = { now: Date.now(), pcs: [], folders: [], sessions: [], delegations: [], shares: [] };
  let seen = "";
  let drawn = "";
  let model: MapModel = build(input);
  let laidOut = 0;
  let visible = false;
  /** The operator moved the view: until ⛶ (or 전체로), it stays where they put it. */
  let userView = false;
  let panelOpen = false;
  let panelFor = "";
  let focusId: string | null = null;
  let focusSet: Set<string> | null = null;
  let cycled: string | undefined;
  let following = localStorage.getItem(FOLLOW) === "1";
  let touched = 0;
  let moods = new Map<string, string>();
  let themeReads = 0;
  const offsets: Record<string, Spot> = (() => {
    try { return JSON.parse(localStorage.getItem(OFFSETS) ?? "{}"); } catch { return {}; }
  })();

  const readTheme = () => {
    themeReads++;
    const style = getComputedStyle(document.documentElement);
    return themeFrom((name) => style.getPropertyValue(name).trim(), document.documentElement.dataset?.["theme"] !== "light");
  };
  const painter = new Painter(canvas, model, readTheme(), words());
  const motion = matchMedia("(prefers-reduced-motion: reduce)");
  painter.reduced = motion.matches;
  motion.addEventListener("change", () => { painter.reduced = motion.matches; kick(); });
  // The theme can switch while the map is open: settings, or the OS under "system".
  new MutationObserver(() => {
    if (!visible) return;
    painter.setTheme(readTheme());
    kick();
  }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

  // ---------- view
  const mapW = () => host.clientWidth - (panelOpen ? PANEL : 0);
  /** The room the overview has on screen (its thin margins; the panel left out, so opening it moves nothing). */
  const room = () => ({ w: Math.max(100, host.clientWidth - 40), h: Math.max(100, host.clientHeight - TOP - 30) });
  /** Lowest zoom: under ZOOM_MIN when that is what shows every folder. */
  let low = ZOOM_MIN;
  const resize = () => {
    if (!visible) return;
    painter.resize(host.clientWidth, host.clientHeight, window.devicePixelRatio || 1);
    // The window's shape picks how the PCs sit together: laid out again (the force layout is kept), and fitted.
    drawn = "";
    refresh();
    kick();
  };
  new ResizeObserver(resize).observe(host);

  let anim: { from: View; to: View; t0: number; ms: number } | null = null;
  function setView(v: View, animate = false) {
    v.zoom = Math.min(ZOOM_MAX, Math.max(low, v.zoom));
    userView = true;
    if (animate && !painter.reduced) anim = { from: { ...painter.view }, to: v, t0: performance.now(), ms: 360 };
    else { painter.view = v; anim = null; }
    painter.invalidate();
    pct.textContent = `${Math.round(v.zoom * 100)}%`;
    kick();
  }
  /** World point (wx, wy) at the map's visible centre. */
  const centreOn = (wx: number, wy: number, z: number, animate = false) =>
    setView({ zoom: z, tx: mapW() / 2 - wx * z, ty: TOP + (host.clientHeight - TOP) / 2 - wy * z }, animate);
  /** Never past 100% to fit: a small branch is shown at its own size, not blown up. */
  const fitBox = (b: Box, animate = true) => {
    const w = Math.max(100, mapW() - 120), hh = Math.max(100, host.clientHeight - TOP - 110);
    centreOn((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, Math.min(1, Math.max(ZOOM_MIN, Math.min(w / (b.x1 - b.x0), hh / (b.y1 - b.y0)))), animate);
  };
  /**
   * The overview: everything, blocks and columns included, centred. At 30%,
   * where every block reads, when it fits there (build() has already sat
   * the PCs together the way that shows largest in this window); else
   * zoomed out as far as it takes, under ZOOM_MIN too, so no folder is left
   * off screen. Until the operator pans or zooms, it keeps fitting as PCs
   * and folders arrive.
   */
  function fitAll(animate: boolean) {
    if (host.clientWidth <= 0 || !model.nodes.length) return;
    const b = model.bounds, w = Math.max(100, mapW() - 40), hh = room().h;
    const z = Math.min(ZOOM_HOME, w / (b.x1 - b.x0), hh / (b.y1 - b.y0));
    low = Math.min(ZOOM_MIN, z);
    centreOn((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, z, animate);
    userView = false;
  }
  function zoomAt(f: number, sx: number, sy: number) {
    const v = painter.view, z = Math.min(ZOOM_MAX, Math.max(low, v.zoom * f));
    const wx = (sx - v.tx) / v.zoom, wy = (sy - v.ty) / v.zoom;
    setView({ zoom: z, tx: sx - wx * z, ty: sy - wy * z });
  }
  const bringIn = (n: MNode, animate = true) => centreOn(n.x + n.side * 150, n.y + 40, Math.max(0.42, painter.view.zoom), animate);

  // ---------- frame loop: runs only while something moves and the map is on screen
  let raf = 0;
  function kick() { if (visible && !raf) raf = requestAnimationFrame(tick); }
  function tick(now: number) {
    raf = 0;
    if (!visible) return;
    if (anim) {
      const p = Math.min(1, (now - anim.t0) / anim.ms), e = ease(p);
      const { from: a, to: b } = anim;
      // Log-zoom, with the world point under the centre moving straight.
      const z = a.zoom * Math.pow(b.zoom / a.zoom, e);
      const cx = mapW() / 2, cy = host.clientHeight / 2;
      const wa = [(cx - a.tx) / a.zoom, (cy - a.ty) / a.zoom], wb = [(cx - b.tx) / b.zoom, (cy - b.ty) / b.zoom];
      const wx = wa[0]! + (wb[0]! - wa[0]!) * e, wy = wa[1]! + (wb[1]! - wa[1]!) * e;
      painter.view = { zoom: z, tx: cx - wx * z, ty: cy - wy * z };
      painter.invalidate();
      if (p >= 1) { painter.view = b; anim = null; }
    }
    const moving = painter.frame(now);
    if ((moving || anim) && !document.hidden) kick();
  }
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) painter.release();
    else kick();
  });

  // ---------- input
  /** A pointer's place on the canvas (offsetX is not reliable for every event source). */
  const at = (e: MouseEvent): [number, number] => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  const draggable = (n: MNode | undefined) => n !== undefined && (n.kind === "hub" || n.kind === "folder" || n.kind === "merged");
  let drag: { x: number; y: number; tx: number; ty: number; moved: boolean; node?: string; lifted?: boolean; dx: number; dy: number } | null = null;
  let holdOff = () => {};
  canvas.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    touched = Date.now();
    setNeedList(false);
    canvas.setPointerCapture(e.pointerId);
    const hit = painter.hit(...at(e));
    const node = hit ? model.byId.get(hit) : undefined;
    drag = { x: e.clientX, y: e.clientY, tx: painter.view.tx, ty: painter.view.ty, moved: false, dx: 0, dy: 0, ...(draggable(node) && !isProject(node) ? { node: node!.id } : {}) };
    // A project moves only after a long press: a plain drag from it pans, as from anywhere else.
    holdOff();
    holdOff = holdOn(node, (id) => {
      Object.assign(drag!, { node: id, lifted: true });
      userView = true;
      painter.lifted = id;
      canvas.style.cursor = "grabbing";
      kick();
    });
    canvas.classList.add("grab");
    hideTip();
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!drag) {
      const id = painter.hit(...at(e));
      canvas.style.cursor = id ? "pointer" : "";
      const tip = id ? hint(id) : "";
      if (tip) showTipAt(tip, e); else hideTip();
      return;
    }
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) {
      drag.moved = true;
      holdOff();
    }
    if (!drag.moved) return;
    if (drag.node) {
      // A hub or folder moves with everything under it; where it ends up is kept (per node id).
      const z = painter.view.zoom;
      shiftBranch(model, drag.node, dx / z - drag.dx, dy / z - drag.dy);
      [drag.dx, drag.dy] = [dx / z, dy / z];
      painter.invalidate();
      kick();
    } else setView({ ...painter.view, tx: drag.tx + dx, ty: drag.ty + dy });
  });
  const endDrag = (e: PointerEvent) => {
    canvas.classList.remove("grab");
    holdOff();
    painter.lifted = null;
    kick();
    const d = drag;
    drag = null;
    if (!d) return;
    if (d.node && d.moved) {
      offsets[d.node] = movedBy(offsets[d.node], d.dx, d.dy);
      localStorage.setItem(OFFSETS, JSON.stringify(offsets));
      model.bounds = boxOf(model, new Set(model.nodes.map((n) => n.id)));
      userView = true;
    }
    if (!d.moved && !d.lifted && e.type === "pointerup") select(painter.hit(...at(e)));
  };
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);
  canvas.addEventListener("mouseleave", hideTip);
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    touched = Date.now();
    holdOff();
    // A pinch arrives as ctrl+wheel with small deltas; a mouse notch is ~100.
    zoomAt(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), ...at(e));
  }, { passive: false });
  canvas.addEventListener("dblclick", (e) => {
    const id = painter.hit(...at(e));
    if (draggable(id ? model.byId.get(id) : undefined)) focus(id!);
  });

  function hint(id: string): string {
    const n = model.byId.get(id);
    if (!n) return "";
    if (n.kind === "sub") return [n.label, n.instr ? `${t("workflow.instructions")}: ${oneLine(n.instr, 200)}` : ""].filter(Boolean).join("\n");
    const move = isProject(n) ? t("wfmap.holdToMove") : "";
    if (n.session) {
      const s = input.sessions.find((x) => x.id === n.session);
      const goal = summarize(s?.workflow).goal;
      return [n.kind === "merged" ? `${n.label} · ${s?.label ?? ""}` : n.label, goal ? oneLine(goal, 200) : "", move].filter(Boolean).join("\n");
    }
    return move;
  }

  // ---------- selection, panel, focus
  const pcLabel = (id: string) => input.pcs.find((p) => p.id === id)?.label ?? "";
  const folderLabel = (id?: string) => input.folders.find((f) => f.id === id)?.label;
  function crumbs(id: string | null) {
    const n = id ? model.byId.get(id) : undefined;
    const parts = [t("app.name"), ...(n ? [pcLabel(n.pc), folderLabel(n.folder)] : [])].filter((p): p is string => !!p);
    crumb.replaceChildren(...parts.flatMap((p, i) => [...(i ? [h("i", "", "/")] : []), h(i === parts.length - 1 ? "b" : "span", "", p)]));
  }
  const panelDeps: PanelDeps = { ...deps, close: () => select(null) };
  /** What the open panel was drawn from: it is redrawn only when that changes. */
  function panelSource(id: string): string {
    const n = model.byId.get(id);
    const s = n?.session ? input.sessions.find((x) => x.id === n.session) : undefined;
    return s ? JSON.stringify([s, input.pcs, input.folders]) : seen;
  }
  function drawPanel(id: string | null, keepScroll: boolean) {
    const scroll = keepScroll ? panel.querySelector(".pb")?.scrollTop ?? 0 : 0;
    panelOpen = !!id && renderPanel(panel, input, model, id, panelDeps);
    panelFor = panelOpen ? panelSource(id!) : "";
    panel.hidden = !panelOpen;
    const pb = panel.querySelector(".pb");
    if (pb) pb.scrollTop = scroll;
  }
  function select(id: string | null) {
    painter.selected = id;
    painter.invalidate();
    const wasOpen = panelOpen;
    drawPanel(id, false);
    crumbs(focusId ?? id);
    // Keep the picked node clear of the panel that now covers the right side.
    const n = id ? model.byId.get(id) : undefined;
    if (n && panelOpen && !wasOpen) {
      const x = n.x * painter.view.zoom + painter.view.tx;
      if (x > mapW() - 120) setView({ ...painter.view, tx: painter.view.tx - (x - (mapW() - 260)) }, true);
    }
    kick();
  }
  function focus(id: string) {
    focusId = id;
    focusSet = branchOf(model, id);
    painter.focus = focusSet;
    const n = model.byId.get(id)!;
    const fl = folderLabel(n.folder);
    focusCrumb.replaceChildren(...(fl ? [pcLabel(n.pc) + " › ", h("b", "", fl)] : [h("b", "", pcLabel(n.pc))]));
    focusBar.hidden = false;
    crumbs(id);
    fitBox(boxOf(model, focusSet));
  }
  function unfocus() {
    painter.focus = null;
    focusId = null;
    focusSet = null;
    focusBar.hidden = true;
    crumbs(painter.selected);
    fitAll(true);
  }
  function selectSession(session: string) {
    const n = nodeOfSession(model, session);
    if (!n) return;
    if (focusSet && !focusSet.has(n.id)) unfocus();
    select(n.id);
    bringIn(n);
  }

  // ---------- strip
  function paintStrip() {
    const waiting = input.sessions.filter((s) => s.mood === "waiting");
    need.textContent = t("wfmap.need");
    need.append(" ", h("span", "wmNeedN", String(waiting.length)));
    const hubs = model.nodes.filter((n) => n.kind === "hub" && n.counts);
    const total = (k: "working" | "subagents" | "done") => hubs.reduce((a, n) => a + n.counts![k], 0);
    const item = (text: string, n: number, cls = "") => { const s = h("span", cls, text + " "); s.append(h("b", "", String(n))); return s; };
    sum.replaceChildren(item(t("wfmap.working"), total("working"), "work"), item(t("wfmap.subagents"), total("subagents")), item(t("wfmap.doneToday"), total("done")));
    needList.replaceChildren(...(waiting.length ? waiting.map((s) => {
      const li = h("li", "");
      // A button, so the list is reachable and usable from the keyboard.
      const go = h("button", "wmNeedItem");
      go.type = "button";
      const f = input.folders.find((x) => x.id === s.folder);
      go.append(h("i", "wmDot waiting"), h("span", "", s.workflow?.title ?? `${f?.label ?? ""} · ${s.label}`), h("small", "", `${pcLabel(f?.pc ?? "")} / ${f?.label ?? ""}`));
      go.addEventListener("click", () => { setNeedList(false); selectSession(s.id); });
      li.append(go);
      return li;
    }) : [h("li", "none", t("wfmap.needNone"))]));
  }
  function setFollow(on: boolean) {
    following = on;
    localStorage.setItem(FOLLOW, on ? "1" : "0");
    follow.classList.toggle("on", on);
    follow.setAttribute("aria-pressed", String(on));
    if (on) {
      touched = 0;
      const act = newestActive();
      if (act) bringIn(act);
    }
  }
  follow.classList.toggle("on", following);
  follow.setAttribute("aria-pressed", String(following));
  /** The working or waiting session with the newest step. */
  function newestActive(only?: Set<string>): MNode | undefined {
    const last = (id: string) => input.sessions.find((s) => s.id === id)?.workflow?.events.at(-1)?.at ?? 0;
    const act = input.sessions.filter((s) => (s.mood === "working" || s.mood === "waiting") && (!only || only.has(s.id))).sort((a, b) => last(b.id) - last(a.id))[0];
    return act && nodeOfSession(model, act.id);
  }

  // ---------- the title bar's pill
  pill.addEventListener("click", () => showWaiting());
  attachHover(pill, () => t("wfmap.waitingHint"));
  function showWaiting() {
    cycled = nextWaiting(input, cycled);
    if (cycled === undefined) return;
    if (!visible) deps.show();
    selectSession(cycled);
  }

  // ---------- data
  function refresh(): void {
    const next = deps.input();
    const json = JSON.stringify(next);
    if (json !== seen) {
      seen = json;
      input = next;
      const waiting = input.sessions.filter((s) => s.mood === "waiting").length;
      pill.hidden = waiting === 0 || visible;
      pill.textContent = t("wfmap.waiting", { n: waiting });
    }
    // Off screen the map waits: it is built (and laid out) when it opens.
    if (!visible || json === drawn) return;
    drawn = json;
    model = build(input, model, offsets, room());
    // New data mid-drag: what is held stays under the pointer.
    if (drag?.node) shiftBranch(model, drag.node, drag.dx, drag.dy);
    if (model.laidOut) laidOut++;
    // Offsets of hubs and folders that are gone (a PC or folder removed) are dropped.
    // PCs and folders come from settings, offline or not, so only a real removal prunes.
    const gone = input.pcs.length ? Object.keys(offsets).filter((id) => !model.byId.has(id)) : [];
    if (gone.length) {
      for (const id of gone) delete offsets[id];
      localStorage.setItem(OFFSETS, JSON.stringify(offsets));
    }
    painter.setModel(model);
    if (focusId && model.byId.has(focusId)) {
      focusSet = branchOf(model, focusId);
      painter.focus = focusSet;
    } else if (focusId) unfocus();
    empty.hidden = input.pcs.length > 0;
    paintStrip();
    crumbs(focusId ?? painter.selected);
    if (!userView && !focusId) fitAll(false);
    if (painter.selected && !model.byId.has(painter.selected)) select(null);
    else if (painter.selected && panelSource(painter.selected) !== panelFor) drawPanel(painter.selected, true);
    // 자동 관전: toward a session that just started working or began waiting, unless the map was touched in the last 30 s.
    const turned = new Set(input.sessions.filter((s) => (s.mood === "working" || s.mood === "waiting") && moods.has(s.id) && moods.get(s.id) !== s.mood).map((s) => s.id));
    moods = new Map(input.sessions.map((s) => [s.id, s.mood]));
    if (following && turned.size && Date.now() - touched > 30000) {
      const n = newestActive(turned);
      if (n) bringIn(n);
    }
    painter.invalidate();
    kick();
  }

  return {
    refresh,
    setVisible(on) {
      visible = on;
      pill.hidden = on || !input.sessions.some((s) => s.mood === "waiting");
      if (!on) {
        // Closed: its clouds and sprites go (spec 7); they are redrawn on return.
        painter.release();
        // The scene and screen bitmaps too (tens of MB at dpr 2); resize() gives them back on return.
        painter.resize(0, 0, 1);
        if (raf) cancelAnimationFrame(raf);
        raf = 0;
        setNeedList(false);
        hideTip();
        holdOff();
        painter.lifted = null;
        return;
      }
      // A theme or language switched while it was closed.
      painter.words = words();
      painter.setTheme(readTheme());
      resize();
    },
    showWaiting,
    escape() {
      if (!needList.hidden) setNeedList(false);
      else if (focusId) unfocus();
      else if (panelOpen) select(null);
      else return false;
      return true;
    },
    state: () => ({ selected: painter.selected, lifted: painter.lifted, focus: focusId, follow: following, themeReads, renders: painter.renders, laidOut, view: painter.view, bg: painter.theme.bg, panel: panelOpen }),
  };
}

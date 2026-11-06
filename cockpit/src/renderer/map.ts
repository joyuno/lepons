import type { MapState } from "../shared/ipc.ts";
import { t } from "../i18n/i18n.ts";
import { attachHover } from "./hover.ts";
import { agents, type AgentKind } from "../agent/agents.ts";

export interface MapActions {
  grant(repoWireId: string, consumerNodeId: string): Promise<void>;
  setMcpAgents(nodeId: string, agents: AgentKind[]): Promise<void>;
  revoke(repoWireId: string, consumerNodeId: string): Promise<void>;
  /** Stops suggesting a share. */
  dismiss(repoWireId: string, consumerNodeId: string): void;
}

/** A change to what a PC reads that is still being applied there, or that failed. */
export type ApplyState = { kind: "busy" } | { kind: "failed"; detail: string; retry: () => void };

const svgNamespace = "http://www.w3.org/2000/svg";

/** Fixed column pitch so the auto-layout grid stays regular; card heights still vary. */
const CARD_W = 224;
const GAP_X = 64;
const GAP_Y = 48;
// Matches .mapPad's own padding: absolutely-positioned cards ignore a container's
// CSS padding as a positioning inset, so the same numbers are re-applied here in JS.
const PAD_X = 28;
const PAD_Y = 26;
/** Extra canvas beyond the content bounds, so panning always has room. */
const PAN_SLACK = 240;

/**
 * Where each card currently sits, keyed by node id.
 *
 * `renderMap` rebuilds every card from scratch on every call (a grant or
 * revoke only ever touches `state.edges`), so an arrangement the operator
 * dragged into place has to survive that rebuild somewhere outside the DOM.
 * This module is a per-window singleton, so module scope is a safe enough
 * home for it without a new storage layer.
 */
const layout = new Map<string, { x: number; y: number }>();
/**
 * Cards the operator moved by hand; the automatic layout leaves those alone.
 * Only these are kept across launches -- the rest are laid out afresh anyway.
 * Read on the first render, not at import, which the layout tests do in Node.
 */
const placedByHand = new Set<string>();
let placedRead = false;
const savePlaced = (): void =>
  localStorage.setItem("mapPlaced", JSON.stringify(Object.fromEntries([...placedByHand].map((id) => [id, layout.get(id)]))));

interface Point {
  x: number;
  y: number;
}

type Side = "left" | "right" | "top" | "bottom";

interface DragState {
  startClientX: number;
  startClientY: number;
  startX: number;
  startY: number;
  dx: number;
  dy: number;
  frameScheduled: boolean;
}

/**
 * The sharing map.
 *
 * A line is a grant, not a picture of one: dragging a repository onto a node
 * creates the permission and clicking a line removes it. Nothing here is
 * decorative, because a diagram that merely describes configuration is the
 * thing that goes quietly out of date.
 */
export function renderMap(
  host: HTMLElement,
  state: MapState,
  actions: MapActions,
  sessionPreviews: Map<string, string>,
  zoom: number,
  applying: ReadonlyMap<string, ApplyState> = new Map(),
): void {
  if (!placedRead) {
    placedRead = true;
    // A bad saved value must not keep the map from drawing: skip it.
    try {
      const saved = JSON.parse(localStorage.getItem("mapPlaced") ?? "{}") as Record<string, { x?: unknown; y?: unknown } | null>;
      for (const [id, pos] of Object.entries(saved)) {
        if (!Number.isFinite(pos?.x) || !Number.isFinite(pos?.y)) continue;
        layout.set(id, { x: pos!.x as number, y: pos!.y as number });
        placedByHand.add(id);
      }
    } catch { /* not ours: start unplaced */ }
  }
  host.replaceChildren();
  if (state.nodes.length === 0) {
    const empty = document.createElement("div");
    empty.className = "mapEmpty";
    empty.textContent = t("map.empty");
    host.append(empty);
    return;
  }

  // A node the operator removed should not leave its position behind forever.
  const liveIds = new Set(state.nodes.map((node) => node.id));
  for (const id of [...layout.keys()]) {
    if (!liveIds.has(id)) layout.delete(id);
  }
  if ([...placedByHand].some((id) => !liveIds.has(id))) {
    for (const id of [...placedByHand]) if (!liveIds.has(id)) placedByHand.delete(id);
    savePlaced();
  }

  const board = document.createElement("div");
  board.className = "mapBoard mapPad";
  // What an arrow means, said once where every arrow can be seen: the
  // direction was the one thing operators kept guessing at. After the board
  // so it can stick to the view's bottom edge, clear of the top-left cards.
  const legend = document.createElement("div");
  legend.className = "mapLegend";
  const legendText = document.createElement("span");
  legendText.textContent = t("map.legend");
  legend.append(legendText);
  host.append(board, legend);

  // The SVG comes AFTER the board in the DOM, so edges paint over it and
  // stay hoverable/clickable -- underneath, the board (a full-area element)
  // swallowed every pointer event aimed at a line, which silently killed
  // click-to-revoke. The svg root itself is pointer-events:none; only the
  // strokes take events, so card and canvas gestures pass through.
  const lines = document.createElementNS(svgNamespace, "svg");
  lines.classList.add("mapLines");
  host.append(lines);

  // Dragging the empty canvas pans the whole map -- the gesture every
  // freely-positionable board teaches. Card drags never reach here: their
  // pointerdown starts on a .mapCard descendant, which this guard skips.
  let pan: { startX: number; startY: number; left: number; top: number } | null = null;
  board.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    if ((event.target as HTMLElement).closest(".mapCard")) return;
    board.setPointerCapture(event.pointerId);
    pan = { startX: event.clientX, startY: event.clientY, left: host.scrollLeft, top: host.scrollTop };
    document.body.classList.add("mapDragging");
  });
  board.addEventListener("pointermove", (event) => {
    if (!pan) return;
    host.scrollLeft = pan.left - (event.clientX - pan.startX);
    host.scrollTop = pan.top - (event.clientY - pan.startY);
  });
  const endPan = (event: PointerEvent): void => {
    if (!pan) return;
    board.releasePointerCapture(event.pointerId);
    pan = null;
    document.body.classList.remove("mapDragging");
  };
  board.addEventListener("pointerup", endPan);
  board.addEventListener("pointercancel", endPan);

  const cards = new Map<string, HTMLElement>();
  const chips = new Map<string, HTMLElement>();

  for (const node of state.nodes) {
    const card = document.createElement("div");
    card.className = "mapCard";

    const head = document.createElement("div");
    head.className = "mapCardHead";
    // One dot only: the activity lamp (same .lamp/.lamp.live the rail uses).
    // A second sharing-state dot used to sit next to it and read as a
    // duplicate "working" indicator -- removed on direct user feedback.
    const activity = document.createElement("span");
    activity.className = "lamp" + (node.active ? " live" : "");
    if (node.active) {
      const preview = [...sessionPreviews.entries()].find(
        ([key]) => key === node.id || key.startsWith(node.id + "::"),
      )?.[1];
      attachHover(activity, () => preview ?? t("state.ready"));
    }
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = node.label;
    const kind = document.createElement("span");
    kind.className = "kindTag";
    kind.textContent = node.kind === "local" ? "LOCAL" : "SSH";
    head.append(activity, name, kind);
    card.append(head);
    // Which of this PC's agents get what is shared to it, one switch each:
    // only on a PC something is shared to, the one place it means anything.
    if (state.edges.some((edge) => edge.consumerNodeId === node.id)) {
      const row = document.createElement("div");
      row.className = "mapAgents";
      const label = document.createElement("span");
      label.textContent = t("map.mcpFor");
      row.append(label);
      // Only the agents that are on: all five did not fit a card and stood one letter per line.
      // The rest wait behind "+", which turns into them in place.
      const switchFor = (agent: AgentKind): HTMLButtonElement => {
        const on = node.mcpAgents.includes(agent);
        const toggle = document.createElement("button");
        toggle.type = "button";
        toggle.className = `agentTag ${agent}` + (on ? " on" : " off");
        toggle.textContent = agents[agent].short;
        attachHover(toggle, () => t(on ? "map.mcpOn" : "map.mcpOff", { agent: toggle.textContent ?? agent }));
        toggle.addEventListener("pointerdown", (event) => event.stopPropagation());
        toggle.addEventListener("click", () => {
          const next = on ? node.mcpAgents.filter((other) => other !== agent) : [...node.mcpAgents, agent];
          void actions.setMcpAgents(node.id, next);
        });
        return toggle;
      };
      const all = Object.keys(agents) as AgentKind[];
      for (const agent of all.filter((kind) => node.mcpAgents.includes(kind))) row.append(switchFor(agent));
      const off = all.filter((kind) => !node.mcpAgents.includes(kind));
      if (off.length) {
        const more = document.createElement("button");
        more.type = "button";
        more.className = "agentTag more";
        more.textContent = "+";
        attachHover(more, () => t("map.mcpMore"));
        more.addEventListener("pointerdown", (event) => event.stopPropagation());
        more.addEventListener("click", () => more.replaceWith(...off.map(switchFor)));
        row.append(more);
      }
      card.append(row);
    }
    // Registering on another PC takes seconds; without this the line or the
    // switch looked as if nothing had happened, and was clicked again.
    const apply = applying.get(node.id);
    if (apply?.kind === "busy") {
      const busy = document.createElement("div");
      busy.className = "mapApplying";
      busy.textContent = t("map.applying");
      card.append(busy);
    } else if (apply?.kind === "failed") {
      const failed = document.createElement("button");
      failed.type = "button";
      failed.className = "warn mapApplyFailed";
      failed.textContent = t("map.applyFailed");
      if (apply.detail) attachHover(failed, () => apply.detail);
      failed.addEventListener("pointerdown", (event) => event.stopPropagation());
      failed.addEventListener("click", apply.retry);
      card.append(failed);
    }
    if (node.reconnecting) {
      const down = document.createElement("div");
      down.className = "warn";
      down.textContent = t("share.reconnecting");
      card.append(down);
    }

    // Card repositioning runs on Pointer Events, a separate pipeline from the
    // native HTML5 drag-and-drop below (chip -> card grants), so the two
    // never compete for the same gesture.
    let dragState: DragState | null = null;

    const applyDragFrame = (): void => {
      if (!dragState) return;
      dragState.frameScheduled = false;
      const x = dragState.startX + dragState.dx;
      const y = dragState.startY + dragState.dy;
      layout.set(node.id, { x, y });
      card.style.transform = `translate3d(${x}px, ${y}px, 0)`;
      resizeBoard(host, board, cards, zoom);
      drawEdges(host, lines, state, cards, chips, actions);
    };

    head.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      head.setPointerCapture(event.pointerId);
      const pos = layout.get(node.id) ?? { x: 0, y: 0 };
      dragState = {
        startClientX: event.clientX,
        startClientY: event.clientY,
        startX: pos.x,
        startY: pos.y,
        dx: 0,
        dy: 0,
        frameScheduled: false,
      };
      card.classList.add("dragging");
      document.body.classList.add("mapDragging");
    });
    head.addEventListener("pointermove", (event) => {
      if (!dragState) return;
      dragState.dx = event.clientX - dragState.startClientX;
      dragState.dy = event.clientY - dragState.startClientY;
      if (!dragState.frameScheduled) {
        dragState.frameScheduled = true;
        requestAnimationFrame(applyDragFrame);
      }
    });
    const endDrag = (event: PointerEvent): void => {
      if (!dragState) return;
      if (dragState.dx !== 0 || dragState.dy !== 0) {
        placedByHand.add(node.id);
        savePlaced();
      }
      head.releasePointerCapture(event.pointerId);
      card.classList.remove("dragging");
      document.body.classList.remove("mapDragging");
      dragState = null;
    };
    head.addEventListener("pointerup", endDrag);
    head.addEventListener("pointercancel", endDrag);

    const owned = state.repos.filter((repo) => repo.ownerNodeId === node.id);
    if (owned.length === 0) {
      const none = document.createElement("div");
      none.className = "mapNoRepo";
      none.textContent = t("map.noRepo");
      card.append(none);
    }
    // Folders the operator chose and an agent's own session data read the same
    // once shared, but they are not the same kind of thing to grant: grouped
    // under their own small headers instead of one flat list.
    const groups: Array<{ kind: (typeof owned)[number]["kind"]; label: string }> = [
      { kind: "folder", label: t("map.folders") },
      { kind: "agentData", label: t("map.agentData") },
    ];
    for (const group of groups) {
      const repos = owned.filter((repo) => repo.kind === group.kind);
      if (repos.length === 0) continue;
      const header = document.createElement("div");
      header.className = "mapGroupHead";
      header.textContent = group.label;
      card.append(header);
      for (const repo of repos) {
        const chip = document.createElement("div");
        chip.className = "mapRepo mapRepo-" + repo.kind;
        chip.textContent = repo.label;
        chip.draggable = true;
        attachHover(chip, () => t("map.dragHint"));
        chip.addEventListener("dragstart", (event) => {
          event.dataTransfer?.setData("text/plain", repo.wireId);
          chip.classList.add("dragging");
        });
        chip.addEventListener("dragend", () => chip.classList.remove("dragging"));
        chips.set(repo.wireId, chip);
        card.append(chip);
      }
    }

    // A node cannot be granted its own repository, so it does not accept one:
    // refusing the drop is clearer than accepting it and silently doing nothing.
    card.addEventListener("dragover", (event) => {
      const wireId = event.dataTransfer?.getData("text/plain");
      if (wireId && state.repos.find((r) => r.wireId === wireId)?.ownerNodeId === node.id) return;
      event.preventDefault();
      card.classList.add("dropTarget");
    });
    card.addEventListener("dragleave", () => card.classList.remove("dropTarget"));
    card.addEventListener("drop", (event) => {
      event.preventDefault();
      card.classList.remove("dropTarget");
      const wireId = event.dataTransfer?.getData("text/plain");
      if (!wireId) return;
      const repo = state.repos.find((candidate) => candidate.wireId === wireId);
      if (!repo || repo.ownerNodeId === node.id) return;
      void actions.grant(wireId, node.id);
    });

    cards.set(node.id, card);
    board.append(card);
  }

  // Two-pass: every card is in the DOM (stacked invisibly at 0,0) so its real
  // height can be measured, then positions -- stored ones reused verbatim, new
  // ones from the auto-layout grid -- are assigned and applied together.
  assignGridLayout(host, state, cards);
  for (const node of state.nodes) {
    const pos = layout.get(node.id);
    const card = cards.get(node.id);
    if (!pos || !card) continue;
    card.style.transform = `translate3d(${pos.x}px, ${pos.y}px, 0)`;
  }
  resizeBoard(host, board, cards, zoom);

  // Positions only exist after layout, so the edges are drawn on the next frame.
  requestAnimationFrame(() => drawEdges(host, lines, state, cards, chips, actions));
}

/**
 * Deterministic grid keyed by node index, run only for nodes that have no
 * stored position yet. A circular layout would center just as easily, but
 * this board's cards range from ~40px (nothing shared) to 200px+ (folders +
 * agent data), and a packed grid handles that spread via a
 * per-row height where an equal-radius ring would either waste space around
 * short cards or clip tall ones.
 */
function assignGridLayout(host: HTMLElement, state: MapState, cards: Map<string, HTMLElement>): void {
  const availW = host.clientWidth - PAD_X * 2;
  const availH = host.clientHeight - PAD_Y * 2;
  const columns = Math.max(1, Math.floor((availW + GAP_X) / (CARD_W + GAP_X)));
  const rows = Math.ceil(state.nodes.length / columns);

  const rowHeight: number[] = Array.from({ length: rows }, () => 0);
  state.nodes.forEach((node, i) => {
    const row = Math.floor(i / columns);
    const card = cards.get(node.id);
    if (!card) return;
    rowHeight[row] = Math.max(rowHeight[row] ?? 0, card.offsetHeight);
  });

  const gridW = columns * CARD_W + (columns - 1) * GAP_X;
  const gridH = rowHeight.reduce((sum, h) => sum + h, 0) + (rows - 1) * GAP_Y;
  // Absolutely-positioned cards ignore the container's CSS padding as an
  // inset, so the origin has to be measured from the container's unpadded
  // edge and then have the padding re-added -- not clamped to it. Clamping
  // to PAD_X/PAD_Y directly (the previous bug) is short by exactly that much
  // whenever slack exceeds the minimum padding.
  const originX = PAD_X + Math.max(0, (availW - gridW) / 2);
  const originY = PAD_Y + Math.max(0, (availH - gridH) / 2);

  // Slots in reading order, enough rows that every node could need its own.
  // Rows past the measured ones borrow the tallest card, so a generated slot
  // is never shorter than what may land in it.
  const tallest = Math.max(0, ...[...cards.values()].map((card) => card.offsetHeight));
  const slots: Point[] = [];
  for (let row = 0; row < state.nodes.length; row++) {
    let y = originY;
    for (let r = 0; r < row; r++) y += (rowHeight[r] ?? tallest) + GAP_Y;
    for (let col = 0; col < columns; col++) {
      slots.push({ x: originX + col * (CARD_W + GAP_X), y });
    }
  }

  // Every card the operator has not moved is laid out again, so a new line
  // on the map pulls its two PCs together instead of leaving them where the
  // list order put them.
  for (const id of [...layout.keys()]) if (!placedByHand.has(id)) layout.delete(id);
  const taken: Occupied[] = [];
  for (const node of state.nodes) {
    const pos = layout.get(node.id);
    if (pos) taken.push({ ...pos, h: cards.get(node.id)?.offsetHeight ?? 0 });
  }

  const owner = new Map(state.repos.map((repo) => [repo.wireId, repo.ownerNodeId]));
  const links = state.edges.flatMap((edge) => {
    const from = owner.get(edge.repoWireId);
    return from === undefined ? [] : [[from, edge.consumerNodeId] as [string, string]];
  });
  const order = connectedFirst(state.nodes.map((node) => node.id), links);
  const heights = new Map([...cards].map(([id, card]) => [id, card.offsetHeight]));
  const fixed = [...layout].map(([id, pos]) => ({ id, ...pos, h: heights.get(id) ?? 0 }));
  const clear = placeClear(order.filter((id) => !layout.has(id)), heights, slots, fixed, links);
  if (clear) {
    // The origin above centred the rows reading order would fill; the search
    // may use fewer or more of them, so the result is centred again -- unless
    // a card the operator placed pins where everything else must sit.
    let dx = 0;
    let dy = 0;
    if (fixed.length === 0 && clear.size > 0) {
      const at = [...clear].map(([id, pos]) => ({ ...pos, h: heights.get(id) ?? 0 }));
      const left = Math.min(...at.map((pos) => pos.x));
      const top = Math.min(...at.map((pos) => pos.y));
      const width = Math.max(...at.map((pos) => pos.x + CARD_W)) - left;
      const height = Math.max(...at.map((pos) => pos.y + pos.h)) - top;
      dx = PAD_X + Math.max(0, (availW - width) / 2) - left;
      dy = PAD_Y + Math.max(0, (availH - height) / 2) - top;
    }
    for (const [id, pos] of clear) layout.set(id, { x: pos.x + dx, y: pos.y + dy });
    return;
  }
  for (const node of [...state.nodes].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id))) {
    if (layout.has(node.id)) continue;
    const h = cards.get(node.id)?.offsetHeight ?? 0;
    const spot = firstFreeSlot(slots, h, taken);
    layout.set(node.id, spot);
    taken.push({ ...spot, h });
  }
}

/**
 * The order cards fill the grid in: PCs that share with each other first and
 * next to each other, unconnected ones after. Each group of linked PCs is
 * walked breadth-first from its busiest member, so a PC lands beside the ones
 * it has lines to and the lines stay short instead of crossing other cards
 * on the way; the busiest one sits between its first two neighbours. Bigger and busier groups first; ties keep the list's order.
 */
export function connectedFirst(ids: readonly string[], links: ReadonlyArray<readonly [string, string]>): string[] {
  const neighbours = new Map(ids.map((id) => [id, new Set<string>()]));
  for (const [a, b] of links) {
    if (a === b || !neighbours.has(a) || !neighbours.has(b)) continue;
    neighbours.get(a)!.add(b);
    neighbours.get(b)!.add(a);
  }
  const degree = (id: string) => neighbours.get(id)!.size;
  const busiest = (group: readonly string[]) =>
    [...group].sort((a, b) => degree(b) - degree(a) || ids.indexOf(a) - ids.indexOf(b));

  const seen = new Set<string>();
  const groups: string[][] = [];
  for (const start of busiest(ids)) {
    if (seen.has(start)) continue;
    const group: string[] = [];
    const queue = [start];
    seen.add(start);
    while (queue.length > 0) {
      const id = queue.shift()!;
      group.push(id);
      for (const next of busiest([...neighbours.get(id)!])) {
        if (seen.has(next)) continue;
        seen.add(next);
        queue.push(next);
      }
    }
    // The busiest PC goes second, between its first two neighbours: first,
    // it sat at the row's end and its line to the far neighbour ran across
    // the card between them.
    if (group.length >= 3) [group[0], group[1]] = [group[1]!, group[0]!];
    groups.push(group);
  }
  const weight = (group: readonly string[]) => group.reduce((sum, id) => sum + degree(id), 0);
  groups.sort((a, b) => b.length - a.length || weight(b) - weight(a) || ids.indexOf(a[0]!) - ids.indexOf(b[0]!));
  return groups.flat();
}

export interface Occupied extends Point {
  h: number;
}

/**
 * The first slot no card already sits on.
 *
 * Index alone used to decide this, and that is what made a newly connected
 * machine look like it had never been added: stored positions are absolute
 * pixels from whenever a card was last placed or dragged, while the grid's
 * origin re-centres on every render as the board grows. Once those two
 * frames drift apart, the slot computed for a new card lands on top of an
 * existing one and the operator sees a stack instead of a new machine.
 * Occupancy decides, so overlap cannot be reintroduced by drift, a resize,
 * or an arrangement the operator dragged into place.
 */
export function firstFreeSlot(
  slots: readonly Point[],
  height: number,
  taken: readonly Occupied[],
): Point {
  const clear = slots.find(
    (slot) =>
      !taken.some(
        (other) =>
          slot.x < other.x + CARD_W &&
          slot.x + CARD_W > other.x &&
          slot.y < other.y + other.h &&
          slot.y + height > other.y,
      ),
  );
  if (clear) return clear;
  // Every slot spoken for: go below everything rather than on top of anything.
  const floor = taken.reduce((low, other) => Math.max(low, other.y + other.h), PAD_Y);
  return { x: slots[0]?.x ?? PAD_X, y: floor + GAP_Y };
}

// ponytail: exhaustive search -- 5 PCs all sharing with each other is ~75ms,
// 6 is ~1s. Past this the reading-order fill takes over; a smarter search
// (or a cache keyed on the links) if larger maps become common.
const SEARCH_LIMIT = 5;

/**
 * Positions for `ids` such that as few lines as possible run through a card
 * they do not belong to, then the shortest lines, then the earliest slots.
 *
 * Reading order alone put three PCs that all share with one another in a
 * row, and the line between the two ends ran through the middle card. Every
 * assignment of these cards to the first free slots is tried, cutting any
 * branch that already scores worse than the best found. `fixed` are cards the operator moved:
 * never covered, and their own lines count. Undefined past SEARCH_LIMIT.
 */
export function placeClear(
  ids: readonly string[],
  heights: ReadonlyMap<string, number>,
  slots: readonly Point[],
  fixed: readonly (Occupied & { id?: string })[],
  links: ReadonlyArray<readonly [string, string]>,
): Map<string, Point> | undefined {
  if (ids.length > SEARCH_LIMIT) return undefined;
  const tallest = Math.max(0, ...ids.map((id) => heights.get(id) ?? 0));
  const free = slots
    .filter((slot) => !fixed.some((other) => overlapsBox({ ...slot, h: tallest }, other)))
    .slice(0, ids.length + SEARCH_LIMIT);
  const boxes = new Map<string, Occupied>();
  for (const card of fixed) if (card.id !== undefined) boxes.set(card.id, card);

  // A partial placement only gets worse as cards are added -- more lines
  // drawn, more cards to cross -- so its score bounds every completion and
  // a branch that already loses is dropped.
  const score = (slotCost: number): number => {
    let length = 0;
    for (const [a, b] of links) {
      const from = boxes.get(a);
      const to = boxes.get(b);
      // Rows sit closer than columns; doubled, a chain stays a row on a wide board.
      if (from && to) length += Math.abs(from.x - to.x) + 2 * Math.abs(from.y - to.y);
    }
    return lineCrossings(boxes, links) * 1e6 + length + slotCost;
  };
  let best: { score: number; at: Map<string, Point> } | undefined;
  const used = new Set<number>();
  const visit = (i: number, slotCost: number): void => {
    const now = score(slotCost);
    if (best && now >= best.score) return;
    if (i === ids.length) {
      best = { score: now, at: new Map(ids.map((id) => [id, { x: boxes.get(id)!.x, y: boxes.get(id)!.y }])) };
      return;
    }
    const id = ids[i]!;
    for (let s = 0; s < free.length; s++) {
      if (used.has(s)) continue;
      const box = { ...free[s]!, h: heights.get(id) ?? 0 };
      if ([...boxes.values()].some((other) => overlapsBox(box, other))) continue;
      used.add(s);
      boxes.set(id, box);
      visit(i + 1, slotCost + s);
      boxes.delete(id);
      used.delete(s);
    }
  };
  visit(0, 0);
  return best?.at;
}

function overlapsBox(a: Occupied, b: Occupied): boolean {
  return a.x < b.x + CARD_W && a.x + CARD_W > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/**
 * How many lines pass through a card that is neither of their ends. A line
 * is taken centre to centre, and cards are widened by the most a drawn
 * curve bows, so a near miss counts as a hit.
 */
export function lineCrossings(
  boxes: ReadonlyMap<string, Occupied>,
  links: ReadonlyArray<readonly [string, string]>,
): number {
  const bow = 16;
  let count = 0;
  for (const [a, b] of links) {
    const from = boxes.get(a);
    const to = boxes.get(b);
    if (!from || !to || a === b) continue;
    const p = { x: from.x + CARD_W / 2, y: from.y + from.h / 2 };
    const q = { x: to.x + CARD_W / 2, y: to.y + to.h / 2 };
    for (const [id, box] of boxes) {
      if (id === a || id === b) continue;
      if (segmentHitsRect(p, q, box.x - bow, box.y - bow, box.x + CARD_W + bow, box.y + box.h + bow)) count++;
    }
  }
  return count;
}

/** Liang-Barsky: whether the segment p-q enters the rectangle at all. */
function segmentHitsRect(p: Point, q: Point, left: number, top: number, right: number, bottom: number): boolean {
  const dx = q.x - p.x;
  const dy = q.y - p.y;
  let t0 = 0;
  let t1 = 1;
  for (const [edge, dist] of [[-dx, p.x - left], [dx, right - p.x], [-dy, p.y - top], [dy, bottom - p.y]] as const) {
    if (edge === 0) {
      if (dist < 0) return false;
      continue;
    }
    const t = dist / edge;
    if (edge < 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    if (t0 > t1) return false;
  }
  return true;
}

/**
 * Absolutely-positioned cards no longer contribute to the board's intrinsic
 * size, so it has to be sized explicitly after every layout or drag update --
 * otherwise #map's overflow:auto has nothing to scroll to and a card dragged
 * past the initial viewport becomes unreachable.
 */
function resizeBoard(
  host: HTMLElement,
  board: HTMLElement,
  cards: Map<string, HTMLElement>,
  zoom: number,
): void {
  let maxRight = 0;
  let maxBottom = 0;
  for (const [nodeId, pos] of layout) {
    const card = cards.get(nodeId);
    if (!card) continue;
    maxRight = Math.max(maxRight, pos.x + card.offsetWidth);
    maxBottom = Math.max(maxBottom, pos.y + card.offsetHeight);
  }
  // PAN_SLACK of extra canvas past the content bounds, so there is always
  // somewhere to pan into and room to drag a card outward -- an exactly
  // content-sized board would make the pan gesture a no-op until a card
  // had already been dragged past the edge some other way.
  const width = Math.max(host.clientWidth, maxRight + PAD_X) + PAN_SLACK;
  const height = Math.max(host.clientHeight, maxBottom + PAD_Y) + PAN_SLACK;
  board.style.width = `${width}px`;
  board.style.height = `${height}px`;
  // A transform does not change layout, so without the margin the scroll area
  // stays the unscaled size and a zoomed-in board loses its far edge.
  board.style.transformOrigin = "0 0";
  board.style.transform = `scale(${zoom})`;
  board.style.marginRight = `${width * (zoom - 1)}px`;
  board.style.marginBottom = `${height * (zoom - 1)}px`;
}

function drawEdges(
  host: HTMLElement,
  lines: SVGSVGElement,
  state: MapState,
  cards: Map<string, HTMLElement>,
  chips: Map<string, HTMLElement>,
  actions: MapActions,
): void {
  const frame = host.getBoundingClientRect();
  lines.setAttribute("viewBox", `0 0 ${frame.width} ${frame.height}`);
  lines.setAttribute("width", String(frame.width));
  lines.setAttribute("height", String(frame.height));
  lines.replaceChildren();

  // Two markers rather than one. `context-stroke` (letting the arrowhead pick
  // up whatever colour the path currently has) paints nothing in this Electron
  // build -- confirmed live, not just in a headless test -- so a hovered edge
  // keeps its grey head while the line changes colour, and the head is the
  // part the eye lands on. A second marker in the hover colour, swapped by CSS
  // on :hover, buys the whole edge one colour for a few lines of markup.
  const defs = document.createElementNS(svgNamespace, "defs");
  for (const [id, fill] of [
    ["mapArrow", "var(--muted)"],
    ["mapArrowHot", "var(--live)"],
  ] as const) {
    const hot = document.createElementNS(svgNamespace, "marker");
    hot.setAttribute("id", id);
    hot.setAttribute("viewBox", "0 0 10 10");
    hot.setAttribute("refX", "8.5");
    hot.setAttribute("refY", "5");
    hot.setAttribute("markerWidth", "7");
    hot.setAttribute("markerHeight", "7");
    hot.setAttribute("orient", "auto-start-reverse");
    const head = document.createElementNS(svgNamespace, "path");
    head.setAttribute("d", "M 0 0 L 10 5 L 0 10 z");
    head.setAttribute("fill", fill);
    hot.append(head);
    defs.append(hot);
  }
  lines.append(defs);

  // Grouping rules, shaped by direct user feedback on the live map:
  // - Agent-data grants run data-to-data: the arrow connects the two
  //   machines' chips for the same agent, at their exact rows.
  // - Everything else collapses to ONE line per machine pair. Sharing in
  //   both directions -- whichever items are involved -- is one mutual
  //   relationship: a single double-headed arrow, never two overlapping
  //   one-way arrows. The specific item names live in the hover title.
  interface Drawable {
    key: string;
    fromNodeId: string;
    fromCard: HTMLElement;
    toCard: HTMLElement;
    /** The item chips each end represents; anchors the line at their rows. */
    fromChips: HTMLElement[];
    toChips: HTMLElement[];
    labelsOut: string[];
    labelsBack: string[];
    grants: Array<{ repoWireId: string; consumerNodeId: string }>;
    /** Set on a share not made yet: the package that suggested it. */
    suggested?: string;
  }
  const drawables: Drawable[] = [];
  for (const edge of state.edges) {
    const repo = state.repos.find((candidate) => candidate.wireId === edge.repoWireId);
    if (!repo) continue;
    const fromCardEl = cards.get(repo.ownerNodeId);
    const toCardEl = cards.get(edge.consumerNodeId);
    if (!fromCardEl || !toCardEl) continue;
    const sourceChip = chips.get(edge.repoWireId);

    if (repo.kind === "agentData") {
      const twin = state.repos.find(
        (candidate) =>
          candidate.ownerNodeId === edge.consumerNodeId &&
          candidate.kind === "agentData" &&
          candidate.label === repo.label,
      );
      const twinChip = twin === undefined ? undefined : chips.get(twin.wireId);
      if (twin && sourceChip && twinChip) {
        const key = "data:" + [edge.repoWireId, twin.wireId].sort().join("|");
        const existing = drawables.find((candidate) => candidate.key === key);
        if (existing) {
          existing.labelsBack.push(repo.label);
          existing.grants.push(edge);
        } else {
          drawables.push({
            key,
            fromNodeId: repo.ownerNodeId,
            fromCard: fromCardEl,
            toCard: toCardEl,
            fromChips: [sourceChip],
            toChips: [twinChip],
            labelsOut: [repo.label],
            labelsBack: [],
            grants: [edge],
          });
        }
        continue;
      }
    }

    const key = "pair:" + [repo.ownerNodeId, edge.consumerNodeId].sort().join("|");
    const existing = drawables.find((candidate) => candidate.key === key);
    if (existing) {
      const outbound = repo.ownerNodeId === existing.fromNodeId;
      (outbound ? existing.labelsOut : existing.labelsBack).push(repo.label);
      if (sourceChip) (outbound ? existing.fromChips : existing.toChips).push(sourceChip);
      existing.grants.push(edge);
      continue;
    }
    drawables.push({
      key,
      fromNodeId: repo.ownerNodeId,
      fromCard: fromCardEl,
      toCard: toCardEl,
      fromChips: sourceChip ? [sourceChip] : [],
      toChips: [],
      labelsOut: [repo.label],
      labelsBack: [],
      grants: [edge],
    });
  }

  // A suggestion is its own line, beside any real one between the same PCs.
  for (const suggestion of state.suggestions ?? []) {
    const repo = state.repos.find((candidate) => candidate.wireId === suggestion.repoWireId);
    const fromCard = repo && cards.get(repo.ownerNodeId);
    const toCard = cards.get(suggestion.consumerNodeId);
    if (!repo || !fromCard || !toCard) continue;
    const chip = chips.get(repo.wireId);
    drawables.push({
      key: `suggest:${repo.wireId}|${suggestion.consumerNodeId}`,
      fromNodeId: repo.ownerNodeId,
      fromCard,
      toCard,
      fromChips: chip ? [chip] : [],
      toChips: [],
      labelsOut: [repo.label],
      labelsBack: [],
      grants: [suggestion],
      suggested: suggestion.name,
    });
  }

  // The SVG scrolls with the board, so its points live in content
  // coordinates -- viewport-relative math has to add the scroll offset
  // back, or every edge drawn while the map is panned lands shifted.
  const scrollX = host.scrollLeft;
  const scrollY = host.scrollTop;

  for (const drawable of drawables) {
    const both = drawable.labelsBack.length > 0;
    const a = drawable.fromCard.getBoundingClientRect();
    const b = drawable.toCard.getBoundingClientRect();
    const aCenter: Point = { x: a.left - frame.left + a.width / 2, y: a.top - frame.top + a.height / 2 };
    const bCenter: Point = { x: b.left - frame.left + b.width / 2, y: b.top - frame.top + b.height / 2 };

    // Both ends anchor on their card's outer border, at the row of the item
    // chip(s) the line represents -- not the card's vertical centre, which
    // read as "somewhere below the folder" the moment a card had more than
    // one section. A folder's receiving end has no matching chip, so it
    // takes the sending side's row, clamped to the card.
    const p1 = cardAnchor(drawable.fromCard, drawable.fromChips, frame, bCenter);
    const p2 = cardAnchor(drawable.toCard, drawable.toChips, frame, aCenter, p1.point.y);
    p1.point.x += scrollX;
    p1.point.y += scrollY;
    p2.point.x += scrollX;
    p2.point.y += scrollY;

    // Curviness as a fraction of the endpoint distance, clamped: never
    // overshoots when two cards are dragged close together, never goes flat
    // when they are far apart.
    const dist = Math.hypot(p2.point.x - p1.point.x, p2.point.y - p1.point.y);
    const offset = Math.min(96, Math.max(24, dist * 0.4));
    const c1 = movePoint(p1.point, p1.side, offset);
    const c2 = movePoint(p2.point, p2.side, offset);

    // A one-way line bows to the right of its direction of travel so that
    // two unrelated one-way lines between the same cards (a folder one way,
    // agent data the other, unmerged) can never overlap into what reads as
    // a single double-headed arrow. A genuinely mutual line stays straight.
    if (!both && dist > 0) {
      const bowX = (-(p2.point.y - p1.point.y) / dist) * 14;
      const bowY = ((p2.point.x - p1.point.x) / dist) * 14;
      c1.x += bowX;
      c1.y += bowY;
      c2.x += bowX;
      c2.y += bowY;
    }

    const path = document.createElementNS(svgNamespace, "path");
    path.setAttribute(
      "d",
      `M ${p1.point.x} ${p1.point.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${p2.point.x} ${p2.point.y}`,
    );
    path.setAttribute("marker-end", "url(#mapArrow)");
    if (both) path.setAttribute("marker-start", "url(#mapArrow)");
    path.classList.add("mapEdge");
    if (drawable.suggested !== undefined) {
      const grant = drawable.grants[0]!;
      const label = (id: string) => state.nodes.find((node) => node.id === id)?.label ?? id;
      path.classList.add("suggested");
      path.addEventListener("click", () => void actions.grant(grant.repoWireId, grant.consumerNodeId));
      path.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        actions.dismiss(grant.repoWireId, grant.consumerNodeId);
      });
      attachHover(path, () => t("map.suggest", {
        reader: label(grant.consumerNodeId), owner: label(drawable.fromNodeId), items: drawable.labelsOut[0]!, name: drawable.suggested!,
      }));
      lines.append(path);
      continue;
    }
    // The line is the permission, so clicking it is how the permission goes.
    // A merged line is several permissions; cutting it cuts them all.
    path.addEventListener("click", () => {
      for (const grant of drawable.grants) void actions.revoke(grant.repoWireId, grant.consumerNodeId);
    });
    // The item names live in the hover (adding received-item chips to the
    // destination card was tried and rejected) -- the app's own tooltip,
    // not the browser's native title bubble.
    // Said as a sentence about who reads what, in both directions when both.
    const nameOf = (id: string) => state.nodes.find((node) => node.id === id)?.label ?? id;
    // The first grant is always the outbound one: fromNodeId owns it.
    const owner = drawable.fromNodeId;
    const reader = drawable.grants[0]!.consumerNodeId;
    const sentences = [t("map.reads", { reader: nameOf(reader), owner: nameOf(owner), items: drawable.labelsOut.join(", ") })];
    if (both) sentences.push(t("map.reads", { reader: nameOf(owner), owner: nameOf(reader), items: drawable.labelsBack.join(", ") }));
    attachHover(path, () => `${sentences.join("\n")}\n${t("map.cutHint")}`);
    lines.append(path);
  }
}

/**
 * Where a ray from `rect`'s center toward `target` crosses `rect`'s own
 * boundary, plus which side it crossed. The same formula used by React
 * Flow's floating-edges example: it collapses "left of / right of / above /
 * below / overlapping columns" into one calculation, no side-case branching.
 */
function boundaryPoint(rect: DOMRect, frame: DOMRect, target: Point): { point: Point; side: Side } {
  const hw = rect.width / 2;
  const hh = rect.height / 2;
  const cx = rect.left - frame.left + hw;
  const cy = rect.top - frame.top + hh;
  const dx = target.x - cx;
  const dy = target.y - cy;
  if (dx === 0 && dy === 0) return { point: { x: cx, y: cy }, side: "right" };

  const scale = 1 / Math.max(Math.abs(dx) / hw, Math.abs(dy) / hh);
  const point: Point = { x: cx + dx * scale, y: cy + dy * scale };
  const side: Side =
    Math.abs(dx) / hw >= Math.abs(dy) / hh ? (dx >= 0 ? "right" : "left") : dy >= 0 ? "bottom" : "top";
  return { point, side };
}

/**
 * Where an edge attaches to a card: on the card's outer border, at the mean
 * row of the item chips this end represents. An end with no chips (a folder
 * grant's receiving side) takes `fallbackY` -- the sending side's row --
 * clamped into the card, so the line runs at the item's height rather than
 * the card's middle. Top/bottom approaches keep the plain boundary point,
 * where row alignment means nothing.
 */
function cardAnchor(
  card: HTMLElement,
  itemChips: HTMLElement[],
  frame: DOMRect,
  target: Point,
  fallbackY?: number,
): { point: Point; side: Side } {
  const rect = card.getBoundingClientRect();
  const base = boundaryPoint(rect, frame, target);
  if (base.side !== "left" && base.side !== "right") return base;
  let y: number | undefined;
  if (itemChips.length > 0) {
    y =
      itemChips.reduce((sum, chip) => {
        const r = chip.getBoundingClientRect();
        return sum + r.top - frame.top + r.height / 2;
      }, 0) / itemChips.length;
  } else if (fallbackY !== undefined) {
    y = Math.min(Math.max(fallbackY, rect.top - frame.top + 10), rect.bottom - frame.top - 10);
  }
  if (y === undefined) return base;
  return { point: { x: base.point.x, y }, side: base.side };
}

function movePoint(point: Point, side: Side, dist: number): Point {
  switch (side) {
    case "right":
      return { x: point.x + dist, y: point.y };
    case "left":
      return { x: point.x - dist, y: point.y };
    case "top":
      return { x: point.x, y: point.y - dist };
    case "bottom":
      return { x: point.x, y: point.y + dist };
  }
}

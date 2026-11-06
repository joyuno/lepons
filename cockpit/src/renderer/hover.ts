/**
 * One themed tooltip for the whole window, replacing the browser's native
 * title bubble (which ignores the app's dark theme and takes a second to
 * appear). Fixed-position, follows the pointer, never intercepts events.
 *
 * DOM setup (the tip element and the document-level listeners) is deferred
 * to first use rather than run at import time, so this module stays
 * importable under `node --test`, which has no `document`. hover.test.ts
 * guards that property and nothing else -- the behaviour here needs a
 * browser to exercise.
 */
let tip: HTMLDivElement | null = null;

// A click usually replaces the view, destroying the hovered element before
// its mouseleave can ever fire -- which left the tip stranded on screen.
// Hiding on click alone was not enough (QA-caught): when the click swaps
// the DOM under a stationary pointer, Chromium re-runs hit-testing on the
// next frame and fires a synthetic mouseenter on whatever now sits there,
// re-opening the tip with that element's text. So after a click the tip
// stays suppressed until the pointer has actually MOVED -- a synthetic
// event replays the same coordinates and cannot unsuppress it.
let suppressAt: { x: number; y: number } | null = null;

// The element a click has pinned the tip to, or null. Pinning must not
// collide with the plain click that every hover-attached element already
// answers to (a node opens detail, a pill opens detail, a disclosure
// triangle re-renders the rail, an edge revokes a grant and re-renders the
// map) -- an earlier attempt made plain click the pin gesture and a
// listener added to the element could not stop the element's OWN handler,
// since at-target listeners run in registration order. So pinning uses
// Alt+click, recognised and fully intercepted on `document` in the capture
// phase (capture on document runs before anything on the target), which
// leaves plain clicks exactly as every caller already wired them.
let pinnedFor: Element | null = null;

// Elements attachHover has wired, each with its own text getter -- so the
// document-level Alt+click handler can find "the nearest hover-attached
// ancestor of whatever was clicked" and pin/show without attachHover
// needing a click listener of its own.
const hoverText = new WeakMap<Element, () => string>();

// A re-render can detach the pinned element (that's the whole reason plain
// clicks must not pin: they're exactly the clicks that cause re-renders).
// Every read of pinnedFor goes through here first, so a detached pin can
// never survive to block hovering elsewhere.
function livePin(): Element | null {
  if (pinnedFor && !pinnedFor.isConnected) {
    pinnedFor = null;
    // The tip goes with it. A detached element can never fire the mouseleave
    // that would have closed it, and Escape is gated on there being a pin --
    // so dropping the reference alone left the tip frozen on screen with the
    // text of an element that no longer exists and no way to dismiss it.
    if (tip) tip.hidden = true;
  }
  return pinnedFor;
}

function findHoverAncestor(target: Node | null): Element | null {
  let node = target instanceof Element ? target : target?.parentElement ?? null;
  while (node) {
    if (hoverText.has(node)) return node;
    node = node.parentElement;
  }
  return null;
}

function place(event: MouseEvent): void {
  if (!tip) return;
  tip.style.left = `${Math.min(event.clientX + 14, window.innerWidth - tip.offsetWidth - 8)}px`;
  tip.style.top = `${Math.min(event.clientY + 18, window.innerHeight - tip.offsetHeight - 8)}px`;
}

function ensureTip(): HTMLDivElement {
  if (tip) return tip;
  tip = document.createElement("div");
  tip.id = "hoverTip";
  tip.hidden = true;
  document.body.append(tip);

  document.addEventListener(
    "click",
    (event) => {
      livePin();

      if (event.altKey) {
        const ancestor = findHoverAncestor(event.target as Node | null);
        if (ancestor) {
          // Consumed as a pin/unpin gesture, not a click on the app: stop
          // it here, in capture, before it ever reaches the ancestor's own
          // click handler.
          event.preventDefault();
          event.stopPropagation();
          if (pinnedFor === ancestor) {
            pinnedFor = null;
            tip!.hidden = true;
          } else {
            const value = hoverText.get(ancestor)!();
            // A getter is allowed to return "" (a file row with no error yet,
            // a step with no text). Pinning to one anyway left an invisible
            // pin that blocked every other element's hover while showing
            // nothing, and no click on it to unpin, because there was nothing
            // to see. No text, no pin.
            if (value) {
              pinnedFor = ancestor;
              tip!.textContent = value;
              tip!.hidden = false;
              place(event);
            }
          }
          return;
        }
        // Alt+click that missed a hover-attached element: fall through and
        // treat it like any other click below.
      }

      // The tip's `pointer-events: none` means a click "on" it actually
      // lands on whatever sits underneath, so there is no such thing as
      // "clicking the tip" to distinguish -- every plain click dismisses
      // an open pin, plainly and unconditionally.
      // The dismissing click is not intercepted, so it still reaches the app
      // and still re-renders under a stationary pointer -- which means it
      // needs the suppression exactly as much as any other click does.
      // Returning early before setting it was the one path that let Chromium's
      // synthetic mouseenter re-open the tip the click had just closed.
      pinnedFor = null;
      tip!.hidden = true;
      suppressAt = { x: event.clientX, y: event.clientY };
    },
    { capture: true },
  );
  document.addEventListener(
    "mousemove",
    (event) => {
      if (suppressAt && (event.clientX !== suppressAt.x || event.clientY !== suppressAt.y)) suppressAt = null;
    },
    { capture: true, passive: true },
  );
  // A thing that opens should close by the key that closes things.
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && livePin()) {
      pinnedFor = null;
      tip!.hidden = true;
    }
  });

  return tip;
}

/** `text` is read on every entry, so live data stays live. Empty = no tip. */
export function attachHover(el: Element, text: () => string): void {
  const tipEl = ensureTip();
  hoverText.set(el, text);
  const show = (event: MouseEvent): void => {
    const value = text();
    if (!value) return;
    tipEl.textContent = value;
    tipEl.hidden = false;
    place(event);
  };
  el.addEventListener("mouseenter", (event) => {
    // While something else is pinned, this element's own hover must not
    // steal the shared tip and overwrite the pinned text.
    const pinned = livePin();
    if (pinned && pinned !== el) return;
    if (suppressAt) return;
    show(event as MouseEvent);
  });
  el.addEventListener("mousemove", (event) => {
    const pinned = livePin();
    if (pinned && pinned !== el) return;
    // Real movement can arrive with the enter swallowed by the suppression
    // window above (boundary events precede the move that clears it) --
    // showing here too means a genuine re-hover always gets its tip.
    if (suppressAt) return;
    if (tipEl.hidden) show(event as MouseEvent);
    else place(event as MouseEvent);
  });
  el.addEventListener("mouseleave", () => {
    if (livePin() === el) return;
    tipEl.hidden = true;
  });
}

/** The shared tip at the pointer, for what is not an element of its own -- a link inside a terminal. */
export function showTipAt(text: string, event: MouseEvent): void {
  const tipEl = ensureTip();
  tipEl.textContent = text;
  tipEl.hidden = false;
  place(event);
}

export function hideTip(): void {
  if (tip && !livePin()) tip.hidden = true;
}

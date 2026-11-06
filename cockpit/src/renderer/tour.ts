/**
 * A first-run product tour: the screen dims, one control stays lit, and a
 * card beside it says what it is for. The light glides from one control to
 * the next.
 *
 * Its own <dialog>, opened modal, so it lives in the browser's top layer: the
 * steps that point inside the add-machine chooser need to sit above that
 * dialog, and nothing with a z-index can. Being modal also keeps a stray
 * click from acting on the app while the tour is up.
 *
 * Written here rather than taken from a tour library: it is a hundred lines,
 * and a new dependency would change the runtime fingerprint and turn the next
 * release from a small patch into a full install.
 */

export interface TourStep {
  /** What to light; none for a card in the middle of the screen. */
  target?: () => Element | null;
  title: string;
  body: string;
  /** Run before the step is shown -- opening the dialog it points into. */
  enter?: () => void;
  /** Run when leaving the step in either direction. */
  leave?: () => void;
}

export interface TourText {
  next: string;
  back: string;
  skip: string;
  done: string;
  /** "{n} / {total}" */
  count: (n: number, total: number) => string;
}

const pad = 6;

export function runTour(steps: TourStep[], text: TourText): Promise<void> {
  const host = document.createElement("dialog");
  host.className = "tour";
  const light = document.createElement("div");
  light.className = "tourLight";
  const card = document.createElement("div");
  card.className = "tourCard";
  host.append(light, card);
  document.body.append(host);

  const openDialogs = () => [...document.querySelectorAll("dialog[open]")].filter((dialog) => dialog !== host);
  let index = 0;
  let done: () => void = () => undefined;
  const finished = new Promise<void>((resolve) => { done = resolve; });

  const finish = () => {
    steps[index]?.leave?.();
    window.removeEventListener("resize", place);
    host.close();
    host.remove();
    done();
  };

  // Where the light and the card go for the current step. Measured each time,
  // so a resize or a dialog that just opened is followed.
  function place(): void {
    const target = steps[index]?.target?.() ?? null;
    const box = target?.getBoundingClientRect();
    const lit = box !== undefined && box.width > 0 && box.height > 0;
    host.classList.toggle("centered", !lit);
    if (lit) {
      Object.assign(light.style, {
        left: `${box.left - pad}px`, top: `${box.top - pad}px`,
        width: `${box.width + pad * 2}px`, height: `${box.height + pad * 2}px`,
      });
    } else {
      Object.assign(light.style, { left: "50%", top: "50%", width: "0px", height: "0px" });
    }

    // Beside the target where there is room -- right, then below, then above
    // -- and kept on screen; centred when nothing is lit.
    const cw = card.offsetWidth;
    const ch = card.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = (vw - cw) / 2;
    let top = (vh - ch) / 2;
    if (lit) {
      if (box.right + pad + 14 + cw < vw) {
        left = box.right + pad + 14;
        top = box.top + box.height / 2 - ch / 2;
      } else if (box.bottom + pad + 14 + ch < vh) {
        left = box.left + box.width / 2 - cw / 2;
        top = box.bottom + pad + 14;
      } else {
        left = box.left + box.width / 2 - cw / 2;
        top = box.top - pad - 14 - ch;
      }
    }
    card.style.left = `${Math.max(12, Math.min(left, vw - cw - 12))}px`;
    card.style.top = `${Math.max(12, Math.min(top, vh - ch - 12))}px`;
  }

  function show(next: number): void {
    steps[index]?.leave?.();
    index = next;
    const step = steps[index]!;
    const before = openDialogs();
    step.enter?.();
    // A dialog that enter() opened went into the top layer above this one;
    // reopening puts the tour back on top of it. Only then: a closed dialog
    // drops its running transition, and the light would stay where it was.
    if (!host.open || openDialogs().some((dialog) => !before.includes(dialog))) {
      if (host.open) host.close();
      host.showModal();
    }

    const last = index === steps.length - 1;
    const title = document.createElement("h3");
    title.textContent = step.title;
    const body = document.createElement("p");
    body.textContent = step.body;
    const foot = document.createElement("div");
    foot.className = "tourFoot";
    const count = document.createElement("span");
    count.textContent = text.count(index + 1, steps.length);
    const skip = document.createElement("button");
    skip.type = "button";
    skip.textContent = text.skip;
    skip.hidden = last;
    skip.addEventListener("click", finish);
    const back = document.createElement("button");
    back.type = "button";
    back.textContent = text.back;
    back.hidden = index === 0;
    back.addEventListener("click", () => show(index - 1));
    const forward = document.createElement("button");
    forward.type = "button";
    forward.className = "go";
    forward.textContent = last ? text.done : text.next;
    forward.addEventListener("click", () => (last ? finish() : show(index + 1)));
    foot.append(count, skip, back, forward);
    card.replaceChildren(title, body, foot);
    // The card fades in once it has been placed; the light glides by CSS.
    card.classList.remove("in");
    requestAnimationFrame(() => {
      place();
      card.classList.add("in");
      forward.focus();
    });
  }

  host.addEventListener("cancel", (event) => {
    event.preventDefault();
    finish();
  });
  host.addEventListener("keydown", (event) => {
    if (event.key === "ArrowRight" && index < steps.length - 1) show(index + 1);
    if (event.key === "ArrowLeft" && index > 0) show(index - 1);
  });
  window.addEventListener("resize", place);
  show(0);
  return finished;
}

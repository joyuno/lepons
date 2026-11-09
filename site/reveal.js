/* The pipe as one line that grows down the page as you scroll, an arrow at its tip, and each
   feature rising into view as it is reached. Only adds classes and one SVG: with no script,
   or with motion reduced, the page shows as it always did (the pipe drawn by CSS borders). */
(() => {
  if (!("IntersectionObserver" in window) || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const main = document.querySelector("main");
  const legs = [...document.querySelectorAll("main .leg")];
  if (!main || legs.length === 0) return;
  document.documentElement.classList.add("reveal");

  // Features rise in once, as they are reached.
  const seen = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add("in");
      seen.unobserve(entry.target);
    }
  }, { rootMargin: "0px 0px -12% 0px", threshold: 0.12 });
  for (const leg of legs) seen.observe(leg);

  // The pipe: the same zigzag the borders draw, as one path over <main>.
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("class", "pipeline");
  svg.setAttribute("aria-hidden", "true");
  const line = document.createElementNS(ns, "path");
  line.setAttribute("class", "pipe-line");
  const head = document.createElementNS(ns, "path");
  head.setAttribute("class", "pipe-head");
  svg.append(line, head);
  main.append(svg);
  document.documentElement.classList.add("pipe-live");

  let total = 0, top = 0, bottom = 0;
  const layout = () => {
    const css = getComputedStyle(document.documentElement);
    const w = parseFloat(css.getPropertyValue("--pipe-w")) || 12;
    const elbow = parseFloat(css.getPropertyValue("--elbow")) || 44;
    const narrow = matchMedia("(max-width: 860px)").matches;
    const box = main.getBoundingClientRect();
    const at = (rect) => ({ l: rect.left - box.left, r: rect.right - box.left, t: rect.top - box.top, b: rect.bottom - box.top });
    const xOf = (leg) => {
      const p = at(leg.getBoundingClientRect());
      return narrow || leg.classList.contains("left") ? p.l + w / 2 : p.r - w / 2;
    };
    let d = "";
    legs.forEach((leg, i) => {
      const p = at(leg.getBoundingClientRect());
      const x = xOf(leg);
      if (i === 0) d += `M${x} ${p.t}`;
      const next = legs[i + 1];
      if (!next) { d += ` V${p.b}`; return; }
      const nx = xOf(next);
      const n = at(next.getBoundingClientRect());
      if (Math.abs(nx - x) < 1) { d += ` V${n.t}`; return; }
      // Down, round the corner, across, round the next corner, down into the next feature.
      const y = (p.b + n.t) / 2, r = Math.min(elbow, (n.t - p.b) / 2), dir = Math.sign(nx - x);
      d += ` V${y - r} Q${x} ${y} ${x + dir * r} ${y} H${nx - dir * r} Q${nx} ${y} ${nx} ${y + r}`;
    });
    svg.setAttribute("width", String(box.width));
    svg.setAttribute("height", String(box.height));
    svg.style.setProperty("--w", `${w}px`);
    line.setAttribute("d", d);
    total = line.getTotalLength();
    line.style.strokeDasharray = `${total}`;
    top = at(legs[0].getBoundingClientRect()).t + box.top + scrollY;
    bottom = at(legs[legs.length - 1].getBoundingClientRect()).b + box.top + scrollY;
    draw();
  };

  // How much is drawn: the share of the pipe's height that is above 70% of the window.
  const draw = () => {
    if (!total) return;
    const tip = scrollY + innerHeight * 0.7;
    const share = Math.min(1, Math.max(0, (tip - top) / (bottom - top)));
    const len = total * share;
    line.style.strokeDashoffset = `${total - len}`;
    const p = line.getPointAtLength(len);
    const q = line.getPointAtLength(Math.max(0, len - 2));
    const angle = len < 2 ? 90 : (Math.atan2(p.y - q.y, p.x - q.x) * 180) / Math.PI;
    const w = parseFloat(svg.style.getPropertyValue("--w")) || 12;
    const s = w * 1.6;
    head.setAttribute("d", `M${-s * 0.9} ${-s} L${s * 0.6} 0 L${-s * 0.9} ${s} Z`);
    head.setAttribute("transform", `translate(${p.x} ${p.y}) rotate(${angle})`);
    head.style.opacity = share > 0 && share < 1 ? "1" : "0";
  };

  let frame = 0;
  addEventListener("scroll", () => {
    if (frame) return;
    frame = requestAnimationFrame(() => { frame = 0; draw(); });
  }, { passive: true });
  new ResizeObserver(layout).observe(main);
  addEventListener("load", layout);
  layout();
})();

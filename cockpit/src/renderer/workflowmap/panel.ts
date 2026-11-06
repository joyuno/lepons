import { formatDate, t } from "../../i18n/i18n.ts";
import type { WorkflowItem } from "../../shared/ipc.ts";
import { attachHover } from "../hover.ts";
import type { MapInput, MapModel, MapSession, Mood } from "./model.ts";
import { hm } from "./paint.ts";
import { finishedToday, goalIsLong, minutesSince, summarize, type Summary } from "./summary.ts";

/*
 * The right panel: what the clicked thing is doing. Read-only by decision
 * (spec 10.3): a waiting session's question and options are SHOWN, and the
 * only action is "그 칸으로 가기" (its pane, where it is answered). A session
 * opens with its summary card (spec 11.3), then the step list the workflow
 * view always had, translate buttons included.
 */

export interface Question { text?: string; options: Array<{ n: number; label: string; detail?: string }> }
export type Translated = { ok: true; text: string } | { ok: false; error: string };

export interface PanelDeps {
  /** The menu on a waiting session's screen, if one can be read. */
  question(session: string): Question | undefined;
  /** Steps read off the terminal, for a session with no record. */
  history(session: string): Array<{ at: number; text: string }>;
  translate(text: string): Promise<Translated>;
  goTo(session: string): void;
  close(): void;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const dot = (m: Mood) => `<i class="wmDot ${m}"></i>`;
const mood = (m: Mood) => t(`status.${m}`);

/** "38분", "1시간 5분", "1분 안". */
export function duration(minutes: number): string {
  if (minutes < 1) return t("wfmap.underMinute");
  if (minutes < 60) return t("wfmap.minutes", { n: minutes });
  return t("wfmap.hours", { h: Math.floor(minutes / 60), m: minutes % 60 });
}
/** "방금", "3분 전", "2시간 전". */
export function ago(minutes: number): string {
  if (minutes < 1) return t("wfmap.justNow");
  if (minutes < 60) return t("wfmap.minutesAgo", { n: minutes });
  return t("wfmap.hoursAgo", { n: Math.floor(minutes / 60) });
}

/** 진행: elapsed · files edited (three named) · reads · commands · subagents (running). */
export function progressLine(sum: Summary, working: boolean, now: number): string {
  const p = sum.progress;
  const bits: string[] = [];
  if (p.start !== undefined) bits.push(duration(minutesSince(p.start, working ? now : p.last ?? now)));
  if (p.edited.length) bits.push(t("wfmap.edited", { n: p.edited.length, names: p.edited.slice(0, 3).join(", ") + (p.edited.length > 3 ? "…" : "") }));
  if (p.reads) bits.push(t("wfmap.reads", { n: p.reads }));
  if (p.commands) bits.push(t("wfmap.commands", { n: p.commands }));
  if (p.subagents) bits.push(p.running ? t("wfmap.subsRunning", { n: p.subagents, m: p.running }) : t("wfmap.subs", { n: p.subagents }));
  return bits.join(" · ");
}

function head(av: string, title: string, sub: string) {
  return `<div class="ph"><div class="av">${esc(av)}</div><div class="phT"><div class="pt">${esc(title)}</div><div class="ps">${sub}</div></div><button type="button" class="close" aria-label="${esc(t("wfmap.close"))}">✕</button></div>`;
}

function summaryCard(s: MapSession, sum: Summary, now: number): string {
  const row = (key: string, body: string, cls = "") => `<div class="sr"><span class="sk">${esc(key)}</span><div class="sv ${cls}">${body}</div></div>`;
  const rows: string[] = [];
  if (sum.goal) {
    const long = goalIsLong(sum.goal);
    rows.push(row(t("wfmap.goal"), `<span class="goal${long ? " clamp" : ""}">${esc(sum.goal)}</span>${long ? `<button type="button" class="more">${esc(t("wfmap.more"))}</button>` : ""}`));
  }
  const progress = progressLine(sum, s.mood === "working", now);
  if (progress) rows.push(row(t("wfmap.progress"), esc(progress)));
  if (sum.now) {
    // The note a turn rested on is its result; while working it is only the newest step.
    const result = s.mood === "working" ? undefined : sum.result;
    const text = result ?? (sum.now.kind === "subagent" ? t("wfmap.agentStep", { text: sum.now.text }) : sum.now.text);
    rows.push(row(t(result ? "wfmap.result" : "wfmap.now"), `<span class="mono">${hm(sum.now.at)}</span> ${esc(text)} <span class="ago">· ${esc(ago(minutesSince(sum.now.at, now)))}</span>`, "strong"));
  }
  return `<section class="sum"><div class="sumH">${esc(t("wfmap.summary"))}</div>${rows.length ? rows.join("") : `<div class="sv muted">${esc(t("wfmap.noRecord"))}</div>`}</section>`;
}

function questionCard(q: Question | undefined): string {
  if (!q) return `<section class="q"><div class="qh">${esc(t("wfmap.waitingTitle"))}</div><div class="qn">${esc(t("wfmap.questionUnread"))}</div></section>`;
  return `<section class="q">
    <div class="qh">${esc(t("wfmap.waitingTitle"))}</div>
    ${q.text ? `<div class="qt">${esc(q.text)}</div>` : ""}
    <ol class="qo" aria-label="${esc(t("wfmap.optionsLabel"))}">${q.options.map((o) => `<li><b>${o.n}</b><span>${esc(o.label)}${o.detail ? `<small>${esc(o.detail)}</small>` : ""}</span></li>`).join("")}</ol>
    <div class="qn">${esc(t("wfmap.questionNote"))}</div>
  </section>`;
}

/** Subagent text translated on request, by original text; kept for the run. */
const translations = new Map<string, string>();
/** Which of those are being shown translated right now. */
const translating = new Set<string>();

/** The session's steps, oldest first, newest lit: the old detail view's list as it was. */
export function stepList(events: readonly WorkflowItem[], translate: PanelDeps["translate"]): HTMLElement {
  const steps = document.createElement("ul");
  steps.className = "wfSteps";
  events.forEach((event, index) => {
    const item = document.createElement("li");
    const last = index === events.length - 1;
    const when = document.createElement("span");
    when.className = "t";
    when.textContent = event.at ? formatDate(event.at, { hour: "numeric", minute: "2-digit" }) : "";

    if (event.kind === "subagent") {
      // A dispatched subagent is a branch, not one more line: its card carries
      // the instructions it was handed and, once returned, its result.
      item.className = "wfStep wfStepAgent" + (last ? " now" : "");
      const branch = document.createElement("div");
      branch.className = "wfBranch" + (event.result === undefined ? " running" : "");
      const head = document.createElement("div");
      head.className = "wfBranchHead";
      const desc = document.createElement("span");
      desc.className = "desc";
      desc.textContent = event.description;
      head.append(desc);
      if (event.agentType) {
        const tag = document.createElement("span");
        tag.className = "kindTag";
        tag.textContent = event.agentType;
        head.append(tag);
      }
      if (event.result === undefined) {
        const running = document.createElement("span");
        running.className = "runTag";
        running.textContent = t("workflow.running");
        head.append(running);
      }
      branch.append(head);
      const orders = document.createElement("div");
      orders.className = "line";
      branch.append(orders);
      const returned = document.createElement("div");
      returned.className = "line";
      if (event.result) branch.append(returned);
      // Shown in the operator's language only when asked: each translation
      // is a Claude call, so nothing is translated just by opening the panel.
      const fill = () => {
        const shown = (text: string) => (translating.has(text) ? (translations.get(text) ?? text) : text);
        orders.textContent = `${t("workflow.instructions")}: ${event.instructions ? shown(event.instructions) : "—"}`;
        returned.textContent = `${t("workflow.result")}: ${shown(event.result ?? "")}`;
      };
      fill();
      const texts = [event.instructions, event.result ?? ""].filter((text) => text !== "");
      if (texts.length > 0) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "wfTranslate";
        const label = () => {
          button.textContent = texts.every((text) => translating.has(text)) ? t("workflow.original") : t("workflow.translate");
        };
        label();
        button.addEventListener("click", async () => {
          if (texts.every((text) => translating.has(text))) {
            for (const text of texts) translating.delete(text);
          } else {
            button.disabled = true;
            button.textContent = t("workflow.translating");
            for (const text of texts) {
              if (!translations.has(text)) {
                const result = await translate(text);
                if (!result.ok) {
                  button.disabled = false;
                  button.textContent = t("workflow.translate");
                  attachHover(button, () => result.error);
                  return;
                }
                translations.set(text, result.text);
              }
              translating.add(text);
            }
            button.disabled = false;
          }
          fill();
          label();
        });
        head.append(button);
      }
      item.append(when, branch);
    } else {
      item.className = "wfStep" + (event.kind === "prompt" ? " prompt" : "") + (event.kind === "action" ? " act" : "") + (last ? " now" : "");
      const what = document.createElement("span");
      what.className = "x";
      what.textContent = event.text;
      item.append(when, what);
    }
    if (event.kind !== "prompt" && event.cancelled) {
      const mark = document.createElement("span");
      mark.className = "t";
      mark.textContent = t("wfmap.cancelled");
      item.append(mark);
    }
    steps.append(item);
  });
  return steps;
}

function note(text: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "wfNote";
  el.textContent = text;
  return el;
}

function sessionPanel(el: HTMLElement, input: MapInput, s: MapSession, deps: PanelDeps) {
  const f = input.folders.find((x) => x.id === s.folder);
  const pc = input.pcs.find((p) => p.id === f?.pc);
  const sum = summarize(s.workflow);
  const title = sum.title ?? `${f?.label ?? ""} · ${s.label}`;
  el.innerHTML = `${head(title.slice(0, 1), title, `${dot(s.mood)}${esc(mood(s.mood))} · ${esc(pc?.label ?? "")} / ${esc(f?.label ?? "")}`)}
  <div class="pb">
    ${s.note !== undefined ? `<div class="stateNote">${esc(s.note)}</div>` : ""}
    ${summaryCard(s, sum, input.now)}
    ${s.mood === "waiting" ? questionCard(deps.question(s.id)) : ""}
    <div class="steps"></div>
  </div>
  <div class="go"><button type="button" class="goBtn">${esc(t("wfmap.goTo"))} <span>↗</span></button></div>`;
  const steps = el.querySelector<HTMLElement>(".steps");
  if (steps) {
    const events = s.workflow?.events ?? [];
    if (events.some((e) => e.kind === "subagent")) {
      const notice = note(t("workflow.translateCost"));
      notice.className = "wfNotice";
      steps.append(notice);
    }
    if (events.length) {
      const cap = note(t("wfmap.steps", { n: events.length }));
      cap.className = "cap";
      steps.append(cap, stepList(events, deps.translate));
    } else if (s.workflow === undefined) {
      // No readable record: the terminal's own timeline, as the detail view fell back to.
      const history = deps.history(s.id);
      steps.append(note(t(history.length ? "workflow.noTranscript" : "workflow.detailEmpty")));
      if (history.length) steps.append(stepList(history.map((h) => ({ kind: "note", at: h.at, text: h.text })), deps.translate));
    } else steps.append(note(t("workflow.detailEmpty")));
  }
  el.querySelector(".goBtn")?.addEventListener("click", () => deps.goTo(s.id));
  el.querySelector(".more")?.addEventListener("click", (event) => {
    const goal = el.querySelector(".goal");
    const open = goal?.classList.toggle("clamp") === false;
    (event.currentTarget as HTMLElement).textContent = t(open ? "wfmap.less" : "wfmap.more");
  });
}

function hubPanel(el: HTMLElement, input: MapInput, m: MapModel, pcId: string) {
  const pc = input.pcs.find((p) => p.id === pcId)!;
  const folders = input.folders.filter((f) => f.pc === pcId);
  const ss = input.sessions.filter((s) => folders.some((f) => f.id === s.folder));
  const last = (s: MapSession) => s.workflow?.events.at(-1)?.at ?? 0;
  const busy = ss.filter((s) => s.mood === "working").sort((a, b) => last(b) - last(a))[0];
  const busyNow = busy ? summarize(busy.workflow).now : undefined;
  const done = ss.filter((s) => (s.mood === "done" || s.mood === "idle") && last(s) > 0).sort((a, b) => last(b) - last(a));
  const count = (fid: string, md: Mood) => ss.filter((s) => s.folder === fid && s.mood === md).length;
  const label = (id: string) => input.pcs.find((p) => p.id === id)?.label ?? id;
  const shares = [...new Set(input.shares.filter((x) => x.from === pcId || x.to === pcId).map((x) => label(x.from === pcId ? x.to : x.from)))];
  const dels = input.delegations.filter((d) => d.from === pcId || input.folders.find((f) => f.id === d.toFolder)?.pc === pcId);
  const subsBack = ss.reduce((n, s) => n + finishedToday(s.workflow?.events ?? [], input.now), 0);
  const counts = m.byId.get(`h:${pcId}`)?.counts;
  el.innerHTML = `${head(pc.label.slice(0, 1), pc.label, `${esc(pc.status ?? "")}${pc.local ? ` · ${esc(t("wfmap.here"))}` : ""}`)}
  <div class="pb">
    ${busy && busyNow ? `<section class="sum"><div class="sumH">${esc(t("wfmap.now"))} · ${esc(busy.workflow?.title ?? busy.label)}</div><div class="sv strong"><span class="mono">${hm(busyNow.at)}</span> ${esc(busyNow.text)}</div></section>` : ""}
    ${counts ? `<div class="cap">${esc([t("wfmap.hubWorking", { n: counts.working }), t("wfmap.hubWaiting", { n: counts.waiting }), t("wfmap.hubDone", { n: counts.done }), t("wfmap.hubSubs", { n: counts.subagents })].join(" · "))}</div>` : ""}
    <div class="sec">${esc(t("wfmap.folders"))}</div>
    <ul class="flist">${folders.map((f) => {
      const w = count(f.id, "working"), q = count(f.id, "waiting"), d = count(f.id, "done");
      const md: Mood = w ? "working" : q ? "waiting" : count(f.id, "failed") ? "failed" : "idle";
      const bits = [w && t("wfmap.hubWorking", { n: w }), q && t("wfmap.hubWaiting", { n: q }), d && `${mood("done")} ${d}`].filter(Boolean).join(" · ");
      return `<li>${dot(md)}<span class="tx">${esc(f.label)}</span><span class="tm">${esc(bits || mood("idle"))}</span></li>`;
    }).join("")}</ul>
    <div class="secH"><b>${esc(t("wfmap.finished"))}</b> ${done.length + subsBack}</div>
    <ul class="log">${done.map((s) => `<li><span class="k">${esc(mood(s.mood))}</span><span class="tx">${esc(s.workflow?.title ?? `${input.folders.find((f) => f.id === s.folder)?.label ?? ""} · ${s.label}`)}</span><span class="tm">${hm(last(s))}</span></li>`).join("")}</ul>
    ${dels.length ? `<div class="secH"><b>${esc(t("wfmap.delegations"))}</b></div><ul class="log">${dels.map((d) => `<li><span class="k${d.running ? " run" : ""}">${esc(t(d.running ? "workflow.running" : "status.done"))}</span><span class="tx">${esc(label(d.from))} → ${esc(input.folders.find((f) => f.id === d.toFolder)?.label ?? d.toFolder)}${d.instructions ? ` · ${esc(d.instructions)}` : ""}</span><span class="tm">${d.at ? hm(d.at) : ""}</span></li>`).join("")}</ul>` : ""}
    ${shares.length ? `<div class="cap">${esc(t("wfmap.shares", { names: shares.join(", ") }))}</div>` : ""}
  </div>`;
}

function folderPanel(el: HTMLElement, input: MapInput, fid: string) {
  const f = input.folders.find((x) => x.id === fid)!;
  const pc = input.pcs.find((p) => p.id === f.pc);
  const ss = input.sessions.filter((s) => s.folder === fid);
  el.innerHTML = `${head(f.label.slice(0, 1), f.label, `${esc(pc?.label ?? "")} · ${esc(t("wfmap.sessions", { n: ss.length }))}`)}
  <div class="pb"><ul class="flist">${ss.map((s) => {
    const at = s.workflow?.events.at(-1)?.at;
    return `<li>${dot(s.mood)}<span class="tx">${esc(s.workflow?.title ?? s.label)}</span><span class="tm">${esc(mood(s.mood))}${at ? ` · ${hm(at)}` : ""}</span></li>`;
  }).join("")}</ul></div>`;
}

/** Fills the panel for a map node id; returns false when there is nothing to show. */
export function renderPanel(el: HTMLElement, input: MapInput, m: MapModel, id: string, deps: PanelDeps): boolean {
  const n = m.byId.get(id);
  if (!n) return false;
  const s = n.session ? input.sessions.find((x) => x.id === n.session) : undefined;
  if (n.kind === "hub") hubPanel(el, input, m, n.pc);
  else if (s && (n.kind === "session" || n.kind === "merged" || n.kind === "sub")) sessionPanel(el, input, s, deps);
  else if (n.folder) folderPanel(el, input, n.folder);
  else return false;
  el.querySelector(".close")?.addEventListener("click", deps.close);
  return true;
}

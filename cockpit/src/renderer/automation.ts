import { currentLocale, formatDate, t, type t as translate } from "../i18n/i18n.ts";
import { localNodeId, sessionKey, type BotForm, type BotRow, type BotRun, type OsJobDo, type ScheduleDone, type ScheduleForm, type ScheduleList, type ScheduleRow } from "../shared/ipc.ts";
import { describeItem, jobOrigin, jobProgram, jobTitle, scheduleText, type JobOrigin, type OsJob, type OsSchedule } from "../agent/os-jobs.ts";
import { rruleSchedule, type CodexAutomation, type CodexCloudTask } from "../agent/codex-automations.ts";
import { MAX_SCHEDULE_TEXT, NO_SESSION, describeWhen, parseWhen, presetCron, presetOf, type When } from "../agent/schedule.ts";
import { botProfilePath } from "../agent/bots.ts";
import { dialogShell } from "./dialog-shell.ts";
import { menuMove } from "./chat-view.ts";
import { agents, delegateAgents, type AgentKind } from "../agent/agents.ts";

/**
 * The 자동화 view the rail's 봇 button opens: today's runs on one line, the
 * bots as cards, every PC's timetable jobs and Lepons' own schedules as one
 * paged list whose buttons show on hover, and Claude routines under it. A bot
 * card opens the bot.
 *
 * Nothing here touches the DOM or window.cockpit at load, so the pure parts
 * are tested under node.
 */

/** One PC's existing timetable jobs, as osjobs:list read them; `state` until they come. */
/**
 * One PC's existing timetable jobs, as osjobs:list read them. `readAt`: when
 * `jobs` were read (absent: never, and `jobs` is empty); `cached`: they come
 * from the last start's cache and have not been read again yet; `state` while
 * a read is under way, `error` when the last one failed (the jobs stay).
 */
export interface AutomationPc { nodeId: string; pc: string; jobs: OsJob[]; readAt?: string; cached?: true; state?: "loading"; error?: string }

/** Whether two reads of a PC's jobs show the same: the same jobs, in the same order, with the same fields. */
export const sameJobs = (a: OsJob[], b: OsJob[]): boolean =>
  a.length === b.length && a.every((job, at) => JSON.stringify(job) === JSON.stringify(b[at]));

/** The cache (main's, by node id) as PCs to draw before they answer: only for PCs not read yet in this start. */
export function fromCache(cache: Record<string, { at: string; jobs: OsJob[] }>, pcs: Array<{ nodeId: string; label: string }>, have: ReadonlySet<string>): AutomationPc[] {
  return pcs.flatMap((pc) => {
    const kept = cache[pc.nodeId];
    return kept && !have.has(pc.nodeId) && Array.isArray(kept.jobs) ? [{ nodeId: pc.nodeId, pc: pc.label, jobs: kept.jobs, readAt: kept.at, cached: true as const }] : [];
  });
}
export interface AutomationData { bots: BotRow[]; jobs: AutomationPc[]; routines?: string }

export interface AutomationActions {
  /** Every PC, this PC first; `live`: connected now, so its jobs are read on opening. */
  pcs(): Array<{ nodeId: string; label: string; live: boolean; folders: Array<{ id: string; label: string; path: string }> }>;
  /** Paints a session's lamp the way the rail does, and keeps it current. */
  lamp(element: HTMLElement, key: string): void;
  openFile(nodeId: string, repoId: string, path: string): void;
  /** Shows the bot's session, opening it if it is not running. */
  goToBot(bot: BotRow): void;
  /** The bots as last read, for the tabs that show a bot's name. */
  botsChanged(bots: BotRow[]): void;
}

type Deps = { t: typeof translate };

/** OS jobs grouped under the bots whose `linked` names them; the rest are loose. A job goes to the first bot that claims it. */
export function groupRows(bots: BotRow[], jobs: OsJob[]): { bot: BotRow; jobs: OsJob[] }[] & { loose: OsJob[] } {
  const taken = new Set<string>();
  const groups = bots.map((bot) => {
    const mine = jobs.filter((job) => bot.linked?.includes(job.id) && !taken.has(job.id));
    for (const job of mine) taken.add(job.id);
    return { bot, jobs: mine };
  });
  return Object.assign(groups, { loose: jobs.filter((job) => !taken.has(job.id)) });
}

/** A row of one PC's list: an OS job (under its bot's name when one claims it) or one of Lepons' own schedules. */
export type ListRow = { job: OsJob; bot?: string } | { schedule: ScheduleRow };

/** One PC's list: OS jobs under their bots, then the loose ones, then Lepons' own schedules there. */
export function listRows(bots: BotRow[], jobs: OsJob[], schedules: ScheduleRow[]): ListRow[] {
  const groups = groupRows(bots, jobs);
  return [
    ...groups.flatMap((group) => group.jobs.map((job) => ({ job, bot: group.bot.name }))),
    ...groups.loose.map((job) => ({ job })),
    ...schedules.map((schedule) => ({ schedule })),
  ];
}

/** The list's filter chips, in order; "all" first. */
export const JOB_KINDS = ["all", "mine", "project", "app", "os"] as const;
export type JobKind = (typeof JOB_KINDS)[number];

/** Which filter chip a row falls under: an OS job by where it comes from (os-jobs.ts jobOrigin), Lepons' own as the person's. */
export function rowKind(row: ListRow, folders: Array<{ label: string; path: string }>): Exclude<JobKind, "all"> {
  return "job" in row ? jobOrigin(row.job, folders).kind : "mine";
}

export const PAGE_SIZE = 15;

/** One page of `rows` (from 0), the page clamped to those there are: a list that shrank never shows an empty page. */
export function pageOf<T>(rows: T[], page: number, size = PAGE_SIZE): { rows: T[]; page: number; pages: number } {
  const pages = Math.max(1, Math.ceil(rows.length / size));
  const at = Math.min(Math.max(0, page), pages - 1);
  return { rows: rows.slice(at * size, (at + 1) * size), page: at, pages };
}

/**
 * Today's runs, minutes after midnight, in time order: bots that are not paused,
 * and OS jobs that are on and have a clock time. Intervals, sign-in and boot
 * have no place on a clock, so they are left off.
 */
export function todayPoints<B extends { name: string; paused?: boolean; jobs: Array<{ when: When }> }>(bots: B[], jobs: OsJob[], now: Date): Array<{ at: number; label: string; of: B | OsJob }> {
  const day = now.getDay();
  const hours = (hour: number | undefined) => (hour === undefined ? Array.from({ length: 24 }, (_, each) => each) : [hour]);
  const points: Array<{ at: number; label: string; of: B | OsJob }> = [];
  for (const bot of bots) {
    if (bot.paused) continue;
    for (const { when } of bot.jobs) {
      if (when.days && !when.days.includes(day)) continue;
      for (const hour of hours(when.hour)) points.push({ at: hour * 60 + when.minute, label: bot.name, of: bot });
    }
  }
  const calendar = (schedule: OsSchedule): Array<{ weekday?: number; hour?: number; minute: number }> =>
    schedule.kind === "calendar" ? schedule.entries : schedule.kind === "many" ? schedule.items.flatMap(calendar) : [];
  for (const job of jobs) {
    if (!job.enabled || !job.schedule) continue;
    for (const entry of calendar(job.schedule)) {
      // launchd counts Sunday as 0 or 7.
      if (entry.weekday !== undefined && entry.weekday % 7 !== day) continue;
      for (const hour of hours(entry.hour)) points.push({ at: hour * 60 + entry.minute, label: job.label, of: job });
    }
  }
  return points.sort((a, b) => a.at - b.at);
}

/** Which buttons a job gets: only what os-jobs.ts can do for its kind. Lepons' own are controlled as schedules. */
export function jobActions(job: OsJob): OsJobDo[] {
  if (job.source === "lepons") return [];
  const actions: OsJobDo[] = [];
  if (job.source !== "cron" && (job.source !== "launchd" || job.logPath)) actions.push("log");
  actions.push(...(job.enabled ? ["run", "pause"] as const : ["resume"] as const));
  const atLine = job.source === "cron" && job.schedule?.kind === "text" && job.schedule.text.startsWith("@");
  if ((job.source === "launchd" && !job.resident) || (job.source === "cron" && !atLine)) actions.push("edit");
  return actions;
}

export function buttons(...list: Array<[label: string, click: () => void]>): HTMLDivElement {
  const row = document.createElement("div");
  row.className = "setButtons";
  for (const [label, click] of list) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.addEventListener("click", click);
    row.append(button);
  }
  return row;
}

export function line(text: string): HTMLParagraphElement {
  const p = document.createElement("p");
  p.textContent = text;
  return p;
}

// --- the view's state --------------------------------------------------

let host: HTMLElement | undefined;
let actions: AutomationActions | undefined;
let bots: BotRow[] = [];
const pcJobs = new Map<string, AutomationPc>();
/** The PC whose jobs are listed; absent: the first. */
let pcPicked: string | undefined;
/** The page of the picked PC's list (from 0); back to the first when another PC is picked. */
let jobsPage = 0;
/** Bot shown on its own page. */
let botOpen: string | undefined;
/** The bot form that is open: "new", a bot's id, or none. */
let botForm: string | undefined;
/** The bot form opened with "일 추가": it starts with an empty job. */
let botFormAdd = false;
/** Fills the open bot form's list of the PC's jobs again, as that list may arrive after the form. */
let refillLinks: (() => void) | undefined;
/** A PC's jobs and the schedule list read less than this long ago are not read again on opening; 새로 고침 always reads. */
const FRESH_MS = 60_000;
/** When each PC's jobs were last asked for. */
const readAt = new Map<string, number>();
/** The bot page's ⋯ is open. */
let botMenu = false;
/** OS job logs opened under their rows, by job id. */
const jobLogs = new Map<string, string>();
/** OS jobs whose details (full name, command, author, file) are open under their rows. */
const jobInfo = new Set<string>();
/** The OS job whose time is being changed. */
let jobEdit: string | undefined;
let routines: { loading: boolean; text?: string; error?: string } = { loading: false };
/** Names the person gave OS jobs, by `${nodeId}\n${jobId}`, kept in main (userData). */
const names = new Map<string, string>();
let namesRead = false;
/** The OS job being renamed. */
let nameEdit: string | undefined;
/** The AI's line per job, by describeItem's key; asked only while the switch is on. */
const aiLines = new Map<string, string>();
/** PCs whose lines were asked for since their jobs were last read: not asked again, even after a failure, until the next read. */
const aiAsked = new Set<string>();
const aiLoading = new Set<string>();
let aiOn = (() => {
  try { return localStorage.getItem("automationAi") === "1"; } catch { return false; }
})();
/** The filter chip picked per PC, kept across starts. */
let filters: Record<string, unknown> | undefined;
function filterOf(nodeId: string): JobKind {
  if (!filters) {
    try {
      const read: unknown = JSON.parse(localStorage.getItem("automationFilter") ?? "{}");
      filters = typeof read === "object" && read !== null ? read as Record<string, unknown> : {};
    } catch { filters = {}; }
  }
  const kind = filters[nodeId];
  return JOB_KINDS.find((each) => each === kind) ?? "all";
}
/** Sections folded shut by a click on their title, kept across starts. */
let folds: Set<string> | undefined;
const folded = (id: string): boolean => {
  if (!folds) {
    folds = new Set();
    try { for (const each of JSON.parse(localStorage.getItem("automationFolds") ?? "[]") as string[]) folds.add(each); } catch { /* none kept */ }
  }
  return folds.has(id);
};
/** A section's title as the button that folds it. */
function foldTitle(id: string, text: string): HTMLButtonElement {
  const title = make("button", "autoTitle autoFold", text);
  title.type = "button";
  title.dataset.focus = `fold:${id}`;
  title.setAttribute("aria-expanded", String(!folded(id)));
  title.addEventListener("click", () => {
    if (!folds!.delete(id)) folds!.add(id);
    try { localStorage.setItem("automationFolds", JSON.stringify([...folds!])); } catch { /* this start only */ }
    render();
  });
  return title;
}
/** Forms kept across redraws, so a list arriving does not wipe what is being typed. */
const kept = new Map<string, HTMLElement>();
const keep = (key: string, make: () => HTMLElement): HTMLElement => {
  let element = kept.get(key);
  if (!element) kept.set(key, element = make());
  return element;
};

export function initAutomation(element: HTMLElement, given: AutomationActions): void {
  host = element;
  actions = given;
  // A press anywhere but the bot page's ⋯ and its menu closes the menu.
  document.addEventListener("pointerdown", (event) => {
    if (botMenu && !(event.target as Element).closest(".autoMore")) dropMenu();
  }, true);
}

/**
 * Draws the view and reads what it shows: the bots, and over SSH only the
 * picked PC's jobs and the schedule list, each skipped if read in the last
 * minute. The other PCs are read when their chip is clicked.
 */
export function showAutomation(): void {
  if (!actions) return;
  loadBots();
  loadSchedules(true);
  if (!namesRead) {
    namesRead = true;
    void window.cockpit.osJobNames().then((read) => {
      for (const [key, name] of Object.entries(read)) names.set(key, name);
    }, () => { namesRead = false; }).finally(render);
  }
  // The last lists, from main's cache, drawn at once; every connected PC is then read again, two at a time.
  if (!cacheRead) {
    cacheRead = true;
    void window.cockpit.osJobsCached().then((cache) => {
      for (const pc of fromCache(cache, actions?.pcs() ?? [], new Set(pcJobs.keys()))) pcJobs.set(pc.nodeId, pc);
    }, () => undefined).finally(() => {
      render();
      loadAll();
    });
  } else loadAll();
  render();
}

let cacheRead = false;
/** Reads the picked PC and every connected one, skipping those read within FRESH_MS; at most two at a time. */
function loadAll(): void {
  const pcs = actions?.pcs() ?? [];
  const picked = pcPicked ?? pcs[0]?.nodeId;
  // A PC not connected is not connected to just for this: it keeps what was read last.
  const ids = pcs.filter((pc) => pc.nodeId === picked || pc.live).map((pc) => pc.nodeId);
  let next = 0;
  const worker = (): void => {
    const id = ids[next++];
    if (id !== undefined) void loadJobs(id).finally(worker);
  };
  worker();
  worker();
}

/** The refresh icons turn while anything is read, without drawing the page again. */
const reading = () => schedLoading || [...pcJobs.values()].some((pc) => pc.state === "loading");
function syncReading(): void {
  const icon = host?.querySelector<HTMLElement>('[data-focus="refresh"]');
  if (!icon) return;
  const busy = reading();
  icon.classList.toggle("spinning", busy);
  if (busy) icon.setAttribute("aria-busy", "true");
  else icon.removeAttribute("aria-busy");
}

/**
 * Esc on the view, one step at a time (true): the bot page's ⋯ menu, a job's
 * time form or name field closes first, then a bot's own page goes back to the list.
 * Otherwise false, and the view is left.
 */
export function automationEscape(): boolean {
  if (botMenu) {
    botMenu = false;
    render();
    host?.querySelector<HTMLElement>('[data-focus="botMore"]')?.focus();
    return true;
  } else if (jobEdit !== undefined) jobEdit = undefined;
  else if (nameEdit !== undefined) nameEdit = undefined;
  else if (botOpen !== undefined) {
    botOpen = undefined;
    botForm = undefined;
  } else return false;
  render();
  return true;
}

function render(): void {
  if (!host || !actions || host.hidden) return;
  // A PC taken off the list takes its jobs with it (today's line, counts), even one read while it was removed.
  const listed = new Set(actions.pcs().map((pc) => pc.nodeId));
  for (const id of [...pcJobs.keys()]) {
    if (listed.has(id)) continue;
    pcJobs.delete(id);
    readAt.delete(id);
  }
  const open = new Set([`bot:${botForm}`, `sched:${schedForm}`, `edit:${jobEdit}`, `name:${nameEdit}`]);
  for (const key of kept.keys()) if (!open.has(key)) kept.delete(key);
  if (botForm === undefined) refillLinks = undefined;
  const focused = document.activeElement;
  const focusKey = focused instanceof HTMLElement && host.contains(focused) ? focused.dataset.focus : undefined;
  renderAutomation(host, { bots, jobs: [...pcJobs.values()], ...(routines.text ? { routines: routines.text } : {}) }, actions);
  // The focus survives the redraw: a kept field has it back, a redrawn button by its data-focus.
  if (focused instanceof HTMLElement && focused !== document.activeElement) {
    if (host.contains(focused)) focused.focus();
    else if (focusKey) host.querySelector<HTMLElement>(`[data-focus="${CSS.escape(focusKey)}"]`)?.focus();
  }
  refillLinks?.();
  formDialog();
  // A point on today's line was clicked: its row, once drawn, is brought into view (it flashes: markRow).
  if (flash && !flash.scrolled) {
    const row = host.querySelector<HTMLElement>(`[data-row="${CSS.escape(flash.id)}"]`);
    if (row) {
      flash.scrolled = true;
      row.scrollIntoView({ block: "center", behavior: "smooth" });
      // The keyboard goes on from the row; the dot (and its tooltip) is left behind.
      row.tabIndex = -1;
      row.focus({ preventScroll: true });
    }
  }
}

/** The form open in the dialog, if any: "+ 새 예약 작업"'s, or a bot's (new or changed). */
const dialogKey = (): string | undefined => (schedForm === "new" ? "sched:new" : botForm !== undefined ? `bot:${botForm}` : undefined);
/** The data-focus of the control that opened the dialog, focused again when it closes (it was redrawn meanwhile). */
let dialogReturn: string | undefined;

/**
 * The new-schedule and bot forms, in one modal: a title on top, the form
 * scrolling between, and its buttons in a footer that stays on screen
 * (primary on the right). Esc, a backdrop press and 취소 close it; saving
 * closes it once it went through; what a save said shows inside it.
 */
let dialogBox: { dialog: HTMLDialogElement; head: HTMLHeadingElement; said: HTMLParagraphElement; body: HTMLDivElement; foot: HTMLDivElement } | undefined;
function formDialog(): void {
  const key = dialogKey();
  const editing = botForm !== undefined && botForm !== "new" ? bots.find((each) => each.id === botForm) : undefined;
  const spec = key === "sched:new" && schedList ? { title: t("schedules.new"), form: () => scheduleFormBox({ t }, schedList!) }
    : key === "bot:new" ? { title: t("automation.newBot"), form: () => botFormBox() }
    : editing ? { title: t("automation.editBotTitle", { name: editing.name }), form: () => botFormBox(editing, botFormAdd) }
    : undefined;
  if (!key || !spec) {
    if (dialogBox?.dialog.open) dialogBox.dialog.close();
    return;
  }
  if (!dialogBox) {
    const { dialog, head, body, foot } = dialogShell();
    const said = make("p", "autoSaid");
    dialog.addEventListener("close", () => {
      if (dialogKey() !== undefined) {
        // Esc or the backdrop: what an earlier try said goes with it.
        if (schedForm === "new") schedForm = undefined;
        else botForm = undefined;
        schedSaid = "";
        render();
      }
      // The control that opened it was redrawn meanwhile: the focus goes to the new one.
      if (dialogReturn) host?.querySelector<HTMLElement>(`[data-focus="${CSS.escape(dialogReturn)}"]`)?.focus();
    });
    dialogBox = { dialog, head, said, body, foot };
  }
  const { dialog, head, said, body, foot } = dialogBox;
  head.textContent = spec.title;
  dialog.setAttribute("aria-label", spec.title);
  // While it is open, what the save said is shown here, not behind the backdrop.
  said.textContent = schedSaid;
  said.hidden = !schedSaid;
  const form = keep(key, spec.form);
  if (body.lastChild !== form) {
    body.replaceChildren(form);
    // The form's own buttons, and what a save said, move to the footer, which stays put while the form scrolls.
    const actions = form.querySelector(".formActions");
    const problem = form.querySelector(".formProblem");
    foot.replaceChildren(said, ...(problem ? [problem] : []), ...(actions ? [actions] : []));
  }
  if (!dialog.open) {
    // The first field opens with the focus, not the scrolling body (a scroller is focusable too, and the dialog would pick it).
    dialog.showModal();
    body.querySelector<HTMLElement>("input, select, textarea, button")?.focus();
  }
}

/** The view opens on this bot's own page (the workflow map's 봇 페이지 열기). */
export function openBotPage(id: string): void {
  botOpen = id;
  botForm = undefined;
  botMenu = false;
}

/** A bot was saved or removed: an open view reads its list again. */
export function botsUpdated(): void {
  if (host && !host.hidden) loadBots();
}

function loadBots(): void {
  void window.cockpit.botList().then((list) => {
    bots = list;
    actions?.botsChanged(list);
  }, () => undefined).finally(render);
}

/**
 * Reads one PC's jobs, unless it is being read or was read within FRESH_MS;
 * `force` (새로 고침, after a change) reads anyway. What was there stays on
 * screen while it reads, and after a failure; an answer that shows the same
 * as before changes nothing on screen but the refresh icon.
 */
function loadJobs(nodeId: string, force = false): Promise<void> {
  const pc = actions?.pcs().find((each) => each.nodeId === nodeId);
  const before = pcJobs.get(nodeId);
  if (!pc) return Promise.resolve();
  if (before?.state === "loading") {
    // A change (pause, edit, run) while it reads: the answer under way is from before it, so one more read follows.
    if (force) rereadWanted.add(nodeId);
    return Promise.resolve();
  }
  if (!force && Date.now() - (readAt.get(nodeId) ?? -Infinity) < FRESH_MS) return Promise.resolve();
  readAt.set(nodeId, Date.now());
  const { state: _state, error: _error, ...kept } = before ?? { nodeId, pc: pc.label, jobs: [] };
  pcJobs.set(nodeId, { ...kept, state: "loading" });
  syncReading();
  let quiet = false;
  return window.cockpit.osJobs(nodeId).then(
    (read) => {
      if (!read.ok) return void pcJobs.set(nodeId, { ...kept, error: read.error });
      quiet = before !== undefined && !before.cached && !before.error && before.readAt !== undefined && sameJobs(before.jobs, read.jobs);
      pcJobs.set(nodeId, { nodeId, pc: pc.label, jobs: quiet ? before!.jobs : read.jobs, readAt: new Date().toISOString() });
    },
    (error: unknown) => void pcJobs.set(nodeId, { ...kept, error: String(error) }),
  ).finally(() => {
    // A request still under way covers this read too: no second one beside it.
    if (!aiLoading.has(nodeId)) aiAsked.delete(nodeId);
    if (quiet) syncReading();
    else render();
    if (rereadWanted.delete(nodeId)) void loadJobs(nodeId, true);
  });
}
/** PCs to read once more as soon as the read under way ends: a change was made while it ran. */
const rereadWanted = new Set<string>();

/** What the person calls a job: their own name for it, else its name in words. */
const shownName = (nodeId: string, job: OsJob) => names.get(`${nodeId}\n${job.id}`) || jobTitle(job).name;

/**
 * The AI's lines for a PC's jobs the OS says nothing about, while the switch
 * is on: once per read of that PC and never beside a request under way, 20
 * jobs a request (main answers kept lines without asking Haiku). The switch is
 * looked at again before each next 20, so turning it off stops the rest. A
 * failure shows nothing.
 */
function askAi(nodeId: string, jobs: OsJob[]): void {
  if (!aiOn || aiAsked.has(nodeId) || aiLoading.has(nodeId)) return;
  const locale = currentLocale();
  const items = jobs.filter((job) => !job.description).map((job) => describeItem(nodeId, job, locale)).filter((item) => !aiLines.has(item.key));
  if (items.length === 0) return;
  aiAsked.add(nodeId);
  aiLoading.add(nodeId);
  void (async () => {
    for (let from = 0; from < items.length; from += 20) {
      // Switched off: the rest waits, and switching on again asks for it.
      if (!aiOn) {
        aiAsked.delete(nodeId);
        return;
      }
      const answer = await window.cockpit.osJobDescribe(items.slice(from, from + 20), locale).catch(() => ({ lines: {}, failed: true as const }));
      for (const [key, text] of Object.entries(answer.lines)) aiLines.set(key, text);
      render();
      // Claude did not answer: not the next 20 either, until the next read.
      if (answer.failed) return;
    }
  })().finally(() => {
    aiLoading.delete(nodeId);
    render();
  });
}

function rename(nodeId: string, jobId: string, name: string): void {
  const key = `${nodeId}\n${jobId}`;
  if (name.trim()) names.set(key, name.trim().slice(0, 80));
  else names.delete(key);
  render();
  void window.cockpit.osJobRename(nodeId, jobId, name).catch(() => undefined);
}

// --- the page ------------------------------------------------------------

const make = <K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text?: string): HTMLElementTagNameMap[K] => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
};

const ICONS: Record<string, string> = {
  log: '<path d="M4 6h16M4 12h16M4 18h10"/>',
  run: '<path d="M7 4v16l13-8Z"/>',
  resume: '<path d="M7 4v16l13-8Z"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
  // The sidebar's reconnect icon (lucide rotate-cw).
  refresh: '<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/>',
  name: '<path d="M4 7V4h16v3M9 20h6M12 4v16"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
};

/** A quiet square button with a drawn icon and its words as the label. */
function iconButton(icon: string, label: string, click: () => void): HTMLButtonElement {
  const button = make("button", "autoIb");
  button.type = "button";
  button.setAttribute("aria-label", label);
  button.title = label;
  // A fixed string from ICONS: nothing read from a machine goes in here.
  button.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[icon]}</svg>`;
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    click();
  });
  return button;
}

/**
 * "새로 고침" as an icon. While it reads, the icon turns and a press does
 * nothing; it is not disabled, so it keeps the focus (data-focus brings it
 * back after each redraw).
 */
function refreshButton(focus: string, loading: boolean, click: () => void): HTMLButtonElement {
  const button = iconButton("refresh", t("schedules.refresh"), () => { if (!loading) click(); });
  button.dataset.focus = focus;
  if (loading) {
    button.classList.add("spinning");
    button.setAttribute("aria-busy", "true");
    button.setAttribute("aria-disabled", "true");
  }
  return button;
}

function linkButton(text: string, click: () => void): HTMLButtonElement {
  const button = make("button", "autoLink", text);
  button.type = "button";
  button.addEventListener("click", click);
  return button;
}

const clock = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

/** "오늘 16:00", "어제 16:00", or the date as well further off. */
export function whenText(iso: string): string {
  const at = new Date(iso);
  const time = clock(at.getHours() * 60 + at.getMinutes());
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  if (at.toDateString() === new Date().toDateString()) return t("automation.todayAt", { time });
  if (at.toDateString() === yesterday.toDateString()) return t("automation.yesterdayAt", { time });
  return `${formatDate(at, { month: "short", day: "numeric", weekday: "short" })} ${time}`;
}

const botKey = (bot: BotRow) => sessionKey(bot.nodeId, bot.repoId, false, bot.name);
const pcLabel = (nodeId: string) => actions?.pcs().find((pc) => pc.nodeId === nodeId)?.label ?? nodeId;

export function renderAutomation(target: HTMLElement, data: AutomationData, given: AutomationActions): void {
  const page = make("div", "auto");
  const bot = botOpen === undefined ? undefined : data.bots.find((each) => each.id === botOpen);
  if (bot) page.append(...botPage(bot, data, given));
  else {
    page.append(todaySection(data));
    // While the new-schedule dialog is open, what it said is shown in it, not behind the backdrop.
    if (schedSaid && !dialogKey()) page.append(make("p", "autoSaid", schedSaid));
    page.append(botsSection(data, given), jobsSection(data), routinesSection(), codexSection());
  }
  target.replaceChildren(page);
}

/** What a point on today's line stands for, and where a click on it goes. */
type TodayItem = { kind: "bot"; bot: BotRow } | { kind: "schedule"; row: ScheduleRow } | { kind: "job"; job: OsJob; nodeId: string };

/** The PC whose points today's line shows ("all", or a node id), kept across starts. */
let todayPc: string | undefined;
const todayPcOf = (): string => {
  if (todayPc === undefined) {
    try { todayPc = localStorage.getItem("automationTodayPc") ?? "all"; } catch { todayPc = "all"; }
  }
  return todayPc;
};

/** One tooltip for today's points, in the app's popover look (as #hoverTip), with a chip in it. */
let todayTip: HTMLDivElement | undefined;
function showTodayTip(dot: HTMLElement, parts: { time: string; name: string; chip: HTMLElement; pc: string }): void {
  if (!todayTip) {
    todayTip = make("div", "autoTip");
    todayTip.setAttribute("role", "tooltip");
    todayTip.id = "autoTodayTip";
    document.body.append(todayTip);
  }
  const line = make("div", "autoTipLine");
  line.append(make("strong", "", parts.time), " ", parts.name, parts.chip);
  todayTip.replaceChildren(line, make("div", "autoMuted", parts.pc));
  todayTip.hidden = false;
  const box = dot.getBoundingClientRect();
  const left = Math.min(Math.max(8, box.left + box.width / 2 - todayTip.offsetWidth / 2), window.innerWidth - todayTip.offsetWidth - 8);
  const above = box.top - todayTip.offsetHeight - 8;
  todayTip.style.left = `${left}px`;
  todayTip.style.top = `${above >= 8 ? above : box.bottom + 8}px`;
  dot.setAttribute("aria-describedby", todayTip.id);
}
const hideTodayTip = () => { if (todayTip) todayTip.hidden = true; };

/** A row to bring into view and flash once it is drawn (data-row), after a click on today's line. */
let flash: { id: string; at: number; scrolled: boolean } | undefined;
const FLASH_MS = 1800;
/** Names a list row for today's line, and flashes it if it is the one clicked; a redraw meanwhile picks the flash up where it was. */
function markRow(row: HTMLElement, id: string): void {
  row.dataset.row = id;
  const gone = flash?.id === id ? Date.now() - flash.at : Infinity;
  if (gone >= FLASH_MS) return;
  row.classList.add("autoFlash");
  row.style.animationDelay = `-${gone}ms`;
}

/**
 * A point clicked: an OS job or a Lepons schedule opens its PC's list, on the
 * filter and page that hold it; a bot's job opens the bot.
 */
function goToToday(item: TodayItem): void {
  hideTodayTip();
  // Off the dot first, so the redraw does not give it the focus back (and its tooltip with it).
  if (document.activeElement instanceof HTMLElement && document.activeElement.classList.contains("autoDot")) document.activeElement.blur();
  if (item.kind === "bot") {
    botOpen = item.bot.id;
    botMenu = false;
    loadJobs(item.bot.nodeId);
    render();
    host?.scrollTo({ top: 0 });
    return;
  }
  const nodeId = item.kind === "job" ? item.nodeId : item.row.nodeId;
  const id = item.kind === "job" ? `job:${item.job.id}` : `sched:${item.row.id}`;
  pcPicked = nodeId;
  loadJobs(nodeId);
  // Unfolded, on a filter that shows it, at the page that holds it.
  if (folds?.delete("jobs")) try { localStorage.setItem("automationFolds", JSON.stringify([...folds])); } catch { /* this start only */ }
  const folders = actions?.pcs().find((pc) => pc.nodeId === nodeId)?.folders ?? [];
  const kind = filterOf(nodeId);
  const row: ListRow = item.kind === "job" ? { job: item.job } : { schedule: item.row };
  if (kind !== "all" && rowKind(row, folders) !== kind) {
    filters = { ...filters, [nodeId]: "all" };
    try { localStorage.setItem("automationFilter", JSON.stringify(filters)); } catch { /* this start only */ }
  }
  const read = pcJobs.get(nodeId);
  const jobs = read ? read.jobs.filter((job) => job.source !== "lepons") : [];
  const all = listRows(bots.filter((bot) => bot.nodeId === nodeId), jobs, schedList?.schedules.filter((each) => each.nodeId === nodeId) ?? []);
  const shown = filterOf(nodeId) === "all" ? all : all.filter((each) => rowKind(each, folders) === filterOf(nodeId));
  const at = shown.findIndex((each) => ("job" in each ? `job:${each.job.id}` : `sched:${each.schedule.id}`) === id);
  jobsPage = Math.max(0, Math.floor(at / PAGE_SIZE));
  flash = { id, at: Date.now(), scrolled: false };
  render();
}

function todaySection(data: AutomationData): HTMLElement {
  const now = new Date();
  const nowAt = now.getHours() * 60 + now.getMinutes();
  const pcs = actions?.pcs() ?? [];
  const pick = pcs.some((pc) => pc.nodeId === todayPcOf()) ? todayPcOf() : "all";
  const on = (nodeId: string) => pick === "all" || pick === nodeId;
  // Each point remembers what it stands for. Lepons' own schedules come from their list, by name; the OS's copy of them only has an id for a label.
  const itemOf = new Map<object, TodayItem>();
  const botLike = [
    ...data.bots.filter((bot) => on(bot.nodeId)).map((bot) => {
      itemOf.set(bot, { kind: "bot", bot });
      return bot;
    }),
    ...(schedList?.schedules ?? []).filter((row) => on(row.nodeId)).flatMap((row) => {
      const parsed = row.cron ? parseWhen(row.cron) : undefined;
      if (!parsed?.ok) return [];
      const one = { name: row.name ?? row.id, ...(row.paused ? { paused: true } : {}), jobs: [{ when: parsed.when }] };
      itemOf.set(one, { kind: "schedule", row });
      return [one];
    }),
  ];
  const osJobs = data.jobs.filter((pc) => on(pc.nodeId)).flatMap((pc) => pc.jobs.filter((job) => job.source !== "lepons").map((job) => {
    const named = { ...job, label: shownName(pc.nodeId, job) };
    itemOf.set(named, { kind: "job", job, nodeId: pc.nodeId });
    return named;
  }));
  const points = todayPoints(botLike, osJobs, now);
  const past = points.filter((point) => point.at <= nowAt).length;
  const section = make("section", "autoSection");
  section.setAttribute("aria-label", t("automation.today"));
  const head = make("div", "autoHead");
  const create = linkButton(t("automation.newBotButton"), () => {
    botForm = "new";
    dialogReturn = "newBot";
    schedSaid = "";
    render();
  });
  create.dataset.focus = "newBot";
  create.classList.add("autoHeadEnd");
  head.append(make("span", "autoTitle", t("automation.today")), make("span", "autoMuted", t("automation.todayCount", { past, left: points.length - past })));
  // Which PC's points: all, or one, as the jobs list's chips.
  if (pcs.length > 1) {
    for (const [id, label] of [["all", t("automation.kind.all")], ...pcs.map((pc) => [pc.nodeId, pc.label])] as Array<[string, string]>) {
      const chip = make("button", "autoPc", label);
      chip.type = "button";
      chip.dataset.focus = `today:${id}`;
      chip.setAttribute("aria-pressed", String(id === pick));
      chip.addEventListener("click", () => {
        todayPc = id;
        try { localStorage.setItem("automationTodayPc", id); } catch { /* this start only */ }
        render();
      });
      head.append(chip);
    }
  }
  head.append(create);
  const track = make("div", "autoLine");
  const pct = (at: number) => `${(at / 1440) * 100}%`;
  const gone = make("div", "autoGone");
  gone.style.width = pct(nowAt);
  const bar = make("div", "autoNow");
  bar.style.left = pct(nowAt);
  const tag = make("div", "autoNowTag", t("automation.now"));
  tag.style.left = pct(nowAt);
  track.append(make("div", "autoTrack"), gone, bar, tag);
  const next = points.find((point) => point.at > nowAt);
  points.forEach((point, at) => {
    const item = itemOf.get(point.of as object);
    if (!item) return;
    const dot = make("button", `autoDot${point.at > nowAt ? " left" : ""}${point === next ? " next" : ""}`);
    dot.type = "button";
    dot.style.left = pct(point.at);
    dot.dataset.focus = `dot:${at}`;
    const nodeId = item.kind === "bot" ? item.bot.nodeId : item.kind === "schedule" ? item.row.nodeId : item.nodeId;
    const chip = item.kind === "bot" ? make("span", "autoSrc", t("automation.bots"))
      : item.kind === "schedule" ? make("span", "autoSrc", t("automation.src.lepons"))
      : originChip(jobOrigin(item.job, pcs.find((pc) => pc.nodeId === nodeId)?.folders ?? []));
    const parts = { time: clock(point.at), name: point.label, chip, pc: pcLabel(nodeId) };
    dot.setAttribute("aria-label", `${parts.time} ${parts.name} · ${chip.textContent} · ${parts.pc}`);
    dot.addEventListener("mouseenter", () => showTodayTip(dot, parts));
    dot.addEventListener("focus", () => showTodayTip(dot, parts));
    dot.addEventListener("mouseleave", hideTodayTip);
    dot.addEventListener("blur", hideTodayTip);
    dot.addEventListener("click", () => goToToday(item));
    track.append(dot);
  });
  const ticks = make("div", "autoTicks");
  for (const hour of [0, 6, 12, 18, 24]) ticks.append(make("span", "", t("automation.hour", { n: hour })));
  track.append(ticks);
  if (next) {
    const label = make("div", "autoNextTag", `${clock(next.at)} ${next.label}`);
    label.style.left = pct(next.at);
    // Near either end the label hangs inward rather than off the edge.
    if (next.at > 1440 * 0.85) label.style.transform = "translateX(-100%)";
    else if (next.at < 1440 * 0.15) label.style.transform = "none";
    track.append(label);
  }
  section.append(head, track);
  return section;
}

function botsSection(data: AutomationData, given: AutomationActions): HTMLElement {
  const section = make("section", "autoSection");
  section.setAttribute("aria-label", t("automation.bots"));
  section.append(make("span", "autoTitle", t("automation.bots")));
  if (data.bots.length === 0) {
    section.append(make("p", "autoMuted", t("automation.noBots")));
    return section;
  }
  const cards = make("div", "autoCards");
  cards.append(...data.bots.map((bot) => botCard(bot, given)));
  section.append(cards);
  return section;
}

/** Why a run was skipped, in words. */
export const skipText = (reason?: string): string =>
  t(`automation.skip.${["busy", "unreachable", "timeout", "open_failed", "paused", "interrupted", "no_folder", "edited"].includes(reason ?? "") ? reason : "other"}`);

/** How a run went, in words; the AI's own last words when it left some. */
function runText(run: BotRun): string {
  if (run.answer) return run.answer;
  if (run.state === "skipped") return skipText(run.reason);
  return t(run.state === "failed" ? "automation.runFailed" : run.state === "missed" ? "automation.runMissed" : "automation.runDone");
}

/** "놓친 실행 1회 (어제 09:00)", with running the missed job once or letting it go; either clears it. */
function missedNote(bot: BotRow): HTMLElement[] {
  if (!bot.missed) return [];
  const note = make("span", "autoMissed");
  const act = (text: string, run: boolean) => {
    const element = make("button", "autoBtn", text);
    element.type = "button";
    element.addEventListener("click", (event) => {
      event.stopPropagation();
      botChange(window.cockpit.botMissed(bot.id, run), run ? t("automation.started", { name: bot.name }) : "");
    });
    return element;
  };
  note.append(make("span", "", t("automation.missed", { count: bot.missed.count, time: whenText(bot.missed.at) })));
  // Paused, a run would only be called off and the notice gone with it: only letting it go is offered.
  if (!bot.paused) note.append(act(t("automation.missedRun"), true));
  note.append(act(t("automation.missedSkip"), false));
  return [note];
}

function botCard(bot: BotRow, given: AutomationActions): HTMLElement {
  const card = make("div", `autoCard${bot.paused ? " paused" : ""}`);
  card.tabIndex = 0;
  card.setAttribute("role", "button");
  const open = () => {
    botOpen = bot.id;
    botMenu = false;
    // Its PC's jobs, for the ones grouped under it (skipped if read within the minute).
    loadJobs(bot.nodeId);
    render();
  };
  card.addEventListener("click", open);
  card.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && event.target === card) open();
  });
  const head = make("span", "autoCardHead");
  const lamp = make("span", "lamp");
  if (!bot.paused) given.lamp(lamp, botKey(bot));
  head.append(lamp, make("strong", "", bot.name), make("span", "autoMuted", pcLabel(bot.nodeId)));
  const body = make("span", "autoCardBody", bot.paused ? t("automation.paused") : bot.last ? runText(bot.last) : t("automation.never"));
  const foot = make("span", "autoCardFoot");
  // A paused bot says when it would run again; `nextRun` is its next due time whether paused or not.
  const due = bot.nextRun && new Date(bot.nextRun).toDateString() === new Date().toDateString()
    ? clock(new Date(bot.nextRun).getHours() * 60 + new Date(bot.nextRun).getMinutes()) : bot.nextRun && whenText(bot.nextRun);
  foot.append(make("span", "autoCardNext", bot.paused ? due ? t("automation.pausedFrom", { time: due }) : t("automation.pausedNext")
    : bot.nextRun ? t("automation.nextRun", { time: whenText(bot.nextRun) }) : t("automation.noNext")));
  // Shown instead of the line above while its session waits on a question (CSS, so it follows the lamp).
  if (!bot.paused) foot.append(make("span", "autoCardWait", t("automation.waiting")));
  const acts = make("span", "autoActs");
  acts.append(
    iconButton("run", t("automation.runNow"), () => botChange(window.cockpit.botRunNow(bot.id), t("automation.started", { name: bot.name }))),
    bot.paused
      ? iconButton("resume", t("osjob.action.resume"), () => botChange(window.cockpit.botPause(bot.id, false)))
      : iconButton("pause", t("osjob.action.pause"), () => botChange(window.cockpit.botPause(bot.id, true))),
  );
  foot.append(acts);
  card.append(head, body, ...missedNote(bot), foot);
  return card;
}

/** Runs a bot change, then reads the bots again; what went wrong stays on screen. */
function botChange(change: Promise<ScheduleDone>, done?: string, after?: () => void): void {
  schedSaid = t("schedules.working");
  render();
  void change.then((result) => {
    schedSaid = result.ok ? done ?? "" : scheduleError(t, result.error);
    if (result.ok) after?.();
    loadBots();
  }, (error: unknown) => {
    schedSaid = scheduleError(t, String(error));
    render();
  });
}

function jobsSection(data: AutomationData): HTMLElement {
  const section = make("section", "autoSection");
  section.setAttribute("aria-label", t("automation.jobs"));
  const pcs = actions?.pcs() ?? [];
  const picked = pcs.find((pc) => pc.nodeId === pcPicked) ?? pcs[0];
  const head = make("div", "autoHead");
  head.append(foldTitle("jobs", t("automation.jobs")));
  for (const pc of pcs) {
    const read = data.jobs.find((each) => each.nodeId === pc.nodeId);
    const count = read?.readAt !== undefined
      ? read.jobs.filter((job) => job.source !== "lepons").length + (schedList?.schedules.filter((row) => row.nodeId === pc.nodeId).length ?? 0)
      : undefined;
    const chip = make("button", "autoPc", count === undefined ? pc.label : `${pc.label} ${count}`);
    chip.type = "button";
    chip.dataset.focus = `pc:${pc.nodeId}`;
    chip.setAttribute("aria-pressed", String(pc === picked));
    chip.addEventListener("click", () => {
      if (pc !== picked) jobsPage = 0;
      pcPicked = pc.nodeId;
      loadJobs(pc.nodeId);
      render();
    });
    head.append(chip);
  }
  const tools = make("span", "autoTools");
  if (picked && aiOn && aiLoading.has(picked.nodeId)) tools.append(make("span", "autoMuted", t("automation.aiLoading")));
  const ai = make("button", "switch");
  ai.type = "button";
  ai.dataset.focus = "ai";
  ai.setAttribute("role", "switch");
  ai.setAttribute("aria-checked", String(aiOn));
  ai.title = t("automation.aiHint");
  ai.append(make("i"), t("automation.ai"));
  ai.addEventListener("click", () => {
    aiOn = !aiOn;
    try { localStorage.setItem("automationAi", aiOn ? "1" : "0"); } catch { /* this start only */ }
    render();
  });
  tools.append(ai);
  const create = linkButton(`+ ${t("schedules.new")}`, () => {
    schedForm = "new";
    dialogReturn = "newSchedule";
    // A bot's or a job's last words do not belong in the new dialog.
    schedSaid = "";
    render();
  });
  create.dataset.focus = "newSchedule";
  // The form needs the list's places; it comes with the first read.
  create.disabled = !schedList;
  tools.append(create);
  tools.append(refreshButton("refresh", reading(), () => {
    if (picked) loadJobs(picked.nodeId, true);
    loadSchedules();
    loadBots();
    render();
  }));
  head.append(tools);
  section.append(head);
  if (!picked || folded("jobs")) return section;

  // The OS's jobs and Lepons' own schedules on that PC, one list, a page at a time.
  const read = data.jobs.find((each) => each.nodeId === picked.nodeId);
  // While it is read again, the list it had stays (loadJobs keeps it), so the page does not jump back.
  const settled = read !== undefined && !read.state && !read.error;
  // What was read last stays while it is read again, and after a failure.
  const jobs = read ? read.jobs.filter((job) => job.source !== "lepons") : [];
  const all = listRows(data.bots.filter((bot) => bot.nodeId === picked.nodeId), jobs, schedList?.schedules.filter((row) => row.nodeId === picked.nodeId) ?? []);
  if (settled) askAi(picked.nodeId, jobs);
  // The filter first, then a page of what it keeps.
  const kind = filterOf(picked.nodeId);
  const rows = kind === "all" ? all : all.filter((row) => rowKind(row, picked.folders) === kind);
  // A schedule just made: its page, once the list read after the save has it.
  if (made && made.nodeId === picked.nodeId && !schedLoading && schedAt >= made.at) {
    const at = rows.findIndex((row) => "schedule" in row && !made!.before.has(row.schedule.id));
    if (at >= 0) jobsPage = Math.floor(at / PAGE_SIZE);
    made = undefined;
  }
  const page = pageOf(rows, jobsPage);
  // Clamped only against a list that is all there: one still loading or failed does not move the page.
  if (settled) jobsPage = page.page;
  if (page.pages > 1) {
    const pager = make("span", "autoPager");
    const step = (by: number, text: string, label: string) => {
      const button = make("button", "autoIb", text);
      button.type = "button";
      button.dataset.focus = `page:${by}`;
      button.setAttribute("aria-label", label);
      button.title = label;
      // aria-disabled, not disabled: the arrow just pressed keeps the focus on the first or last page.
      const end = page.page + by < 0 || page.page + by >= page.pages;
      button.setAttribute("aria-disabled", String(end));
      button.addEventListener("click", () => {
        if (end) return;
        jobsPage = page.page + by;
        render();
      });
      return button;
    };
    pager.append(step(-1, "‹", t("automation.pagePrev")), make("span", "autoMuted", `${page.page + 1} / ${page.pages}`), step(1, "›", t("automation.pageNext")));
    head.append(pager);
  }
  if (all.length > 0) {
    const chips = make("div", "autoFilters");
    chips.setAttribute("role", "group");
    chips.setAttribute("aria-label", t("automation.filter"));
    for (const each of JOB_KINDS) {
      const chip = make("button", "autoPc", t(`automation.kind.${each}`));
      chip.type = "button";
      chip.dataset.focus = `kind:${each}`;
      chip.setAttribute("aria-pressed", String(each === kind));
      chip.addEventListener("click", () => {
        filters = { ...filters, [picked.nodeId]: each };
        try { localStorage.setItem("automationFilter", JSON.stringify(filters)); } catch { /* this start only */ }
        jobsPage = 0;
        render();
      });
      chips.append(chip);
    }
    section.append(chips);
  }
  const list = make("div", "autoJobs");
  if (!read) list.append(make("p", "autoMuted", t("automation.notRead")));
  else if (read.readAt === undefined) {
    // Never read: what is happening, as before.
    if (read.state === "loading") list.append(make("p", "autoMuted", t("schedules.loading")));
    else if (read.error) list.append(make("p", "autoMuted bad", t("automation.jobsFailed", { detail: read.error })));
  } else if ((read.cached || read.error) && read.state !== "loading") {
    // An older list: said quietly, with why on hover.
    const note = make("p", "autoMuted", t("automation.readAt", { time: whenText(read.readAt) }));
    if (read.error) note.title = t("automation.jobsFailed", { detail: read.error });
    list.append(note);
  }
  for (const row of page.rows) {
    if ("job" in row) list.append(...jobRow(picked.nodeId, row.job, row.bot, jobOrigin(row.job, picked.folders)));
    else {
      // Lepons' own keep their card and its buttons, as the settings tab had them.
      const own = make("div", "autoSet");
      markRow(own, `sched:${row.schedule.id}`);
      own.append(scheduleRow({ t }, schedList!, row.schedule));
      list.append(own);
    }
  }
  if (!schedList && schedLoading) list.append(make("p", "autoMuted", t("schedules.loading")));
  else if (rows.length === 0 && read?.readAt !== undefined && read.state !== "loading") list.append(make("p", "autoMuted", t(all.length > 0 ? "automation.noKind" : "automation.noJobs")));
  section.append(list);
  return section;
}

const baseName = (path: string) => path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);

/** A job's name field while it is renamed: Enter keeps what is typed (empty: back to its own name), Esc leaves it. */
function nameField(nodeId: string, job: OsJob): HTMLInputElement {
  const input = make("input", "autoRename");
  input.value = names.get(`${nodeId}\n${job.id}`) ?? "";
  input.placeholder = jobTitle(job).name;
  input.maxLength = 80;
  input.setAttribute("aria-label", t("automation.rename"));
  input.title = t("automation.renameHint");
  input.addEventListener("keydown", (event) => {
    if (event.isComposing) return;
    if (event.key === "Enter") {
      nameEdit = undefined;
      rename(nodeId, job.id, input.value);
    } else if (event.key === "Escape") {
      event.stopPropagation();
      nameEdit = undefined;
      render();
    }
  });
  requestAnimationFrame(() => input.focus());
  return input;
}

/** Line 1's words: the person's name for the job, else its name in words; the full name and command on hover. */
function jobName(nodeId: string, job: OsJob): HTMLSpanElement {
  const name = make("span", `autoJobName${job.enabled ? "" : " off"}`, shownName(nodeId, job));
  name.title = [job.label, job.command, t(`automation.src.${job.source}`)].filter(Boolean).join("\n");
  return name;
}

/** Where a job comes from, as a chip: OS / 앱 / 내 작업 / 프로젝트: name. */
const originChip = (origin: JobOrigin): HTMLSpanElement =>
  make("span", "autoSrc", origin.kind === "project" ? t("automation.kind.projectOf", { name: origin.name ?? "" }) : t(`automation.kind.${origin.kind}`));

/**
 * Line 2: its source or vendor, then what the OS says it does, else the AI's
 * line already kept (marked AI, only while the switch is on), else the
 * program's file name. Nothing to say: undefined. Never asks the AI itself.
 */
function jobSub(nodeId: string, job: OsJob, origin: JobOrigin): HTMLSpanElement | undefined {
  const vendor = origin.kind === "app" && origin.name ? origin.name : jobTitle(job).source;
  const ai = aiOn && !job.description ? aiLines.get(describeItem(nodeId, job, currentLocale()).key) : undefined;
  const program = jobProgram(job);
  const about = job.description ?? ai ?? (program ? baseName(program) : undefined);
  if (!vendor && !about) return undefined;
  const sub = make("span", "autoJobSub");
  sub.title = [vendor, about].filter(Boolean).join(" · ");
  if (vendor) sub.append(vendor);
  if (vendor && about) sub.append(" · ");
  if (ai) sub.append(make("span", "autoAi", t("automation.aiMark")));
  if (about) sub.append(about);
  return sub;
}

/**
 * Line 1: the person's name for the job, else its name in words, with where
 * it comes from as a chip; the full name and command on hover. Line 2: its
 * source or vendor, then what the OS says it does, else the AI's line (marked
 * AI), else the program's file name.
 */
function jobRow(nodeId: string, job: OsJob, bot: string | undefined, origin: JobOrigin): HTMLElement[] {
  const row = make("div", `autoJob${jobLogs.has(job.id) || jobInfo.has(job.id) || jobEdit === job.id || nameEdit === job.id ? " hot" : ""}`);
  markRow(row, `job:${job.id}`);
  const text = make("div", "autoJobText");
  const name = jobName(nodeId, job);
  if (bot) name.append(" ", make("span", "autoMuted", bot));
  if (!job.enabled) name.append(" ", make("span", "autoMuted", t("automation.off")));
  name.append(originChip(origin));
  text.append(nameEdit === job.id ? keep(`name:${job.id}`, () => nameField(nodeId, job)) : name);
  const sub = jobSub(nodeId, job, origin);
  if (sub) text.append(sub);
  const acts = make("span", "autoActs");
  const control = (action: OsJobDo) => {
    if (action === "log") {
      if (jobLogs.delete(job.id)) return render();
      jobLogs.set(job.id, t("schedules.loading"));
      render();
      void window.cockpit.osJobControl(nodeId, job.id, "log").then((result) => {
        jobLogs.set(job.id, result.ok ? result.output?.trim() || t("schedules.noOutput") : scheduleError(t, result.error));
      }, (error: unknown) => jobLogs.set(job.id, String(error))).finally(render);
      return;
    }
    if (action === "edit") {
      jobEdit = jobEdit === job.id ? undefined : job.id;
      return render();
    }
    jobChange(nodeId, window.cockpit.osJobControl(nodeId, job.id, action));
  };
  for (const action of jobActions(job)) acts.append(iconButton(action, t(action === "log" ? "automation.log" : `osjob.action.${action}`), () => control(action)));
  acts.append(iconButton("info", t("automation.info"), () => {
    if (!jobInfo.delete(job.id)) jobInfo.add(job.id);
    render();
  }), iconButton("name", t("automation.rename"), () => {
    nameEdit = nameEdit === job.id ? undefined : job.id;
    render();
  }));
  const lamp = make("span", `lamp${job.enabled ? " live" : ""}`);
  row.append(lamp, text, make("span", "autoWhen", job.resident ? t("automation.resident") : job.schedule ? scheduleText(job.schedule) : ""), acts);
  const out: HTMLElement[] = [row];
  if (jobInfo.has(job.id)) {
    // The job as the OS has it, word for word: what the cleaned name and the chip were made from.
    out.push(make("pre", "autoLog", [
      [t("automation.info.name"), job.label], [t("automation.info.command"), job.command], [t("automation.info.cwd"), job.cwd],
      [t("automation.info.author"), job.author], [t("automation.info.file"), job.file], [t("automation.info.kind"), t(`automation.src.${job.source}`)],
    ].filter(([, value]) => value).map(([label, value]) => `${label}: ${value}`).join("\n")));
  }
  const log = jobLogs.get(job.id);
  if (log !== undefined) out.push(make("pre", "autoLog", log));
  if (jobEdit === job.id) out.push(keep(`edit:${job.id}`, () => jobEditBox(nodeId, job)));
  return out;
}

/** The cron a job's time starts from in the picker, where it has one simple enough. */
function jobCron(job: OsJob): string | undefined {
  if (job.source === "cron") return job.id.slice("cron:".length).trim().replace(/^#/, "").split(/\s+/).slice(0, 5).join(" ");
  const entry = job.schedule?.kind === "calendar" && job.schedule.entries.length === 1 ? job.schedule.entries[0] : undefined;
  return entry?.hour === undefined ? undefined : `${entry.minute} ${entry.hour} * * ${entry.weekday === undefined ? "*" : entry.weekday % 7}`;
}

function jobEditBox(nodeId: string, job: OsJob): HTMLElement {
  const box = make("div", "autoSet");
  const form = make("div", "setSchedForm");
  const picker = whenPicker(t, jobCron(job));
  const save = buttons([t("schedules.save"), () => jobChange(nodeId, window.cockpit.osJobControl(nodeId, job.id, "edit", picker.value()), () => { jobEdit = undefined; })],
    [t("schedules.cancel"), () => {
      jobEdit = undefined;
      render();
    }]);
  save.querySelector("button")?.classList.add("go");
  form.append(make("p", "setNote", t("schedules.when")), picker.row, save);
  box.append(form);
  return box;
}

/** An OS job change: main asks first (its approval dialog), so nothing is asked here. Then that PC is read again. */
function jobChange(nodeId: string, change: Promise<{ ok: true; output?: string } | { ok: false; error: string }>, after?: () => void): void {
  schedSaid = t("schedules.working");
  render();
  void change.then((result) => {
    schedSaid = result.ok ? "" : scheduleError(t, result.error);
    if (result.ok) {
      after?.();
      loadJobs(nodeId, true);
    }
  }, (error: unknown) => { schedSaid = scheduleError(t, String(error)); }).finally(render);
}

const ROUTINES_URL = "https://claude.ai/code/routines";

function routinesError(error: string): string {
  if (error.startsWith("unreachable")) return t("automation.routines.unreachable");
  if (error.startsWith("timeout")) return t("automation.routines.timeout");
  if (error.startsWith("routines_refused")) return t("automation.routines.refused");
  if (error.startsWith("routines_failed")) return t("automation.routines.failed", { detail: error.slice("routines_failed: ".length) });
  return t("schedules.failed", { detail: error });
}

/** Read only when asked (불러오기, 새로 고침): each read runs `claude -p` on this PC. */
function loadRoutines(): void {
  routines = { ...routines, loading: true, error: undefined };
  render();
  void window.cockpit.routines(localNodeId).then((result) => {
    routines = result.ok ? { loading: false, text: result.text } : { loading: false, error: routinesError(result.error) };
  }, (error: unknown) => {
    routines = { loading: false, error: routinesError(String(error)) };
  }).finally(render);
}

function routinesSection(): HTMLElement {
  const section = make("section", "autoSection");
  section.setAttribute("aria-label", t("automation.routines"));
  const head = make("div", "autoHead");
  const tools = make("span", "autoTools");
  // 불러오기 in words the first time; read once, it is the refresh icon.
  const first = routines.text === undefined && !routines.error;
  const load = first ? linkButton(t("automation.routinesLoad"), loadRoutines) : refreshButton("routinesLoad", routines.loading, loadRoutines);
  load.dataset.focus = "routinesLoad";
  if (first) load.disabled = routines.loading;
  tools.append(load, linkButton(t("automation.routinesOpen"), () => void window.cockpit.openLink("", ROUTINES_URL)));
  head.append(foldTitle("routines", t("automation.routines")), tools);
  section.append(head);
  if (folded("routines")) return section;
  if (routines.loading) section.append(make("p", "autoMuted", t("schedules.loading")));
  else if (routines.error) section.append(make("p", "autoMuted bad", routines.error));
  else if (routines.text !== undefined) section.append(make("pre", "autoLog", routines.text));
  else section.append(make("p", "autoMuted", t("automation.routinesNote")));
  return section;
}

// --- Codex ------------------------------------------------------------------

type CodexRead = Awaited<ReturnType<typeof window.cockpit.codexAutomations>>;
let codex: { loading: boolean; read?: CodexRead; error?: string } = { loading: false };
/** Codex app automations whose prompt is open under their row, by id. */
const codexOpen = new Set<string>();

/** Read only when asked: it opens Codex's file and runs `codex cloud list` on this PC. */
function loadCodex(): void {
  codex = { ...codex, loading: true, error: undefined };
  render();
  void window.cockpit.codexAutomations().then((read) => {
    codex = { loading: false, read };
  }, (error: unknown) => {
    codex = { loading: false, error: String(error) };
  }).finally(render);
}

function codexAutomationRow(row: CodexAutomation): HTMLElement[] {
  const on = row.status.toUpperCase() === "ACTIVE";
  const line = make("div", `autoJob${codexOpen.has(row.id) ? " hot" : ""}`);
  const text = make("div", "autoJobText");
  const name = make("span", `autoJobName${on ? "" : " off"}`, row.name);
  if (!on) name.append(" ", make("span", "autoMuted", row.status.toUpperCase() === "PAUSED" ? t("automation.off") : row.status));
  text.append(name);
  const schedule = rruleSchedule(row.rrule);
  const folders = row.cwds.map((cwd) => cwd.slice(Math.max(cwd.lastIndexOf("/"), cwd.lastIndexOf("\\")) + 1)).filter(Boolean);
  const sub = [folders.join(", "), schedule ? scheduleText(schedule) : row.rrule].filter(Boolean).join(" · ");
  if (sub) text.append(make("span", "autoJobSub", sub));
  const acts = make("span", "autoActs");
  acts.append(iconButton("info", t("automation.info"), () => {
    if (!codexOpen.delete(row.id)) codexOpen.add(row.id);
    render();
  }));
  line.append(make("span", `lamp${on ? " live" : ""}`), text, make("span", "autoWhen", row.nextRunAt ? t("automation.codexNext", { time: whenText(row.nextRunAt) }) : ""), acts);
  if (!codexOpen.has(row.id)) return [line];
  // The prompt as Codex keeps it, as text.
  return [line, make("pre", "autoLog", [
    [t("automation.codexPrompt"), row.prompt], [t("automation.info.cwd"), row.cwds.join(", ")], [t("automation.codexRrule"), row.rrule], [t("automation.codexModel"), row.model],
  ].filter(([, value]) => value).map(([label, value]) => `${label}: ${value}`).join("\n"))];
}

function codexCloudRow(task: CodexCloudTask): HTMLElement {
  const line = make("div", "autoJob");
  const text = make("div", "autoJobText");
  text.append(make("span", "autoJobName", task.title));
  const sub = [task.environment, task.status].filter(Boolean).join(" · ");
  if (sub) text.append(make("span", "autoJobSub", sub));
  line.append(make("span", "lamp"), text, make("span", "autoWhen", task.updatedAt ? whenText(task.updatedAt) : ""), make("span"));
  return line;
}

/** "Codex Automation": the Codex app's automations and Codex Cloud tasks of this PC, as the routines section reads Claude's. */
function codexSection(): HTMLElement {
  const section = make("section", "autoSection");
  section.setAttribute("aria-label", t("automation.codex"));
  const head = make("div", "autoHead");
  const tools = make("span", "autoTools");
  const first = codex.read === undefined && !codex.error;
  const load = first ? linkButton(t("automation.routinesLoad"), loadCodex) : refreshButton("codexLoad", codex.loading, loadCodex);
  load.dataset.focus = "codexLoad";
  if (first) load.disabled = codex.loading;
  tools.append(load);
  head.append(foldTitle("codex", t("automation.codex")), tools);
  section.append(head);
  if (folded("codex")) return section;
  if (codex.loading) section.append(make("p", "autoMuted", t("schedules.loading")));
  else if (codex.error) section.append(make("p", "autoMuted bad", t("schedules.failed", { detail: codex.error })));
  else if (!codex.read) section.append(make("p", "autoMuted", t("automation.codexNote")));
  else {
    const { app, cloud } = codex.read;
    const list = make("div", "autoJobs");
    list.append(make("p", "autoSub", t("automation.codexApp")));
    if (!app.ok) {
      // SQLite's own words (English, with a path) only on hover.
      const said = make("p", "autoMuted", t(app.error === "missing" ? "automation.codexAppMissing" : "automation.codexAppFailed"));
      if (app.error !== "missing") said.title = app.error;
      list.append(said);
    }
    else if (app.rows.length === 0) list.append(make("p", "autoMuted", t("automation.codexAppNone")));
    else for (const row of app.rows) list.append(...codexAutomationRow(row));
    list.append(make("p", "autoSub", t("automation.codexCloud")));
    if (!cloud.ok) {
      const said = make("p", "autoMuted", t("automation.codexCloudFailed"));
      said.title = cloud.error;
      list.append(said);
    }
    else if (cloud.tasks.length === 0) list.append(make("p", "autoMuted", t("automation.codexCloudNone")));
    else for (const task of cloud.tasks) list.append(codexCloudRow(task));
    section.append(list);
  }
  return section;
}

// --- a bot on its own page --------------------------------------------------

function botPage(bot: BotRow, data: AutomationData, given: AutomationActions): HTMLElement[] {
  const head = make("div", "autoHead autoBotHead");
  const back = linkButton(t("automation.back"), () => {
    botOpen = undefined;
    botForm = undefined;
    // Nothing left open out of sight for the next Esc to spend itself on.
    botMenu = false;
    jobEdit = undefined;
    nameEdit = undefined;
    render();
  });
  back.classList.add("autoCrumb");
  const lamp = make("span", "lamp");
  if (!bot.paused) given.lamp(lamp, botKey(bot));
  const folder = given.pcs().find((pc) => pc.nodeId === bot.nodeId)?.folders.find((each) => each.id === bot.repoId)?.label ?? bot.folder;
  const right = make("span", "autoBotTools");
  const button = (text: string, click: () => void) => {
    const element = make("button", "autoBtn", text);
    element.type = "button";
    element.addEventListener("click", click);
    return element;
  };
  // The list here only reads; its buttons open the bot's dialog, where the jobs are changed and ordered.
  const openForm = (add: boolean, from: string) => {
    botForm = bot.id;
    botFormAdd = add;
    dialogReturn = from;
    schedSaid = "";
    render();
  };
  // The two used most stay buttons; the rest wait under ⋯, 삭제 last and apart.
  right.append(
    button(t("automation.runNow"), () => botChange(window.cockpit.botRunNow(bot.id), t("automation.started", { name: bot.name }))),
    button(t("automation.openSession"), () => given.goToBot(bot)),
    moreMenu(bot, openForm),
  );
  const name = make("h2", "");
  name.append(lamp, bot.name);
  head.append(back, make("span", "autoDim", "/"), name, right,
    make("span", "autoMuted autoBotWhere", t("automation.where", { pc: pcLabel(bot.nodeId), folder, agent: agents[bot.executor]?.label ?? bot.executor })));

  const grid = make("div", "autoBotGrid");
  const profile = make("section", "autoSection");
  const profileHead = make("div", "autoHead");
  const path = botProfilePath(bot.folder, bot.name);
  const openFile = linkButton(t("automation.openFile"), () => given.openFile(bot.nodeId, bot.repoId, path));
  openFile.title = path;
  profileHead.append(make("span", "autoTitle", t("automation.profile")), openFile);
  // The memory part lives only in the file on that PC: "파일로 열기" shows it, the card does not read it.
  const card = make("div", "autoProfile");
  card.append(make("p", "", bot.role || t("automation.noRole")), make("p", "autoRule", t("automation.rule")));
  profile.append(profileHead, card, make("p", "autoMuted", t("automation.memoryNote")));

  const side = make("div", "autoSide");
  const work = make("section", "autoSection");
  const workHead = make("div", "autoHead");
  workHead.append(make("span", "autoTitle", t("automation.work")));
  const addLink = linkButton(`+ ${t("automation.form.addJob")}`, () => openForm(true, "botAddJob"));
  addLink.dataset.focus = "botAddJob";
  workHead.append(addLink);
  work.append(workHead);
  if (bot.jobs.length === 0) work.append(make("p", "autoMuted", t("automation.noWork")));
  bot.jobs.forEach((job, at) => {
    const row = make("div", "autoWork");
    const edit = iconButton("edit", t("automation.editBot"), () => openForm(false, `botEdit:${at}`));
    edit.dataset.focus = `botEdit:${at}`;
    row.append(make("span", "autoMuted", describeWhen(job.when)), make("span", "", job.instructions), edit);
    work.append(row);
  });
  const pc = data.jobs.find((each) => each.nodeId === bot.nodeId);
  const linked = groupRows([bot], pc?.jobs ?? [])[0]!.jobs;
  if (linked.length > 0) work.append(make("p", "autoMuted", t("automation.linked", { pc: pcLabel(bot.nodeId), names: linked.map((job) => shownName(bot.nodeId, job)).join(", ") })));
  const runs = make("section", "autoSection");
  runs.append(make("span", "autoTitle", t("automation.runs")), ...missedNote(bot));
  if (!bot.runs?.length) runs.append(make("p", "autoMuted", t("automation.noRuns")));
  for (const run of bot.runs ?? []) {
    const row = make("div", "autoRun");
    const when = make("span", "autoMuted");
    when.append(make("span", `lamp${run.state === "done" ? " live" : run.state === "skipped" || run.state === "missed" ? " wait" : " fail"}`), whenText(run.startedAt));
    row.append(when, make("span", "", runText(run)));
    runs.append(row);
  }
  side.append(work, runs);
  grid.append(profile, side);
  return [head, ...(schedSaid && !dialogKey() ? [make("p", "autoSaid", schedSaid)] : []), grid];
}

/**
 * The bot page's ⋯ and the menu it drops: 고치기, 멈추기 or 다시 켜기, then 삭제 apart (two presses).
 * Drawn from `botMenu`, so a redraw keeps it open, and each item's data-focus keeps the keyboard on it.
 * Enter or Space opens it, ↑/↓ moves, Esc (automationEscape) or a click elsewhere closes it.
 */
function moreMenu(bot: BotRow, openForm: (add: boolean, from: string) => void): HTMLElement {
  const wrap = make("span", "autoMore");
  const more = make("button", "autoBtn", "⋯");
  more.type = "button";
  more.dataset.focus = "botMore";
  more.title = t("automation.moreActions");
  more.setAttribute("aria-label", t("automation.moreActions"));
  more.setAttribute("aria-haspopup", "menu");
  more.setAttribute("aria-expanded", String(botMenu));
  const open = (at: number) => {
    botMenu = true;
    render();
    host?.querySelector<HTMLElement>(`[data-focus="botMenu:${at}"]`)?.focus();
  };
  more.addEventListener("click", () => {
    if (!botMenu) return open(0);
    botMenu = false;
    render();
  });
  more.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    open(event.key === "ArrowDown" ? 0 : 2);
  });
  wrap.append(more);
  if (!botMenu) return wrap;
  const menu = make("div", "setMenu");
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", t("automation.moreActions"));
  // An item that does its work closes the menu and leaves the keyboard on ⋯.
  const done = (run: () => void) => () => {
    botMenu = false;
    render();
    host?.querySelector<HTMLElement>('[data-focus="botMore"]')?.focus();
    run();
  };
  const item = (text: string, click: () => void, danger = false) => {
    const element = make("button", danger ? "danger" : "", text);
    element.type = "button";
    element.tabIndex = -1;
    element.setAttribute("role", "menuitem");
    element.dataset.focus = `botMenu:${menu.childElementCount}`;
    element.addEventListener("click", click);
    menu.append(element);
    return element;
  };
  item(t("automation.editBot"), done(() => openForm(false, "botMore")));
  item(t(bot.paused ? "osjob.action.resume" : "osjob.action.pause"), done(() => botChange(window.cockpit.botPause(bot.id, !bot.paused))));
  const remove = item(t("schedules.remove"), () => {
    if (remove.dataset.armed !== "1") {
      remove.dataset.armed = "1";
      remove.textContent = t("automation.removeSure");
      return;
    }
    done(() => botChange(window.cockpit.botRemove(bot.id), "", () => { botOpen = undefined; }))();
  }, true);
  menu.addEventListener("keydown", (event) => {
    const items = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    const to = menuMove(event.key, items.indexOf(document.activeElement as HTMLElement), items.length);
    if (to === undefined) return;
    event.preventDefault();
    items[to]!.focus();
  });
  // Tabbing out closes it, as a click elsewhere does (initAutomation); a redraw taking the old menu away does not.
  wrap.addEventListener("focusout", (event) => {
    const to = event.relatedTarget as Node | null;
    if (botMenu && to && !wrap.contains(to) && wrap.isConnected) dropMenu();
  });
  wrap.append(menu);
  return wrap;
}

/** Closes the ⋯ menu by taking it out, not redrawing: the press or Tab that closed it still lands where it was going. */
function dropMenu(): void {
  botMenu = false;
  host?.querySelector(".autoMore .setMenu")?.remove();
  host?.querySelector('[data-focus="botMore"]')?.setAttribute("aria-expanded", "false");
}

/**
 * OS jobs a bot on `nodeId` may be linked to: that PC's own jobs (not Lepons'),
 * less those another bot already claims. Absent while that PC is unread.
 */
export function linkable(bots: BotRow[], jobs: OsJob[] | undefined, botId?: string): OsJob[] | undefined {
  if (!jobs) return undefined;
  const others = new Set(bots.filter((bot) => bot.id !== botId).flatMap((bot) => bot.linked ?? []));
  return jobs.filter((job) => job.source !== "lepons" && !others.has(job.id));
}

/** A new bot (no `bot`) or a change to one: its role, AI, fresh start, the jobs it does when, and the PC's jobs grouped under it. Saving asks in main's approval dialog. */
function botFormBox(bot?: BotRow, addJobNow = false): HTMLElement {
  const box = make("div", "autoSet");
  const form = make("div", "setSchedForm");
  const caption = (text: string) => make("p", "setNote", text);
  const pcs = (actions?.pcs() ?? []).filter((pc) => pc.folders.length > 0);
  let nodeId = bot?.nodeId ?? pcs[0]?.nodeId;
  const folder = make("select");
  folder.setAttribute("aria-label", t("schedules.folder"));
  const chips = make("div", "setChips");

  // Existing jobs of that PC to group under this bot; filled again on every redraw, as that PC's list may arrive later.
  const ticked = new Set(bot?.linked ?? []);
  const links = make("div", "autoLinks");
  const linkedTitle = make("summary", "setNote");
  const countLinked = () => { linkedTitle.textContent = t("automation.form.linkedCount", { n: ticked.size }); };
  countLinked();
  let linksShown = false;
  const fillLinks = () => {
    const read = nodeId ? pcJobs.get(nodeId) : undefined;
    const jobs = linkable(bots, read?.readAt !== undefined ? read.jobs : undefined, bot?.id);
    linksShown = jobs !== undefined;
    if (!jobs) {
      links.replaceChildren(caption(t(read?.state === "loading" ? "schedules.loading" : "automation.form.linkUnread")));
      return;
    }
    if (jobs.length === 0) {
      links.replaceChildren(caption(t("automation.noJobs")));
      return;
    }
    // A grid of checkbox, name (as the jobs list words it), where it comes from, and when: one row per job.
    const folders = actions?.pcs().find((pc) => pc.nodeId === nodeId)?.folders ?? [];
    links.replaceChildren(...jobs.map((job) => {
      const row = make("label", "autoLinkRow");
      const tick = make("input");
      tick.type = "checkbox";
      tick.checked = ticked.has(job.id);
      tick.addEventListener("change", () => {
        if (tick.checked) ticked.add(job.id);
        else ticked.delete(job.id);
        countLinked();
      });
      const origin = jobOrigin(job, folders);
      const text = make("span", "autoJobText");
      text.append(jobName(nodeId!, job));
      const sub = jobSub(nodeId!, job, origin);
      if (sub) text.append(sub);
      row.append(tick, text, originChip(origin), make("span", "autoWhen", job.resident ? t("automation.resident") : job.schedule ? scheduleText(job.schedule) : ""));
      return row;
    }));
  };
  refillLinks = fillLinks;

  const pick = (id: string) => {
    nodeId = id;
    for (const chip of chips.querySelectorAll("button")) chip.setAttribute("aria-pressed", String(chip.value === id));
    folder.replaceChildren(...(pcs.find((pc) => pc.nodeId === id)?.folders ?? []).map((each) => new Option(each.label, each.id)));
    ticked.clear();
    countLinked();
    loadJobs(id);
    fillLinks();
  };
  chips.append(...pcs.map((pc) => {
    const chip = make("button", "", pc.label);
    chip.type = "button";
    chip.value = pc.nodeId;
    chip.addEventListener("click", () => pick(pc.nodeId));
    return chip;
  }));
  if (!bot && nodeId) pick(nodeId);
  if (bot) {
    loadJobs(bot.nodeId);
    fillLinks();
  }
  const name = make("input");
  name.type = "text";
  name.maxLength = 60;
  name.placeholder = t("automation.form.name");
  name.setAttribute("aria-label", t("automation.form.name"));
  const role = make("textarea");
  role.rows = 3;
  role.maxLength = MAX_SCHEDULE_TEXT;
  role.value = bot?.role ?? "";
  role.placeholder = t("automation.form.role");
  role.setAttribute("aria-label", t("automation.form.role"));
  const agent = make("select");
  agent.setAttribute("aria-label", t("schedules.agent"));
  for (const [value, text] of [["", t("schedules.agentDefault")], ...delegateAgents.map((kind): [string, string] => [kind, agents[kind].label])]) {
    agent.append(new Option(text, value, false, value === (bot?.executor ?? "")));
  }
  const fresh = make("label");
  const freshBox = make("input");
  freshBox.type = "checkbox";
  freshBox.checked = bot?.fresh ?? true;
  fresh.append(freshBox, " ", t("automation.form.fresh"));
  fresh.className = "autoCheck";

  // The jobs, in the order they run when due in the same minute: a ≡ handle drags a row (or Alt+↑/↓ with it
  // focused), and a click on it shows + (a new job below) and − (this one away; the last one is emptied instead).
  const jobs = make("div", "autoFormJobs");
  const entries = new Map<HTMLElement, { value(): { id?: string; when: string; instructions: string } }>();
  let dragged: HTMLElement | undefined;
  const addJob = (cron?: string, text = "", after?: HTMLElement, id?: string): HTMLTextAreaElement => {
    const entry = make("div", "autoFormJob");
    const picker = whenPicker(t, cron);
    const instructions = make("textarea");
    instructions.rows = 3;
    instructions.maxLength = MAX_SCHEDULE_TEXT;
    instructions.value = text;
    instructions.placeholder = t("schedules.instructions");
    instructions.setAttribute("aria-label", t("schedules.instructions"));
    // A kept job goes back with its id: an edit then keeps what is queued or due for it.
    entries.set(entry, { value: () => ({ ...(id ? { id } : {}), when: picker.value(), instructions: instructions.value }) });
    const handle = make("button", "autoHandle", "≡");
    handle.type = "button";
    handle.title = t("automation.form.handle");
    handle.setAttribute("aria-label", t("automation.form.handle"));
    const tools = make("span", "autoHandleTools");
    const plus = make("button", "autoIb", "+");
    plus.type = "button";
    plus.setAttribute("aria-label", t("automation.form.insertJob"));
    plus.title = t("automation.form.insertJob");
    plus.addEventListener("click", () => addJob(undefined, "", entry).focus());
    const minus = make("button", "autoIb", "−");
    minus.type = "button";
    minus.setAttribute("aria-label", t("automation.form.removeJob"));
    minus.title = t("automation.form.removeJob");
    minus.addEventListener("click", () => {
      const fresh = jobs.children.length === 1 ? addJob(undefined, "", entry) : undefined;
      const goTo = (entry.nextElementSibling ?? entry.previousElementSibling)?.querySelector<HTMLElement>(".autoHandle");
      entries.delete(entry);
      entry.remove();
      (fresh ?? goTo)?.focus();
    });
    tools.append(plus, minus);
    handle.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      event.preventDefault();
      if (event.key === "ArrowUp" && entry.previousElementSibling) jobs.insertBefore(entry, entry.previousElementSibling);
      else if (event.key === "ArrowDown" && entry.nextElementSibling) jobs.insertBefore(entry.nextElementSibling, entry);
      handle.focus();
    });
    // Only the handle starts a drag, so text in the fields can still be selected.
    handle.addEventListener("pointerdown", () => { entry.draggable = true; });
    // A press on the handle that did not become a drag: the row is not draggable again until the next one.
    for (const type of ["pointerup", "pointercancel"]) handle.addEventListener(type, () => { if (!dragged) entry.draggable = false; });
    entry.addEventListener("dragstart", (event) => {
      // Text dragged out of a field inside the row is not a row move.
      if (event.target !== entry) return;
      dragged = entry;
      event.dataTransfer?.setData("text/plain", "");
      entry.classList.add("dragging");
    });
    entry.addEventListener("dragend", () => {
      entry.draggable = false;
      entry.classList.remove("dragging");
      dragged = undefined;
    });
    entry.addEventListener("dragover", (event) => {
      if (!dragged || dragged === entry) return;
      event.preventDefault();
      const box = entry.getBoundingClientRect();
      jobs.insertBefore(dragged, event.clientY < box.top + box.height / 2 ? entry : entry.nextElementSibling);
    });
    const side = make("div", "autoHandleSide");
    side.append(handle, tools);
    const fields = make("div", "autoFormJobFields");
    fields.append(picker.row, instructions);
    entry.append(side, fields);
    jobs.insertBefore(entry, after ? after.nextElementSibling : null);
    return instructions;
  };
  for (const job of bot?.jobs ?? []) addJob(job.cron, job.instructions, undefined, job.id);
  // No jobs yet: one empty row, so its handle is there to start from.
  if (jobs.children.length === 0 || addJobNow) {
    const fresh = addJob();
    if (bot) queueMicrotask(() => fresh.focus());
  }

  const problem = make("p", "setNote bad formProblem");
  problem.hidden = true;
  const save = buttons([bot ? t("schedules.save") : t("automation.form.create"), () => {
    if (saving.disabled) return;
    if (!nodeId || (!bot && !folder.value)) {
      problem.textContent = t("automation.form.noFolder");
      problem.hidden = false;
      return;
    }
    problem.hidden = true;
    const sent: BotForm = {
      ...(bot ? { id: bot.id } : {}),
      nodeId, repoId: bot?.repoId ?? folder.value, name: bot?.name ?? name.value, role: role.value, fresh: freshBox.checked,
      ...(agent.value ? { executor: agent.value } : {}),
      // In the rows' order on screen, which is the order they run in; an empty row is left out.
      jobs: [...jobs.children].map((each) => entries.get(each as HTMLElement)!.value()).filter((each) => each.instructions.trim() !== ""),
      // Unread, the PC's list could not be shown, so what was linked stays as it was.
      ...(linksShown ? { linked: [...ticked] } : {}),
    };
    // Off until the answer comes: a second press would save it twice.
    saving.disabled = true;
    botChange(window.cockpit.botSave(sent).finally(() => { saving.disabled = false; }), "", () => { botForm = undefined; });
  }], [t("schedules.cancel"), () => {
    botForm = undefined;
    schedSaid = "";
    render();
  }]);
  save.classList.add("formActions");
  const saving = save.querySelector("button")!;
  saving.classList.add("go");

  if (!bot && pcs.length === 0) {
    form.append(caption(t("schedules.noFolders")));
  } else {
    // Each part its own block, a line between: where and with what, the role, the jobs, linked jobs, options.
    const group = (...parts: HTMLElement[]) => {
      const block = make("div", "autoFormGroup");
      block.append(...parts);
      return block;
    };
    // Folded at first: its title says how many are linked.
    const linkedFold = make("details", "autoFormFold");
    linkedFold.append(linkedTitle, caption(t("automation.form.linked")), links);
    form.append(
      group(...(bot ? [] : [caption(t("schedules.where")), chips, folder, name]), agent),
      group(caption(t("automation.form.role")), role),
      group(caption(t("automation.form.jobs")), jobs),
      group(linkedFold),
      group(fresh),
      group(caption(t("automation.form.warn")), problem, save),
    );
  }
  box.append(form);
  return box;
}

// --- Lepons' own schedules (moved from settings' 예약 작업 tab) ---------------

/**
 * 예약 작업: the schedules made from here (agent/schedule.ts), each read back
 * from its own PC, so this list is only as current as its last load. Loaded on
 * opening the view and after each change, not on every redraw: a read reaches
 * every PC that has one.
 */
let schedList: ScheduleList | undefined;
let schedLoading = false;
let schedAt = -Infinity;
/** The rows opened to show their output and buttons; kept across redraws. */
const openScheds = new Set<string>();
/** The schedule whose form is open: an id, "new", or none. */
let schedForm: string | undefined;
/** What the last change said, under the list. */
let schedSaid = "";
/** A new schedule just saved: its PC, the ids there were before, and when; the list shows its page once read again. */
let made: { nodeId: string; before: Set<string>; at: number } | undefined;

/** `onlyIfStale`: on opening the view, skipped when read within FRESH_MS (the list reaches every PC that has a schedule). */
function loadSchedules(onlyIfStale = false): void {
  if (onlyIfStale && (schedLoading || Date.now() - schedAt < FRESH_MS)) return;
  schedAt = Date.now();
  schedLoading = true;
  void window.cockpit.scheduleList().then((got) => {
    schedList = got;
  }, () => {
    schedList = { schedules: [], places: [] };
  }).finally(() => {
    schedLoading = false;
    render();
  });
}

/** A change's answer in words; main's own words only when it is none of the usual. */
function scheduleError(t: typeof translate, error: string): string {
  if (error.startsWith("refused")) return t("schedules.refused");
  if (error.startsWith("approval_needed")) return t("schedules.unanswered");
  if (/^(unsupported_schedule|too_often)/.test(error)) return t("schedules.badWhen");
  if (error.startsWith("no_instructions")) return t("schedules.noInstructions");
  if (error.startsWith("too_long")) return t("schedules.tooLong", { max: MAX_SCHEDULE_TEXT });
  if (error.startsWith("task_scheduler_denied")) return t("schedules.denied");
  if (error.startsWith("no_name")) return t("automation.form.noName");
  if (error.startsWith("same_name")) return t("automation.form.sameName");
  if (error.startsWith("no_tmux")) return t("automation.form.noTmux");
  return t("schedules.failed", { detail: error });
}

/** Runs one change, then reads the list again; a failure stays on screen. */
function scheduleChange(t: typeof translate, change: Promise<ScheduleDone>, done?: () => void): void {
  schedSaid = t("schedules.working");
  render();
  void change.then((result) => {
    schedSaid = result.ok ? "" : scheduleError(t, result.error);
    if (result.ok) done?.();
  }, (error: unknown) => {
    schedSaid = scheduleError(t, String(error));
  }).finally(() => loadSchedules());
}

const dayName = (day: number) => formatDate(new Date(2026, 10, 1 + day), { weekday: "long" });

function select(label: string, options: Array<[value: string, text: string]>, value: string): HTMLSelectElement {
  const element = document.createElement("select");
  element.setAttribute("aria-label", label);
  for (const [optionValue, text] of options) element.append(new Option(text, optionValue, false, optionValue === value));
  return element;
}

/** When: a choice, its time, and cron typed in for what the choices do not cover. `value()` is what parseWhen takes. */
export function whenPicker(t: typeof translate, cronText?: string): { row: HTMLElement; value(): string } {
  const parsed = cronText ? parseWhen(cronText) : undefined;
  const when = parsed?.ok ? parsed.when : { minute: 0, hour: 9, days: [1, 2, 3, 4, 5] };
  const kind = select(t("schedules.when"), [
    ["hourly", t("schedules.kind.hourly")], ["daily", t("schedules.kind.daily")], ["weekdays", t("schedules.kind.weekdays")],
    ...[1, 2, 3, 4, 5, 6, 0].map((day): [string, string] => [`w${day}`, t("schedules.kind.weekly", { day: dayName(day) })]),
    ["cron", t("schedules.kind.cron")],
  ], parsed && !parsed.ok ? "cron" : presetOf(when));
  const time = document.createElement("input");
  time.type = "time";
  time.value = `${String(when.hour ?? 0).padStart(2, "0")}:${String(when.minute).padStart(2, "0")}`;
  time.setAttribute("aria-label", t("schedules.time"));
  const cron = document.createElement("input");
  cron.type = "text";
  cron.value = cronText ?? "0 9 * * 1-5";
  cron.placeholder = t("schedules.cronHint");
  cron.setAttribute("aria-label", t("schedules.kind.cron"));
  const sync = () => {
    cron.hidden = kind.value !== "cron";
    time.hidden = kind.value === "cron";
  };
  kind.addEventListener("change", sync);
  sync();
  const whenRow = document.createElement("div");
  whenRow.className = "setSchedWhen";
  whenRow.append(kind, time, cron);
  return { row: whenRow, value: () => presetCron(kind.value, time.value, cron.value.trim()) };
}

/** The form for a new schedule (no row) or for changing one's timetable, instructions and precheck. */
function scheduleFormBox(deps: Deps, list: ScheduleList, row?: ScheduleRow): HTMLElement {
  const { t } = deps;
  const box = document.createElement("div");
  box.className = "setSchedForm";
  const caption = (text: string) => {
    const p = document.createElement("p");
    p.className = "setNote";
    p.textContent = text;
    return p;
  };

  // Where it goes: a new one only. A PC as a chip, as the AI accounts tab picks one; then its folder.
  const places = list.places.filter((place) => place.folders.length > 0);
  let nodeId = places[0]?.nodeId;
  const folder = document.createElement("select");
  folder.setAttribute("aria-label", t("schedules.folder"));
  const chips = document.createElement("div");
  chips.className = "setChips";
  const pick = (id: string) => {
    nodeId = id;
    for (const chip of chips.querySelectorAll("button")) chip.setAttribute("aria-pressed", String(chip.value === id));
    folder.replaceChildren(...(places.find((place) => place.nodeId === id)?.folders ?? []).map((each) => new Option(each.label, each.id)));
  };
  chips.append(...places.map((place) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.value = place.nodeId;
    chip.textContent = place.machine;
    chip.addEventListener("click", () => pick(place.nodeId));
    return chip;
  }));
  if (nodeId) pick(nodeId);
  const agent = select(t("schedules.agent"), [["", t("schedules.agentDefault")], ...delegateAgents.map((kind): [string, string] => [kind, agents[kind].label])], "");
  const name = document.createElement("input");
  name.type = "text";
  name.maxLength = 60;
  name.placeholder = t("schedules.name");
  name.setAttribute("aria-label", t("schedules.name"));

  const when = whenPicker(t, row?.cron);

  const instructions = document.createElement("textarea");
  instructions.rows = 4;
  instructions.maxLength = MAX_SCHEDULE_TEXT;
  instructions.value = row?.instructions ?? "";
  instructions.placeholder = t("schedules.instructions");
  instructions.setAttribute("aria-label", t("schedules.instructions"));
  const precheck = document.createElement("input");
  precheck.type = "text";
  precheck.spellcheck = false;
  precheck.maxLength = MAX_SCHEDULE_TEXT;
  precheck.value = row?.precheck ?? "";
  precheck.placeholder = t("schedules.precheck");
  precheck.setAttribute("aria-label", t("schedules.precheck"));

  const save = buttons([row ? t("schedules.save") : t("schedules.create"), () => {
    if (saving.disabled || (!row && (!nodeId || !folder.value))) return;
    const form: ScheduleForm = {
      when: when.value(),
      instructions: instructions.value,
      precheck: precheck.value,
      ...(row ? { id: row.id } : { nodeId: nodeId!, repoId: folder.value, name: name.value, ...(agent.value ? { executor: agent.value } : {}) }),
    };
    // Off until the answer comes: a second press would save it twice.
    saving.disabled = true;
    const at = Date.now();
    scheduleChange(t, window.cockpit.scheduleSave(form).finally(() => { saving.disabled = false; }), () => {
      if (!row && nodeId) {
        made = { nodeId, before: new Set(schedList?.schedules.map((each) => each.id)), at };
        if (pcPicked !== nodeId) jobsPage = 0;
        pcPicked = nodeId;
        // It is a Lepons row: a filter that hides those goes back to all.
        if (filterOf(nodeId) !== "all" && filterOf(nodeId) !== "mine") {
          filters = { ...filters, [nodeId]: "all" };
          try { localStorage.setItem("automationFilter", JSON.stringify(filters)); } catch { /* this start only */ }
        }
        loadJobs(nodeId);
      }
      schedForm = undefined;
      // Closes the new one's dialog now, not when the list has been read again.
      render();
    });
  }], [t("schedules.cancel"), () => {
    schedForm = undefined;
    schedSaid = "";
    render();
  }]);
  save.classList.add("formActions");
  const saving = save.querySelector("button")!;
  saving.classList.add("go");

  if (row) {
    box.append(caption(t("schedules.when")), when.row, caption(t("schedules.instructions")), instructions, caption(t("schedules.precheckWhy")), precheck, save);
    return box;
  }
  if (places.length === 0) {
    box.append(caption(t("schedules.noFolders")));
    return box;
  }
  box.append(caption(t("schedules.where")), chips, folder, agent, name, caption(t("schedules.when")), when.row,
    caption(t("schedules.instructions")), instructions, caption(t("schedules.precheckWhy")), precheck, save);
  return box;
}

/** One schedule: name, PC and folder, when and its AI, how it last went; a click opens its output and buttons. */
function scheduleRow(deps: Deps, list: ScheduleList, row: ScheduleRow): HTMLElement {
  const { t } = deps;
  const box = document.createElement("div");
  box.className = "setAccount setSched";
  const open = openScheds.has(row.id);
  const main = document.createElement("button");
  main.type = "button";
  main.className = "setRemoteMain";
  main.dataset.focus = `sched:${row.id}`;
  main.setAttribute("aria-expanded", String(open));
  const name = document.createElement("strong");
  name.textContent = row.name ?? row.id;
  const where = document.createElement("span");
  where.className = "setMuted";
  where.textContent = row.folder ? `${row.machine} · ${row.folder}` : row.machine;
  main.append(name, where, make("span", "autoSrc", t("automation.src.lepons")));
  main.addEventListener("click", () => {
    if (open) openScheds.delete(row.id);
    else openScheds.add(row.id);
    render();
  });
  box.append(main);

  if (row.state !== "ok") {
    const why = document.createElement("p");
    why.className = "setNote bad";
    why.textContent = t(row.state === "missing" ? "schedules.missing" : "schedules.unreachable", { machine: row.machine });
    box.append(why);
    // One its PC no longer has can only be let go of; one that did not answer may answer next time.
    if (row.state === "missing") box.append(removeLink(t, row.id));
    return box;
  }

  const badge = document.createElement("span");
  const last = row.last;
  const noSession = last?.reason === NO_SESSION;
  badge.className = `setBadge ${row.paused ? "" : !last ? "" : noSession ? "bad" : last.skipped ? "" : last.exitCode === 0 ? "good" : "bad"}`;
  badge.textContent = row.paused ? t("schedules.paused")
    : !last ? t("schedules.never")
    : noSession ? t("schedules.notRun")
    : last.skipped ? t("schedules.skipped")
    : last.exitCode === 0 ? t("schedules.ok") : t("schedules.failedCode", { code: last.exitCode });
  box.append(badge);
  box.append(Object.assign(document.createElement("p"), {
    className: "setNote",
    textContent: [row.when, row.agent, last ? t("schedules.lastRun", { time: formatDate(Date.parse(last.startedAt), { dateStyle: "medium", timeStyle: "short" }) }) : ""]
      .filter((part) => part).join(" · "),
  }));
  if (noSession && !row.paused) box.append(Object.assign(document.createElement("p"), { className: "setNote bad", textContent: t("schedule.pushNoSession") }));
  if (row.signedInOnly) box.append(Object.assign(document.createElement("p"), { className: "setNote", textContent: t("schedules.signedInOnly") }));
  if (!open) return box;

  if (schedForm === row.id) {
    box.append(keep(`sched:${row.id}`, () => scheduleFormBox(deps, list, row)));
    return box;
  }
  const details = document.createElement("div");
  details.className = "setSchedDetails";
  const output = document.createElement("pre");
  output.className = "setLog";
  output.textContent = row.tail?.trim() || t("schedules.noOutput");
  // Older runs: their names come from the PC when asked, then one of them in place of the latest output.
  const runs = document.createElement("select");
  runs.setAttribute("aria-label", t("schedules.runs"));
  runs.append(new Option(t("schedules.latest"), ""));
  void window.cockpit.scheduleLogs(row.id).then((names) => {
    runs.append(...names.map((each) => new Option(formatDate(Date.parse(each.replace(/^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z\.log$/, "$1-$2-$3T$4:$5:$6Z")), { dateStyle: "medium", timeStyle: "medium" }), each)));
  });
  runs.addEventListener("change", () => {
    if (!runs.value) {
      output.textContent = row.tail?.trim() || t("schedules.noOutput");
      return;
    }
    output.textContent = t("schedules.loading");
    void window.cockpit.scheduleLog(row.id, runs.value).then((text) => {
      output.textContent = text === undefined ? t("schedules.logUnread") : text.trim() || t("schedules.noOutput");
    });
  });
  const actions = buttons(
    [t("schedules.edit"), () => {
      schedForm = row.id;
      render();
    }],
    [row.paused ? t("schedules.resume") : t("schedules.pause"), () => scheduleChange(t, window.cockpit.schedulePause(row.id, !row.paused))],
  );
  actions.append(removeLink(t, row.id));
  details.append(runs, output, actions);
  box.append(details);
  return box;
}

/** 삭제, asked within the row: a second click is the confirmation. */
function removeLink(t: typeof translate, id: string): HTMLElement {
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "setLink";
  remove.dataset.focus = `schedRemove:${id}`;
  remove.textContent = t("schedules.remove");
  let armed = false;
  remove.addEventListener("click", () => {
    if (!armed) {
      armed = true;
      remove.textContent = t("schedules.removeSure");
      return;
    }
    openScheds.delete(id);
    scheduleChange(t, window.cockpit.scheduleRemove(id));
  });
  return remove;
}

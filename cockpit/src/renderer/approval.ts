import { t } from "../i18n/i18n.ts";
import { agents, delegateAgents, type AgentKind } from "../agent/agents.ts";
import { MAX_SCHEDULE_TEXT, parseWhen } from "../agent/schedule.ts";
import { MAX_BOT_NAME } from "../agent/bots.ts";
import { nextRunOf } from "../main/bot-scheduler.ts";
import { APPROVAL_WAIT_MS } from "../main/delegate-approval.ts";
import { changesOf, type ApprovalAsk, type ApprovalReply, type Change } from "../shared/approval.ts";
import { buttons, whenPicker, whenText } from "./automation.ts";
import { dialogShell } from "./dialog-shell.ts";

/** Main sends one request at a time; one still open here was already answered there (its wait ran out). */
let current: HTMLDialogElement | undefined;

const make = <K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text?: string): HTMLElementTagNameMap[K] => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
};

type Allowed = Extract<ApprovalReply, { answer: "allowed" }>;
type Field = (key: Change["field"] | undefined, label: string, ...controls: HTMLElement[]) => HTMLElement;
/** A request's own fields: what allowing sends, whether it can be allowed, and whether it is a bot. */
interface Form { parts: HTMLElement[]; first: HTMLElement; reply(): Allowed; ok(): boolean; bot(): boolean; refresh(): void }

/**
 * An AI's schedule request, to allow as it is, as edited, or as a bot; or its
 * bot request, to allow as it is, as edited, or (a new one with jobs) as
 * schedules, one a job. Each edited field says so and
 * what it was. Esc, the backdrop and 거절 refuse; main checks whatever is
 * allowed again before saving it.
 */
export function showApproval(ask: ApprovalAsk): void {
  current?.close();
  const { dialog, head, body, foot } = dialogShell();
  current = dialog;
  head.textContent = ask.kind === "bot" ? t(ask.editing ? "approval.botEditTitle" : "approval.botTitle", { source: ask.source })
    : t("approval.scheduleTitle", { source: ask.source });
  dialog.setAttribute("aria-label", head.textContent);

  // One field: its label with a 바뀜 badge, the control, and what it was, shown while it differs.
  const marks = new Map<Change["field"], { badge: HTMLElement; was: HTMLElement }>();
  const field: Field = (key, label, ...controls) => {
    const box = make("div", "approvalField");
    const caption = make("p", "setNote", label);
    box.append(caption, ...controls);
    if (key) {
      const badge = make("span", "setBadge", t("approval.changed"));
      const was = make("p", "setNote");
      caption.append(" ", badge);
      box.append(was);
      marks.set(key, { badge, was });
    }
    return box;
  };

  // Editing holds main's wait open, told at most every 10 seconds; this dialog closes when that wait, or main's ceiling, runs out.
  let toldAt = 0;
  let expiry: ReturnType<typeof setTimeout> | undefined;
  const expire = () => {
    clearTimeout(expiry);
    // Main has answered it unanswered by now: nothing to send.
    expiry = setTimeout(() => {
      answered = true;
      dialog.close();
    }, Math.min(APPROVAL_WAIT_MS, ask.until - Date.now()));
  };
  const edited = () => {
    if (Date.now() - toldAt >= 10_000) {
      toldAt = Date.now();
      window.cockpit.approvalEditing(ask.requestId);
      expire();
    }
    update();
  };

  const request = ask.kind === "bot" ? botForm(ask, field, edited) : scheduleForm(ask, field, edited);
  const form = make("div", "setSchedForm");
  form.append(...request.parts);
  body.replaceChildren(form);

  let answered = false;
  const actions = buttons([t("approval.allow"), () => {
    if (allow.disabled) return;
    answered = true;
    window.cockpit.replyApproval(ask.requestId, request.reply());
    dialog.close();
  }], [t("approval.refuse"), () => dialog.close()]);
  const allow = actions.querySelector("button")!;
  allow.classList.add("go");
  // What allowing it means, worded for the mode (a bot runs in its Lepons session, a schedule on that PC on its own), just above the footer.
  const warning = make("p", "setNote");
  form.append(warning);
  foot.replaceChildren(actions);

  function update(): void {
    request.refresh();
    warning.textContent = t(request.bot() ? "approval.warningBot" : "approval.warning");
    const changes = changesOf(ask, request.reply());
    for (const [key, { badge, was }] of marks) {
      const change = changes.find((each) => each.field === key);
      badge.hidden = !change;
      was.textContent = change ? t("approval.was", { value: change.from }) : "";
      was.hidden = !change;
    }
    allow.textContent = t(changes.length > 0 ? "approval.allowEdited" : "approval.allow");
    allow.disabled = !request.ok();
  }

  dialog.addEventListener("input", edited);
  dialog.addEventListener("change", update);
  dialog.addEventListener("close", () => {
    clearTimeout(expiry);
    if (!answered) window.cockpit.replyApproval(ask.requestId, { answer: "refused" });
    if (current === dialog) current = undefined;
    dialog.remove();
  });

  update();
  expire();
  dialog.showModal();
  request.first.focus();
}

/** A schedule request: its name, time and task, and a switch to make it a bot instead (with a role). */
function scheduleForm(ask: Extract<ApprovalAsk, { kind: "schedule" }>, field: Field, edited: () => void): Form {
  let asBot = false;
  const chips = make("div", "setChips");
  const chip = (label: string, bot: boolean) => {
    const button = make("button", "", label);
    button.type = "button";
    button.addEventListener("click", () => {
      asBot = bot;
      edited();
    });
    return button;
  };
  const scheduleChip = chip(t("approval.asSchedule"), false);
  const botChip = chip(t("approval.asBot"), true);
  chips.append(scheduleChip, ...(ask.canBot ? [botChip] : []));

  const name = make("input");
  name.type = "text";
  name.value = ask.name;
  name.setAttribute("aria-label", t("approval.field.name"));
  const picker = whenPicker(t, ask.when);
  const next = make("p", "setNote");
  const instructions = make("textarea");
  instructions.rows = 4;
  instructions.maxLength = MAX_SCHEDULE_TEXT;
  instructions.value = ask.instructions;
  instructions.setAttribute("aria-label", t("schedules.instructions"));
  const role = make("textarea");
  role.rows = 3;
  role.maxLength = MAX_SCHEDULE_TEXT;
  role.placeholder = t("approval.roleNeeded");
  role.setAttribute("aria-label", t("approval.role"));
  const roleBox = field("role", t("approval.role"), role);

  const parts: HTMLElement[] = [
    make("p", "setNote", `${ask.machine} · ${ask.folder} · ${ask.agent}`), chips,
    field("name", t("approval.field.name"), name),
    field("when", t("schedules.when"), picker.row, next),
    field("instructions", t("schedules.instructions"), instructions),
  ];
  if (ask.precheck !== undefined) {
    const precheck = make("textarea");
    precheck.rows = 2;
    precheck.readOnly = true;
    precheck.value = ask.precheck;
    precheck.setAttribute("aria-label", t("schedules.precheck"));
    parts.push(field(undefined, t("schedules.precheckWhy"), precheck));
  }
  parts.push(roleBox);

  return {
    parts, first: name, bot: () => asBot,
    reply: () => asBot
      ? { answer: "allowed", as: "bot", name: name.value, executor: ask.executor, role: role.value, jobs: [{ when: picker.value(), instructions: instructions.value }] }
      : { answer: "allowed", as: "schedule", name: name.value, when: picker.value(), instructions: instructions.value },
    ok: () => parseWhen(picker.value()).ok && instructions.value.trim() !== "" &&
      (!asBot || (role.value.trim() !== "" && name.value.trim() !== "" && name.value.length <= MAX_BOT_NAME)),
    refresh() {
      scheduleChip.setAttribute("aria-pressed", String(!asBot));
      botChip.setAttribute("aria-pressed", String(asBot));
      roleBox.hidden = !asBot;
      // A bot's name heads a tab and a card (saveBot holds it to this too).
      if (asBot) name.maxLength = MAX_BOT_NAME;
      else name.removeAttribute("maxlength");
      const parsed = parseWhen(picker.value());
      const at = parsed.ok ? nextRunOf({ jobs: [{ id: "", when: parsed.when, cron: parsed.cron, instructions: "" }] }, new Date()) : undefined;
      next.textContent = at ? t("approval.next", { time: whenText(at) }) : "";
      next.hidden = !at;
    },
  };
}

/**
 * A bot request: its name (kept when it is being edited), AI, role and jobs, a row each, and main's notes on it; a new
 * bot with jobs also a switch to make its jobs schedules instead, each with the role in front of its instructions.
 */
function botForm(ask: Extract<ApprovalAsk, { kind: "bot" }>, field: Field, edited: () => void): Form {
  let asSchedules = false;
  const chips = make("div", "setChips");
  const chip = (label: string, schedules: boolean) => {
    const button = make("button", "", label);
    button.type = "button";
    button.addEventListener("click", () => {
      asSchedules = schedules;
      edited();
    });
    return button;
  };
  const botChip = chip(t("approval.asThisBot"), false);
  const schedulesChip = chip(t("approval.asSchedules"), true);
  chips.append(botChip, schedulesChip);

  const schedulesNote = make("p", "setNote", t("approval.schedulesNote"));
  const name = make("input");
  name.type = "text";
  name.value = ask.name;
  // A bot's name heads a tab and a card, and makes its session and profile file: an edit keeps it.
  name.maxLength = MAX_BOT_NAME;
  name.readOnly = ask.editing;
  name.setAttribute("aria-label", t("approval.field.name"));
  const agent = make("select");
  agent.setAttribute("aria-label", t("approval.field.agent"));
  for (const kind of delegateAgents) agent.append(new Option(agents[kind].label, kind, false, kind === ask.executor));
  const role = make("textarea");
  role.rows = 3;
  role.maxLength = MAX_SCHEDULE_TEXT;
  role.value = ask.role;
  role.placeholder = t("approval.roleNeeded");
  role.setAttribute("aria-label", t("approval.role"));

  // A row per job, in order; a kept one goes back with its id, which main binds only to this bot's own jobs.
  const jobs = make("div", "autoFormJobs");
  const rows = new Map<HTMLElement, () => { id?: string; when: string; instructions: string }>();
  const add = buttons([t("approval.addJob"), () => {
    addJob().focus();
    edited();
  }]);
  const addJob = (job?: { id?: string; when: string; instructions: string }): HTMLTextAreaElement => {
    const row = make("div", "autoFormJobFields");
    const picker = whenPicker(t, job?.when);
    const instructions = make("textarea");
    instructions.rows = 3;
    instructions.maxLength = MAX_SCHEDULE_TEXT;
    instructions.value = job?.instructions ?? "";
    instructions.placeholder = t("schedules.instructions");
    instructions.setAttribute("aria-label", t("schedules.instructions"));
    const remove = buttons([t("approval.removeJob"), () => {
      rows.delete(row);
      row.remove();
      add.querySelector("button")!.focus();
      edited();
    }]);
    rows.set(row, () => ({ ...(job?.id ? { id: job.id } : {}), when: picker.value(), instructions: instructions.value }));
    row.append(picker.row, instructions, remove);
    jobs.append(row);
    return instructions;
  };
  for (const job of ask.jobs) addJob(job);
  const listed = () => [...rows.values()].map((value) => value());

  const notes = ask.notes.map((line) => {
    const note = make("p", "setNote", line);
    // A profile already in the folder is shown with its own line breaks.
    note.style.whiteSpace = "pre-wrap";
    return note;
  });
  return {
    parts: [
      make("p", "setNote", `${ask.machine} · ${ask.folder}`), ...(ask.canSchedule ? [chips] : []), schedulesNote,
      field("name", t("approval.field.name"), name),
      field("agent", t("approval.field.agent"), agent),
      field("role", t("approval.role"), role),
      field("jobs", t("approval.field.jobs"), jobs, add),
      ...notes,
    ],
    first: ask.editing ? role : name,
    bot: () => !asSchedules,
    reply: () => ({ answer: "allowed", as: asSchedules ? "schedules" : "bot", name: name.value, executor: agent.value as AgentKind, role: role.value, jobs: listed() }),
    ok: () => name.value.trim() !== "" && name.value.length <= MAX_BOT_NAME && role.value.trim() !== "" &&
      listed().every((job) => parseWhen(job.when).ok && job.instructions.trim() !== "") && (!asSchedules || listed().length > 0),
    refresh() {
      botChip.setAttribute("aria-pressed", String(!asSchedules));
      schedulesChip.setAttribute("aria-pressed", String(asSchedules));
      schedulesNote.hidden = !asSchedules;
      // A bot's own lines (its session, its profile file): not about schedules.
      for (const note of notes) note.hidden = asSchedules;
    },
  };
}

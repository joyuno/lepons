import type { Machine } from "../machine/machine.ts";
import { t } from "../i18n/i18n.ts";
import { posixQuote } from "../session/state.ts";
import { cronOf, powershellLine, psQuote, readCrontab, writeCrontab, type When } from "./schedule.ts";

/**
 * The timetable jobs a machine already had before Lepons: launchd agents, cron,
 * systemd timers, Task Scheduler. Read as they are, and changed only on the
 * person's say-so. Lepons' own schedules (schedule.ts) are listed as "lepons"
 * and controlled there, never here.
 *
 * Everything read off a machine (labels, paths, command lines) is untrusted:
 * it only ever reaches a shell through posixQuote or psQuote, and a path or
 * unit goes after `--` so a name starting with "-" is not read as an option.
 */
export interface OsJob {
  /** Source plus what finds it again: the plist's path, the cron line, the unit, the task's full name. */
  id: string;
  source: "launchd" | "cron" | "systemd" | "taskscheduler" | "lepons";
  label: string;
  command: string;
  schedule?: OsSchedule;
  resident?: boolean;
  enabled: boolean;
  logPath?: string;
  lastResult?: string;
  /** What the OS says about it, read as it is (Task Scheduler's Description, a systemd unit's). */
  description?: string;
  /** Task Scheduler's Author; `mine` when that is the account the list was read as, `runsAsMe` when the task runs as it. */
  author?: string;
  mine?: boolean;
  runsAsMe?: boolean;
  /** The program it starts, its arguments as words, and where it starts it. */
  program?: string;
  args?: string[];
  cwd?: string;
  /** Where the job is defined: the plist, the unit file. */
  file?: string;
}

/** A timetable as data, so the words come from t() in whatever language is chosen (scheduleText). */
export type OsSchedule =
  | { kind: "calendar"; entries: Array<{ weekday?: number; hour?: number; minute: number }> }
  | { kind: "interval"; seconds: number }
  | { kind: "logon" }
  | { kind: "boot" }
  | { kind: "text"; text: string }
  | { kind: "many"; items: OsSchedule[] };

const clock = (hour: number, minute: number) => `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;

/** The words for a schedule, in the chosen language. */
export function scheduleText(schedule: OsSchedule): string {
  switch (schedule.kind) {
    case "calendar":
      // Every day at clock times: "매일 06:30, 15:30".
      if (schedule.entries.every((each) => each.hour !== undefined && each.weekday === undefined)) {
        return t("schedule.daily", { time: schedule.entries.map((each) => clock(each.hour!, each.minute)).join(", ") });
      }
      return schedule.entries.map((each) => {
        const time = each.hour === undefined ? t("osjob.sched.hourAt", { minute: each.minute }) : clock(each.hour, each.minute);
        return each.weekday === undefined ? time : `${t(`osjob.sched.day.${each.weekday % 7}`)} ${time}`;
      }).join(", ");
    case "interval":
      if (schedule.seconds % 3600 === 0) return t("osjob.sched.everyHours", { n: schedule.seconds / 3600 });
      return schedule.seconds % 60 === 0 ? t("osjob.sched.everyMinutes", { n: schedule.seconds / 60 }) : t("osjob.sched.everySeconds", { n: schedule.seconds });
    case "logon": return t("osjob.sched.logon");
    case "boot": return t("osjob.sched.boot");
    case "text": return schedule.text;
    case "many": return schedule.items.map(scheduleText).join(", ");
  }
}

export type OsJobAction = "pause" | "resume" | "run" | "log";

/** A job's name from its id alone, for the bot approval that lists linked jobs: a plist's file name, else what follows the source. */
export function osJobName(id: string): string {
  const rest = id.slice(id.indexOf(":") + 1);
  return id.startsWith("launchd:") ? rest.slice(rest.lastIndexOf("/") + 1).replace(/\.plist$/, "") : rest;
}

const LEPONS_LABEL = "app.lepons.schedule.";
const CRON_MARK = "# lepons-schedule:";
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function launchdSchedule(plist: Record<string, unknown>): OsSchedule | undefined {
  const raw = plist.StartCalendarInterval;
  const entries = (Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]).filter(isRecord);
  if (entries.length > 0) {
    return {
      kind: "calendar",
      entries: entries.map((each) => ({
        minute: Number(each.Minute ?? 0),
        ...(each.Hour === undefined ? {} : { hour: Number(each.Hour) }),
        ...(each.Weekday === undefined ? {} : { weekday: Number(each.Weekday) }),
      })),
    };
  }
  const seconds = Number(plist.StartInterval);
  return seconds > 0 ? { kind: "interval", seconds } : undefined;
}

/** `plists` are `plutil -convert json -o - <file>` per file; `loaded` is `launchctl list`. */
export function parseLaunchd(plists: Array<{ file: string; json: unknown }>, loaded: string): OsJob[] {
  const labels = new Set(loaded.split("\n").map((line) => line.trim().split(/\s+/)[2]).filter((label): label is string => !!label));
  const jobs: OsJob[] = [];
  for (const { file, json } of plists) {
    if (!isRecord(json) || typeof json.Label !== "string") continue;
    const program = Array.isArray(json.ProgramArguments) ? json.ProgramArguments.map(String) : typeof json.Program === "string" ? [json.Program] : [];
    const schedule = launchdSchedule(json);
    const logPath = [json.StandardOutPath, json.StandardErrorPath].find((path): path is string => typeof path === "string");
    const cwd = typeof json.WorkingDirectory === "string" ? json.WorkingDirectory : undefined;
    jobs.push({
      id: `launchd:${file}`,
      source: json.Label.startsWith(LEPONS_LABEL) ? "lepons" : "launchd",
      label: json.Label,
      command: program.join(" "),
      ...(schedule ? { schedule } : {}),
      ...(!schedule && json.KeepAlive ? { resident: true } : {}),
      enabled: labels.has(json.Label),
      ...(logPath ? { logPath } : {}),
      ...(program[0] ? { program: program[0], args: program.slice(1) } : {}),
      ...(cwd ? { cwd } : {}),
      file,
    });
  }
  return jobs;
}

// Fields may be names too (mon-fri, jan); the line may be indented.
const FIELD = "[\\w*][\\w*/,-]*";
const CRON_LINE = new RegExp(`^(\\s*)(#?)(${FIELD}(?:\\s+${FIELD}){4}|@\\w+)\\s+(\\S.*)$`);

/** One minute and a list of hours, every day ("0 10,22 * * *"), reads as clock times; anything else stays as written. */
function cronSchedule(spec: string): OsSchedule {
  const [minute = "", hour = "", ...rest] = spec.split(/\s+/);
  return /^\d+$/.test(minute) && /^\d+(,\d+)*$/.test(hour) && rest.join(" ") === "* * *"
    ? { kind: "calendar", entries: hour.split(",").map((each) => ({ hour: Number(each), minute: Number(minute) })) }
    : { kind: "text", text: spec };
}

/** A cron job's id is its whole line, so an edit aims at that line and no other. */
export function parseCrontab(text: string): OsJob[] {
  const jobs: OsJob[] = [];
  for (const line of text.split("\n")) {
    const marked = line.lastIndexOf(` ${CRON_MARK}`);
    if (marked >= 0) {
      const label = line.slice(marked + 1 + CRON_MARK.length).trim();
      jobs.push({ id: `lepons:cron:${label}`, source: "lepons", label, command: line.slice(0, marked), enabled: !line.trimStart().startsWith("#") });
      continue;
    }
    const match = CRON_LINE.exec(line);
    if (!match) continue;
    // Only a `#` stuck to a numeric minute and hour is a paused job (what pausing writes); "#note a b c d e f" is a note.
    const [minute = "", hour = ""] = match[3]!.split(/\s+/);
    if (match[2] === "#" && !match[3]!.startsWith("@") && !(/^[\d*][\d*/,-]*$/.test(minute) && /^[\d*][\d*/,-]*$/.test(hour))) continue;
    // The program and its words, after a leading `cd somewhere &&`, which is where it runs.
    const cd = /^cd\s+(\S+)\s*(?:&&|;)\s*/.exec(match[4]!);
    const [program, ...args] = commandWords(match[4]!.slice(cd?.[0].length ?? 0));
    jobs.push({
      id: `cron:${line}`, source: "cron", label: match[4]!.slice(0, 60), command: match[4]!, schedule: cronSchedule(match[3]!), enabled: match[2] === "",
      ...(program ? { program, args } : {}), ...(cd ? { cwd: cd[1]!.replace(/^["']|["']$/g, "") } : {}),
    });
  }
  return jobs;
}

/**
 * `systemctl --user list-timers --all --no-legend`: NEXT LEFT LAST PASSED UNIT ACTIVATES, the times being several words.
 * `units` is `systemctl --user show` of the units they activate (blocks of key=value), for what each says it is.
 */
export function parseSystemdTimers(listTimers: string, units = ""): OsJob[] {
  const shown = new Map<string, Record<string, string>>();
  for (const block of units.split(/\r?\n\s*\r?\n/)) {
    const fields: Record<string, string> = {};
    for (const each of block.split(/\r?\n/)) {
      const at = each.indexOf("=");
      if (at > 0) fields[each.slice(0, at)] = each.slice(at + 1).trim();
    }
    if (fields.Id) shown.set(fields.Id, fields);
  }
  const jobs: OsJob[] = [];
  for (const line of listTimers.split("\n")) {
    const words = line.trim().split(/\s+/);
    const unit = words.at(-2);
    const activates = words.at(-1);
    if (!unit?.endsWith(".timer") || !activates) continue;
    const next = /^\w{3} \d{4}-\d\d-\d\d \d\d:\d\d/.exec(line.trim())?.[0];
    const about = shown.get(activates) ?? {};
    // A unit without a Description is described by its own name: that says nothing.
    const description = about.Description && about.Description !== activates ? about.Description : undefined;
    const program = /path=(\S+)/.exec(about.ExecStart ?? "")?.[1];
    const argv = commandWords(/argv\[\]=([^;]*)/.exec(about.ExecStart ?? "")?.[1] ?? "");
    jobs.push({
      id: `systemd:${unit}`, source: "systemd", label: unit, command: activates, ...(next ? { schedule: { kind: "text" as const, text: next } } : {}), enabled: next !== undefined,
      ...(description ? { description: description.slice(0, 300) } : {}),
      ...(program ? { program, args: argv.slice(1) } : {}),
      ...(about.WorkingDirectory ? { cwd: about.WorkingDirectory.replace(/^!/, "") } : {}),
      ...(about.FragmentPath ? { file: about.FragmentPath } : {}),
    });
  }
  return jobs;
}

/** PowerShell's ConvertTo-Json gives one object, not an array, for one task. */
const many = (value: unknown): unknown[] => (Array.isArray(value) ? value : value === undefined || value === null ? [] : [value]);
const WINDOWS_STATE_DISABLED = 1;

/** The input is windowsListScript's JSON. Throws when there is output but no JSON in it: an empty list must mean no jobs. */
export function parseWindowsTasks(json: string): OsJob[] {
  if (json.trim() === "") return [];
  // From the first bracket to the last: a shell may add a line before or after.
  const from = json.search(/[[{]/);
  const to = Math.max(json.lastIndexOf("]"), json.lastIndexOf("}"));
  if (from < 0 || to < from) throw new Error("unexpected_output: Task Scheduler's answer was not JSON");
  const root: unknown = JSON.parse(json.slice(from, to + 1));
  // windowsListScript wraps the tasks with the account it ran as; a bare list is read too.
  const user = isRecord(root) && typeof root.User === "string" ? root.User.toLowerCase() : undefined;
  // Principal.UserId is often the bare account name ("admin" for PC\admin).
  const runsAs = (id: unknown) => typeof id === "string" && id !== "" && user !== undefined && (user === id.toLowerCase() || user.endsWith(`\\${id.toLowerCase()}`));
  const tasks = many(isRecord(root) && "Tasks" in root ? root.Tasks : root);
  const text = (value: unknown) => (typeof value === "string" && value.trim() !== "" ? value.trim() : undefined);
  const jobs: OsJob[] = [];
  for (const task of tasks) {
    if (!isRecord(task) || typeof task.TaskName !== "string") continue;
    const path = typeof task.TaskPath === "string" ? task.TaskPath : "\\";
    if (/^\\Microsoft\\/i.test(path)) continue;
    const actions = many(task.Actions).filter(isRecord).map((each) => [each.Execute, each.Arguments].filter((part) => typeof part === "string" && part !== "").join(" "));
    const items = many(task.Triggers).filter(isRecord).flatMap((each): OsSchedule[] => {
      const type = String(each.Type ?? "");
      if (/Logon/.test(type)) return [{ kind: "logon" }];
      if (/Boot/.test(type)) return [{ kind: "boot" }];
      const at = /T(\d\d):(\d\d)/.exec(String(each.StartBoundary ?? ""));
      if (!at) return [];
      // Only a daily trigger is "every day at"; a weekly or one-time one keeps just its clock time.
      return /Daily/.test(type) ? [{ kind: "calendar", entries: [{ hour: Number(at[1]), minute: Number(at[2]) }] }] : [{ kind: "text", text: `${at[1]}:${at[2]}` }];
    });
    const first = many(task.Actions).find(isRecord);
    const description = text(task.Description);
    const author = text(task.Author);
    const program = text(first?.Execute)?.replace(/^"(.*)"$/, "$1");
    const cwd = text(first?.WorkingDirectory);
    const args = commandWords(text(first?.Arguments) ?? "");
    jobs.push({
      id: `taskscheduler:${path}${task.TaskName}`,
      source: /^\\Lepons\\$/i.test(path) ? "lepons" : "taskscheduler",
      label: `${path}${task.TaskName}`,
      command: actions.join(" ; "),
      ...(items.length > 0 ? { schedule: { kind: "many" as const, items } } : {}),
      enabled: task.State !== WINDOWS_STATE_DISABLED && task.State !== "Disabled",
      ...(task.LastResult === undefined || task.LastResult === null ? {} : { lastResult: String(task.LastResult) }),
      ...(description ? { description: description.slice(0, 300) } : {}),
      ...(author ? { author } : {}),
      ...(author && author.toLowerCase() === user ? { mine: true } : {}),
      ...(runsAs(task.RunAs) ? { runsAsMe: true } : {}),
      ...(program ? { program, args } : {}),
      ...(cwd ? { cwd } : {}),
    });
  }
  return jobs;
}

/** Read-only, and one clean shape (a raw Get-ScheduledTask dump has the command cut short). */
export const windowsListScript = [
  // Progress would go to stderr as CLIXML, which Machine.run mixes into the output.
  "$ProgressPreference = 'SilentlyContinue'",
  "$ErrorActionPreference = 'SilentlyContinue'",
  // Redirected, PowerShell 5.1 writes the OEM code page (CP949 on Korean Windows); this is read as UTF-8.
  "[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)",
  "[pscustomobject]@{ User = \"$env:USERDOMAIN\\$env:USERNAME\"; Tasks = @(Get-ScheduledTask | Where-Object { $_.TaskPath -notlike '\\Microsoft\\*' } | ForEach-Object {",
  "  $info = $_ | Get-ScheduledTaskInfo",
  "  [pscustomobject]@{ TaskName = $_.TaskName; TaskPath = $_.TaskPath; State = [int]$_.State; LastResult = $info.LastTaskResult; Description = $_.Description; Author = $_.Author; RunAs = $_.Principal.UserId;",
  "    Actions = @($_.Actions | ForEach-Object { [pscustomobject]@{ Execute = $_.Execute; Arguments = $_.Arguments; WorkingDirectory = $_.WorkingDirectory } });",
  "    Triggers = @($_.Triggers | ForEach-Object { [pscustomobject]@{ Type = $_.CimClass.CimClassName; StartBoundary = $_.StartBoundary } }) }",
  "}) } | ConvertTo-Json -Depth 5 -Compress",
].join("\n");

const SECTION = "@@lepons-osjobs:";

/** One read-only POSIX line for a Mac or Linux box: crontab, systemd timers, and on a Mac the LaunchAgents and `launchctl list`. */
export const posixListScript = (home: string): string =>
  `echo ${SECTION}cron; crontab -l 2>/dev/null; echo ${SECTION}timers; systemctl --user list-timers --all --no-legend --no-pager 2>/dev/null; ` +
  // What the timers start says what it is (unit names cannot hold a space or a quote).
  // The substitution itself is the argument: zsh does not split a variable's words, but it does split this.
  `echo ${SECTION}units; systemctl --user show --property=Id,Description,FragmentPath,ExecStart,WorkingDirectory -- ` +
  `$(systemctl --user list-timers --all --no-legend --no-pager 2>/dev/null | awk '{print $NF}') 2>/dev/null; ` +
  `if [ "$(uname -s)" = Darwin ]; then echo ${SECTION}loaded; launchctl list 2>/dev/null; ` +
  `cd ${posixQuote(`${home}/Library/LaunchAgents`)} 2>/dev/null && for f in *.plist; do [ -f "$f" ] || continue; echo "${SECTION}plist $PWD/$f"; plutil -convert json -o - "$f" 2>/dev/null; echo; done; fi; true`;

/** posixListScript's output, as jobs. Throws when it is not that output at all. */
export function parsePosixListing(output: string): OsJob[] {
  if (!output.includes(`${SECTION}cron`)) throw new Error("unexpected_output: that machine's answer was not the job listing");
  const parts = new Map<string, string>();
  const plists: Array<{ file: string; json: unknown }> = [];
  for (const chunk of output.split(SECTION).slice(1)) {
    const newline = chunk.indexOf("\n");
    const head = (newline < 0 ? chunk : chunk.slice(0, newline)).replace(/\r$/, "");
    const body = newline < 0 ? "" : chunk.slice(newline + 1);
    if (head.startsWith("plist ")) {
      try {
        plists.push({ file: head.slice(6), json: JSON.parse(body) });
      } catch {
        // A plist plutil could not turn into JSON is left out, not guessed at.
      }
    } else parts.set(head, body);
  }
  return [
    ...parseLaunchd(plists, parts.get("loaded") ?? ""),
    ...parseCrontab(parts.get("cron") ?? ""),
    ...parseSystemdTimers(parts.get("timers") ?? "", parts.get("units") ?? ""),
  ];
}

export type OsJobMachine = Pick<Machine, "windows" | "run">;
type Done = { ok: true; output?: string } | { ok: false; error: string };
/** One at a time per machine (main's onMachine); the approval question stays outside it. */
type Serial = <T>(work: () => Promise<T>) => Promise<T>;
const direct: Serial = (work) => work();

export async function listOsJobs(machine: OsJobMachine, home: string): Promise<{ ok: true; jobs: OsJob[] } | { ok: false; error: string }> {
  const ran = await machine.run(machine.windows ? powershellLine(windowsListScript) : posixListScript(home));
  if (!ran) return { ok: false, error: "unreachable: could not reach that machine" };
  if (ran.code !== 0) return { ok: false, error: `list_failed: ${ran.output.trim().slice(0, 300) || `exit ${ran.code}`}` };
  try {
    return { ok: true, jobs: machine.windows ? parseWindowsTasks(ran.output) : parsePosixListing(ran.output) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

const domain = "gui/$(id -u)";
const target = (label: string) => `${domain}/${posixQuote(label)}`;
// A plist's path always starts with "/", so it cannot be read as an option.
const plistOf = (job: OsJob) => job.id.slice("launchd:".length);
const bootstrap = (file: string) => `launchctl bootstrap ${domain} ${posixQuote(file)}`;
// bootout is asynchronous: a bootstrap right after it can fail with I/O error 5, so one retry (as schedule.ts).
const bootstrapRetry = (file: string) => `{ ${bootstrap(file)} || { sleep 1; ${bootstrap(file)}; }; }`;

/** `\folder\name` as Task Scheduler's two arguments. */
function taskArguments(label: string): string {
  const cut = label.lastIndexOf("\\") + 1;
  return `-TaskPath ${psQuote(label.slice(0, cut) || "\\")} -TaskName ${psQuote(label.slice(cut))}`;
}

/**
 * The command for a button: a shell line on a POSIX machine, PowerShell text for
 * Task Scheduler. "" where this kind has none (cron's pause is a crontab edit).
 * launchd pause also disables the label, or the next login would load it again,
 * as schedule.ts learned; resume enables first for the same reason.
 */
export function jobCommand(job: OsJob, action: OsJobAction): string {
  if (job.source === "launchd") {
    if (action === "pause") return `launchctl bootout ${target(job.label)}; launchctl disable ${target(job.label)}`;
    if (action === "resume") return `launchctl enable ${target(job.label)} && ${bootstrapRetry(plistOf(job))}`;
    if (action === "run") return `launchctl kickstart -k ${target(job.label)}`;
    return job.logPath ? `tail -n 200 -- ${posixQuote(job.logPath)}` : "";
  }
  if (job.source === "systemd") {
    if (action === "pause") return `systemctl --user disable --now -- ${posixQuote(job.label)}`;
    if (action === "resume") return `systemctl --user enable --now -- ${posixQuote(job.label)}`;
    if (action === "run") return `systemctl --user start -- ${posixQuote(job.command)}`;
    return `journalctl --user --unit=${posixQuote(job.command)} -n 200 --no-pager`;
  }
  if (job.source === "taskscheduler") {
    const task = taskArguments(job.label);
    if (action === "pause") return `Disable-ScheduledTask ${task} | Out-Null`;
    if (action === "resume") return `Enable-ScheduledTask ${task} | Out-Null`;
    if (action === "run") return `Start-ScheduledTask ${task}`;
    return `Get-ScheduledTaskInfo ${task} | Format-List LastRunTime,LastTaskResult,NextRunTime`;
  }
  // ponytail: cron's % is a newline to cron but not to sh -c; a line using it runs differently here.
  return job.source === "cron" && action === "run" ? `/bin/sh -c ${posixQuote(job.command)}` : "";
}

/** What the approval dialog shows: the exact command or line that will be run or written. */
export type OsJobApprove = (action: OsJobAction | "edit", job: OsJob, detail: string) => Promise<boolean>;

/** The crontab with the first line equal to `line` replaced; every other line as it was. Undefined: no such line. */
export function replaceCronLine(crontab: string, line: string, replacement: string): string | undefined {
  const lines = crontab.split("\n");
  const at = lines.indexOf(line);
  if (at < 0) return undefined;
  lines[at] = replacement;
  return lines.join("\n");
}

async function changeCron(machine: OsJobMachine, line: string, replacement: string): Promise<Done> {
  const current = await readCrontab(machine);
  if (!current.ok) return current;
  const text = replaceCronLine(current.text, line, replacement);
  if (text === undefined) return { ok: false, error: "changed_meanwhile: that crontab line is no longer there" };
  const wrote = await writeCrontab(machine, text);
  return wrote.ok ? { ok: true } : wrote;
}

/**
 * Does what the person pressed. `log` reads and needs no approval; everything
 * else asks first (outside `serial`, so a dialog does not hold the machine's
 * queue) and does nothing on a no. Lepons' own jobs are not here.
 * ponytail: a crontab is read, changed and written whole, so a hand edit in the same second can lose a line (as schedule.ts).
 */
export async function controlOsJob(machine: OsJobMachine, job: OsJob, action: OsJobAction, approve: OsJobApprove, serial: Serial = direct): Promise<Done> {
  if (job.source === "lepons") return { ok: false, error: "use_schedules: Lepons' own schedules are controlled in their own list" };
  if (action === "pause" && !job.enabled) return { ok: false, error: "already_paused: that job is not running on its timetable" };
  if (action === "resume" && job.enabled) return { ok: false, error: "not_paused: that job is already on" };
  const line = job.id.slice("cron:".length);
  const cronEdit = job.source === "cron" && (action === "pause" || action === "resume") ? (action === "pause" ? `#${line.trimStart()}` : line.replace(/^(\s*)#/, "$1")) : undefined;
  const command = cronEdit ?? jobCommand(job, action);
  if (command === "") return { ok: false, error: `unsupported: no ${action} for ${job.source}${action === "log" ? " (no log path)" : ""}` };
  if (action !== "log" && !(await approve(action, job, command))) return { ok: false, error: "refused" };
  if (cronEdit !== undefined) return serial(() => changeCron(machine, line, cronEdit));
  return serial(async (): Promise<Done> => {
    const ran = await machine.run(job.source === "taskscheduler" ? powershellLine(command) : command, { timeoutMs: 60_000 });
    if (!ran) return { ok: false, error: "unreachable: could not reach that machine" };
    if (ran.code !== 0 && action !== "log") return { ok: false, error: `job_failed: ${ran.output.trim() || `exit ${ran.code}`}` };
    return { ok: true, ...(ran.output.trim() ? { output: ran.output } : {}) };
  });
}

const calendarJson = (when: When): string => {
  const entry = (day?: number) => ({ ...(day === undefined ? {} : { Weekday: day }), ...(when.hour === undefined ? {} : { Hour: when.hour }), Minute: when.minute });
  return JSON.stringify(when.days ? when.days.map(entry) : entry());
};

/** The shell line that gives a launchd job a new time (exported for the live check). */
export function launchdEditLine(job: OsJob, when: When): string {
  const file = posixQuote(plistOf(job));
  return [
    `plutil -replace StartCalendarInterval -json ${posixQuote(calendarJson(when))} ${file}`,
    // Without this a job that had StartInterval would fire on both; it is fine when there was none.
    `{ plutil -remove StartInterval ${file} 2>/dev/null; true; }`,
    ...(job.enabled ? [`{ launchctl bootout ${target(job.label)} 2>/dev/null; sleep 1; }`, bootstrapRetry(plistOf(job))] : []),
  ].join(" && ");
}

/**
 * A new time for a launchd or cron job, through the approval. launchd: the
 * plist's StartCalendarInterval is replaced (a StartInterval is removed, or
 * both would fire), then reloaded only if the job was loaded, so a paused job
 * stays paused. A resident job (KeepAlive, no timetable) has no time to change.
 * cron: only that line's five fields change.
 */
export async function editOsJob(machine: OsJobMachine, job: OsJob, when: When, approve: OsJobApprove, serial: Serial = direct): Promise<Done> {
  if (job.source === "cron") {
    const line = job.id.slice("cron:".length);
    const match = CRON_LINE.exec(line);
    if (!match || match[3]!.startsWith("@")) return { ok: false, error: "unsupported: this line has no schedule to change" };
    const edited = `${match[1]}${match[2]}${cronOf(when)} ${match[4]}`;
    if (!(await approve("edit", job, edited))) return { ok: false, error: "refused" };
    return serial(() => changeCron(machine, line, edited));
  }
  if (job.source !== "launchd") return { ok: false, error: `unsupported: no time change for ${job.source}` };
  if (job.resident) return { ok: false, error: "unsupported: a job that stays running has no time to change" };
  const line = launchdEditLine(job, when);
  if (!(await approve("edit", job, line))) return { ok: false, error: "refused" };
  return serial(async (): Promise<Done> => {
    const ran = await machine.run(line, { timeoutMs: 60_000 });
    if (!ran) return { ok: false, error: "unreachable: could not reach that machine" };
    return ran.code === 0 ? { ok: true } : { ok: false, error: `job_failed: ${ran.output.trim() || `exit ${ran.code}`}` };
  });
}

// --- a name a person can read, where a job comes from, and the AI's one line ---

const SID = /S-1-5-\d+(?:-\d+)*/gi;
const GUID = /\{?[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\}?/gi;
/** Ids are not words: a SID, a GUID, a long run of digits go, and the dashes they leave. */
const withoutIds = (text: string) => text.replace(SID, "").replace(GUID, "").replace(/\d{10,}/g, "").replace(/^[\s_.-]+|[\s_.-]+$/g, "");

/** "SoftLandingRefreshForExpirationTask" -> "Soft Landing Refresh For Expiration"; a name with spaces already is kept as written. */
function words(name: string): string {
  const bare = name.replace(/(?<=\w)[\s_-]*Task$/, "");
  if (/\s/.test(bare)) return bare;
  // A dot between digits is a version (1.0), not a break.
  return bare.split(/[_-]+|(?<!\d)\.|\.(?!\d)/).filter(Boolean).join(" ")
    .replace(/([a-z\d])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
}

const REVERSE_DNS = /^(?:com|org|net|io|dev|app|co|me|ai|us)\.([^.]+)\.(.+)$/i;
const baseName = (path: string) => path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);

/** Words of a command line, a quoted part as one; backslashes stay as they are (Windows paths). */
export const commandWords = (text: string): string[] => [...text.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((each) => each[1] ?? each[2] ?? each[3]!);

/** Programs that only run what they are given: the script they run is the one a person would name. */
const INTERPRETER = /^(?:sh|bash|zsh|dash|python[\d.]*w?|py|pyw|node|deno|bun|npx|uvx?|pipx|perl|ruby|php|env|powershell|pwsh|cmd|wscript|cscript)(?:\.exe)?$/i;
const SHELL = /^(?:sh|bash|zsh|dash)$/;
/** Per interpreter family: flags whose code is inline (the interpreter stays the program), and flags that take a value (skipped with it). */
const INLINE: Record<string, RegExp> = { python: /^-c$/, node: /^(?:-e|-p|--eval|--print)$/, perl: /^-e$/, ruby: /^-e$/, php: /^-r$/ };
const VALUED: Record<string, RegExp> = { python: /^-[WXQ]$/, node: /^(?:-r|--require|--import)$/, env: /^-u$/ };

/**
 * What a job really runs: the program, or when that is an interpreter (sh,
 * python, node, powershell, cmd /c, env, uv run ...) the script or program it
 * is given, the first word that is not a flag. Flags after the script are the
 * script's own. Inline code (-c, -e, -Command without a .ps1) leaves the
 * interpreter.
 */
export function jobProgram(job: OsJob): string | undefined {
  let program = job.program;
  let args = job.args ?? [];
  outer: for (let depth = 0; depth < 4 && program && INTERPRETER.test(baseName(program)); depth++) {
    const kind = baseName(program).toLowerCase().replace(/\.exe$/, "");
    if (kind === "powershell" || kind === "pwsh") {
      const file = args.findIndex((each) => /^-f(ile)?$/i.test(each));
      const script = file >= 0 ? args[file + 1] : args.join(" ").match(/[^\s'"&]+\.ps1\b/i)?.[0];
      return script ?? program;
    }
    const family = /^py/.test(kind) ? "python" : /^(?:node|deno|bun)$/.test(kind) ? "node" : kind;
    let next = -1;
    if (kind === "cmd") next = args.findIndex((each) => /^\/[ck]$/i.test(each)) + 1 || -1;
    else {
      for (let at = 0; at < args.length; at++) {
        const word = args[at]!;
        // sh -c / -lc / -ic "the line": its first word, then on as for that.
        if (SHELL.test(kind) && /^-[a-z]*c[a-z]*$/.test(word)) {
          // A leading "cd somewhere &&" only says where it runs.
          args = commandWords((args[at + 1] ?? "").replace(/^\s*cd\s+\S+\s*(?:&&|;)\s*/, ""));
          program = args.shift();
          continue outer;
        }
        if (INLINE[family]?.test(word)) return program;
        if (family === "python" && word === "-m") {
          next = at + 1;
          break;
        }
        if (VALUED[family]?.test(word)) {
          at++;
          continue;
        }
        // Flags, env's VAR=value, and the "run" of uv run / pipx run come before what runs.
        if (word.startsWith("-") || word.startsWith("//") || (family === "env" && /^\w+=/.test(word)) || (/^(?:uv|pipx)$/.test(family) && word === "run")) continue;
        next = at;
        break;
      }
    }
    if (next < 0 || next >= args.length) return program;
    program = args[next];
    args = args.slice(next + 1);
  }
  return program;
}

/**
 * A job's name in words, and where its name says it comes from: Task
 * Scheduler's first folder, a launchd label's reverse-DNS vendor
 * (com.google.keystone.agent: "Google"). The label itself stays the job's
 * full name, for hover and details.
 */
export function jobTitle(job: OsJob): { name: string; source?: string } {
  let name = job.label;
  let source: string | undefined;
  if (job.source === "taskscheduler") {
    const parts = job.label.split("\\").map(withoutIds).filter(Boolean);
    name = parts.at(-1) ?? job.label;
    if (parts.length > 1) source = parts[0];
    // A task named after its program's path ("C__Program Files_HeidiSQL_heidisql.exe") is that program.
    if (/\.exe$/i.test(name)) name = name.slice(name.lastIndexOf("_") + 1).replace(/\.exe$/i, "");
  } else if (job.source === "launchd") {
    const vendor = REVERSE_DNS.exec(job.label);
    if (vendor) {
      name = vendor[2]!;
      source = vendor[1]!.charAt(0).toUpperCase() + vendor[1]!.slice(1);
    }
  } else if (job.source === "systemd") name = job.label.replace(/\.timer$/, "");
  else if (job.source === "cron") name = baseName(jobProgram(job) ?? job.label);
  const clean = words(withoutIds(name));
  // Nothing but ids: the label as it is. Any script's letters count (매일 백업).
  return { name: /[\p{L}\p{N}]/u.test(clean) ? clean : job.label, ...(source ? { source } : {}) };
}

export type JobOrigin = { kind: "os" | "app" | "mine" | "project"; name?: string };

/** An installed program's folder, whose name is its vendor or product. */
const APP_PATH = /[\\/](?:program files(?: \(x86\))?|appdata[\\/]local[\\/]programs|appdata[\\/]local(?![\\/](?:programs|temp)[\\/])|applications|library[\\/]application support|opt|snap)[\\/]([^\\/]+)/i;
/** Where programs are installed for the person to use, not written by them: Program Files, AppData\Local (Chrome, Programs), /Applications. */
const INSTALLED = /program files|appdata[\\/]local[\\/](?!temp[\\/])|[\\/]applications[\\/]/i;
/** launchd label vendors that are apps, not the person: their reverse-DNS second part, and the name to show. */
const KNOWN_VENDORS: Record<string, string> = {
  google: "Google", microsoft: "Microsoft", adobe: "Adobe", dropbox: "Dropbox", docker: "Docker", jetbrains: "JetBrains", zoom: "Zoom",
  spotify: "Spotify", mozilla: "Mozilla", valvesoftware: "Steam", logitech: "Logitech", oracle: "Oracle", github: "GitHub", tinyspeck: "Slack",
  agilebits: "1Password", brave: "Brave", openai: "OpenAI", anthropic: "Anthropic", keybase: "Keybase", teamviewer: "TeamViewer", mxcl: "Homebrew",
};
const vendorOfLabel = (label: string): string | undefined =>
  KNOWN_VENDORS[(/^homebrew\.mxcl\./.test(label) ? "mxcl" : REVERSE_DNS.exec(label)?.[1] ?? "").toLowerCase()];
/** Lower case, forward slashes, and what ends a path in a command line read as a slash, so "/a/b" is found as "/a/b/". */
const pathText = (text: string) => `${text.replaceAll("\\", "/").toLowerCase().replace(/["'\s;&]/g, "/")}/`;

/**
 * Who a job belongs to, from the evidence in order:
 * 1. The person made it (Task Scheduler Author is the listing account, a cron
 *    line, a LaunchAgent in ~/Library whose label is no known vendor, a
 *    systemd unit in ~/.config/systemd/user): `project` when what it runs or
 *    its folder is inside one of `folders` (Lepons' folders on that PC, the
 *    deepest wins), else `mine`; where an interpreter lives never changes that.
 *    One exception: a real program under Program Files, AppData\Local\Programs
 *    or /Applications is that app's, as Chrome files its tasks under the
 *    person's name.
 * 2. `os`: Author Microsoft, com.apple.* or /System, a unit under /usr/lib or
 *    /lib, or no program at all (a COM handler).
 * 3. `app`: such an install folder, a known vendor's label, or an Author that
 *    names a vendor (not an account like PC\me), with that vendor's name.
 * 4. Otherwise `project` inside a folder; a program under Windows' folder is
 *    `os`; a task that runs as the listing account is `mine`; the rest, put
 *    there by someone with admin rights, an `app` without a name.
 */
export function jobOrigin(job: OsJob, folders: Array<{ label: string; path: string }>): JobOrigin {
  const raw = job.program ?? "";
  const program = jobProgram(job) ?? "";
  const script = program !== raw ? program : undefined;
  /** The deepest registered folder any of these paths is in. */
  const insideOf = (paths: Array<string | undefined>): JobOrigin | undefined => {
    const where = paths.filter((each): each is string => !!each).map(pathText).join("\n");
    const inside = folders.filter((folder) => folder.path && where.includes(pathText(folder.path).replace(/\/+$/, "/")))
      .sort((a, b) => b.path.length - a.path.length)[0];
    return inside && { kind: "project", name: inside.label };
  };
  const project = insideOf([program, job.cwd, job.command]);
  // Inside a folder for a reason other than where the program itself is installed: its script, its folder, its arguments.
  const projectBeyondProgram = insideOf([script, job.cwd, ...(job.args ?? (job.program ? [] : [job.command]))]);
  // Homebrew is a toolbox the person fills, not a vendor.
  const installed = program.includes("/opt/homebrew/") ? undefined : APP_PATH.exec(program)?.[1]?.replace(/\.app$/i, "");
  const app = (name: string | undefined): JobOrigin => ({ kind: "app", ...(name ? { name } : {}) });
  const file = job.file ?? (job.source === "launchd" ? plistOf(job) : "");
  const labelVendor = job.source === "launchd" ? vendorOfLabel(job.label) : undefined;
  const madeByMe = job.source === "cron"
    || (job.source === "taskscheduler" && job.mine === true)
    || (job.source === "launchd" && /\/Library\/LaunchAgents\//.test(file) && !file.startsWith("/Library/") && !labelVendor && !/^com\.apple\./i.test(job.label))
    || (job.source === "systemd" && file.includes("/.config/systemd/user/"));
  // The person's own mark loses only to a program installed to be used (Chrome files its tasks under the person's
  // name), and only when nothing but that program's place said so: a script or a folder in a project keeps it.
  if (madeByMe) {
    if (!script && INSTALLED.test(raw) && !projectBeyondProgram) return app(APP_PATH.exec(raw)?.[1]?.replace(/\.app$/i, ""));
    return project ?? { kind: "mine" };
  }
  if (/microsoft/i.test(job.author ?? "") || !job.program || /^com\.apple\./i.test(job.label) || file.startsWith("/System/") || program.startsWith("/System/")
    || (job.source === "systemd" && /^\/(?:usr\/)?lib\//.test(file))) return { kind: "os" };
  // An Author shaped like an account (PC\me, NT AUTHORITY\SYSTEM) names no vendor; a version is left off ("HeidiSQL 12.15.0.7171").
  const authorVendor = job.author && !/^[^\\]+\\[^\\]+$/.test(job.author) ? job.author.replace(/\s+v?\d+(?:\.\d+)+$/, "") : undefined;
  if (installed || labelVendor || authorVendor) return app(labelVendor ?? installed ?? authorVendor);
  if (project) return project;
  if (/^(?:%windir%|%systemroot%|[a-z]:\\windows\\)/i.test(program)) return { kind: "os" };
  return job.runsAsMe ? { kind: "mine" } : app(undefined);
}

/** What a haiku is told about one job, to say in a line what it does; `key` is where its answer is kept. */
export interface DescribeItem { key: string; name: string; original: string; run: string; os: string }

/** A 32-bit FNV-1a of the text, in hex: a key that changes with it, the same in main and in the page. */
function fnv(text: string): string {
  let hash = 0x811c9dc5;
  for (const char of text) hash = Math.imul(hash ^ char.codePointAt(0)!, 0x01000193) >>> 0;
  return hash.toString(16);
}

const OS_NAME: Record<OsJob["source"], string> = { taskscheduler: "Windows", launchd: "macOS", systemd: "Linux", cron: "Linux or macOS (cron)", lepons: "" };

/** The AI line's input for a job; its key changes with the job's command or the language, so an old answer is never shown for a new command. */
export function describeItem(nodeId: string, job: OsJob, locale: string): DescribeItem {
  const flat = (text: string) => text.replace(/\s+/g, " ").trim();
  return {
    key: `${nodeId}\n${job.id}\n${fnv(`${locale}\n${job.command}\n${job.program ?? ""}`)}`,
    name: flat(jobTitle(job).name),
    original: flat(job.label).slice(0, 200),
    run: flat(job.command || job.program || "").slice(0, 200),
    os: OS_NAME[job.source],
  };
}

/** The lines a haiku reads: number, cleaned name, original name, command, OS, tab-separated. */
export const describeLines = (items: DescribeItem[]): string =>
  items.map((item, at) => [at + 1, item.name, item.original, item.run || "-", item.os].join("\t")).join("\n");

/**
 * The haiku's answer: only lines "number<TAB>text" whose number was asked and
 * not answered already, the text cut at 120 characters. Anything else is
 * dropped, so a job with no good line simply has none.
 */
export function parseDescribed(output: string, count: number): Map<number, string> {
  const lines = new Map<number, string>();
  for (const each of output.split(/\r?\n/)) {
    const match = /^\s*(\d+)\t(.+)$/.exec(each);
    if (!match) continue;
    const at = Number(match[1]);
    const text = match[2]!.trim().replace(/^["'`](.*)["'`]$/, "$1").trim();
    if (!text || at < 1 || at > count || lines.has(at)) continue;
    lines.set(at, text.slice(0, 120));
  }
  return lines;
}

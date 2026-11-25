import type { Machine } from "../machine/machine.ts";
import { formatDate, t } from "../i18n/i18n.ts";
import { posixQuote } from "../session/state.ts";

/**
 * Agent runs on a timetable that live on the machine that runs them -- cron on
 * a Mac or Linux box, Task Scheduler on Windows -- so they go on while the PC
 * running Lepons is off. Everything for one schedule sits in
 * ~/.lepons/schedules/<id>/: the instructions (fed on stdin, never on a command
 * line), a runner, runs/<time>.log, tail.txt and last.json.
 *
 * Text is made by the pure functions here; the async ones at the end only
 * write it and run it, through a Machine.
 */

/** What both cron and Task Scheduler can say: one minute past some hour, or past every hour, on all days or some (0 = Sunday). */
export interface When {
  minute: number;
  hour?: number;
  days?: number[];
}

/** How long a run -- its precheck and its agent together -- may take before it is killed. */
export const RUN_LIMIT_S = 30 * 60;

/**
 * The most instructions, or precheck, a schedule takes. The approval shows
 * them whole, as they will run unattended, and a native dialog holds about this much.
 */
export const MAX_SCHEDULE_TEXT = 4000;

/** Why a schedule's text cannot be put to the operator whole, or undefined when it can. */
export function scheduleTextProblem(instructions: string, precheck = ""): string | undefined {
  if (instructions.trim() === "") return "no_instructions: say what the agent should do";
  return instructions.length > MAX_SCHEDULE_TEXT || precheck.length > MAX_SCHEDULE_TEXT
    ? `too_long: the instructions and the precheck must each be at most ${MAX_SCHEDULE_TEXT} characters, so the approval can show them whole`
    : undefined;
}

const windowsDays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const usage =
  "use hourly, daily HH:MM, weekdays HH:MM, weekly DAY HH:MM, or a cron 'M H * * DOW' " +
  "with one minute, one hour (or * for every hour) and * or days of the week";

const number = (text: string, max: number): number | undefined =>
  /^\d{1,2}$/.test(text) && Number(text) <= max ? Number(text) : undefined;

/** 0-7 (both 0 and 7 are Sunday) or a day's name, three letters at least: mon, tues, friday. */
function day(text: string): number | undefined {
  const named = windowsDays.findIndex((name) => text.length >= 3 && name.toLowerCase().startsWith(text));
  return named >= 0 ? named : number(text, 7);
}

/** A cron day-of-week field: *, or days and ranges like 1-5 or mon,wed. Undefined: every day. */
function days(field: string): number[] | undefined | null {
  if (field === "*") return undefined;
  const picked = new Set<number>();
  for (const part of field.split(",")) {
    const [from, to, ...rest] = part.split("-");
    const start = day(from ?? "");
    let end = to === undefined ? start : day(to);
    // Sunday ends a range as 7: 0-7 is the whole week, fri-sun the weekend with Friday.
    if (to !== undefined && end === 0 && start !== undefined && start > 0) end = 7;
    if (rest.length > 0 || start === undefined || end === undefined || end < start) return null;
    for (let each = start; each <= end; each++) picked.add(each % 7);
  }
  return picked.size === 7 ? undefined : [...picked].sort((a, b) => a - b);
}

function at(text: string | undefined): { hour: number; minute: number } | undefined {
  const match = /^(\d{1,2}):(\d{2})$/.exec(text ?? "");
  const hour = number(match?.[1] ?? "", 23);
  const minute = number(match?.[2] ?? "", 59);
  return hour === undefined || minute === undefined ? undefined : { hour, minute };
}

/** A timetable in words, not cron: "매일 09:00", "월, 금 09:00". Here so the window words a bot's jobs as the approval does. */
export function describeWhen(when: When): string {
  const minute = String(when.minute).padStart(2, "0");
  if (when.hour === undefined) return t("schedule.hourly", { minute });
  const time = `${String(when.hour).padStart(2, "0")}:${minute}`;
  if (when.days === undefined) return t("schedule.daily", { time });
  // 2026-11-01 was a Sunday, so day n of the week is the n-th day after it.
  return `${when.days.map((day) => formatDate(new Date(2026, 10, 1 + day), { weekday: "short" })).join(", ")} ${time}`;
}

/** The 5-field cron for a When. */
export function cronOf(when: When): string {
  return `${when.minute} ${when.hour ?? "*"} * * ${when.days?.join(",") ?? "*"}`;
}

/** The settings form's timetable choice for a When: hourly, daily, weekdays, w0-w6 (one day a week), or cron for the rest. */
export function presetOf(when: When): string {
  if (when.hour === undefined) return "hourly";
  if (when.days === undefined) return "daily";
  if (when.days.join(",") === "1,2,3,4,5") return "weekdays";
  return when.days.length === 1 ? `w${when.days[0]}` : "cron";
}

/** The cron for the form's choice, its HH:MM (the minute alone for hourly), or its own cron text. */
export function presetCron(preset: string, time: string, cron: string): string {
  const [hour = "0", minute = "0"] = time.split(":").map((part) => String(Number(part)));
  if (preset === "hourly") return `${minute} * * * *`;
  if (preset === "daily") return `${minute} ${hour} * * *`;
  if (preset === "weekdays") return `${minute} ${hour} * * 1-5`;
  return /^w[0-6]$/.test(preset) ? `${minute} ${hour} * * ${preset.slice(1)}` : cron;
}

/**
 * A schedule as an agent words it, checked and in one form. Nothing more often
 * than hourly: each run is a whole agent session.
 * ponytail: one minute and one hour per schedule; hour lists and steps (9,17 or star-slash-2) need several triggers on Windows, add them when asked.
 */
export function parseWhen(input: string): { ok: true; when: When; cron: string } | { ok: false; error: string } {
  const words = input.trim().toLowerCase().split(/\s+/);
  const done = (when: When) => ({ ok: true as const, when, cron: cronOf(when) });
  const bad = { ok: false as const, error: `unsupported_schedule: ${input.trim()} -- ${usage}` };
  const [first, second, third] = words;
  if (first === "hourly" && words.length === 1) return done({ minute: 0 });
  if (first === "daily" && words.length === 2) {
    const time = at(second);
    return time ? done(time) : bad;
  }
  if (first === "weekdays" && words.length === 2) {
    const time = at(second);
    return time ? done({ ...time, days: [1, 2, 3, 4, 5] }) : bad;
  }
  if (first === "weekly" && words.length === 3) {
    const which = day(second ?? "");
    const time = at(third);
    return which !== undefined && time ? done({ ...time, days: [which] }) : bad;
  }
  if (words.length !== 5) return bad;
  const [minuteField, hourField, dom, month, dow] = words as [string, string, string, string, string];
  const minute = number(minuteField, 59);
  // More than one minute in an hour is more than one run an hour.
  if (minute === undefined) {
    return /[*,/-]/.test(minuteField)
      ? { ok: false, error: `too_often: at most one run an hour -- give the minute as one number (${usage})` }
      : bad;
  }
  const hour = hourField === "*" ? undefined : number(hourField, 23);
  const picked = days(dow);
  if ((hourField !== "*" && hour === undefined) || dom !== "*" || month !== "*" || picked === null) return bad;
  // Every hour on some days only would need a repeating trigger per day on Windows.
  if (hour === undefined && picked !== undefined) return bad;
  return done({ minute, ...(hour === undefined ? {} : { hour }), ...(picked === undefined ? {} : { days: picked }) });
}

/** Where one schedule's files are, in the machine's own forward-slash form. */
export const scheduleDir = (home: string, id: string): string => `${home}/.lepons/schedules/${id}`;

const marker = (id: string) => `# lepons-schedule:${id}`;

/**
 * The crontab line. Through the account's own shell as a login + interactive
 * one, as inLoginShell does: cron's PATH is /usr/bin:/bin, and nvm or Homebrew
 * put claude and codex where only the shell's rc files say. `%` is a newline to
 * cron unless escaped.
 */
export function cronLine(id: string, cron: string, shell: string, darwin = false): string {
  const run = `sh "$HOME/.lepons/schedules/${id}/${darwin ? "launch.sh" : "run.sh"}"`;
  return `${cron} ${posixQuote(shell)} -lic ${posixQuote(run)} </dev/null >/dev/null 2>&1 ${marker(id)}`.replaceAll("%", "\\%");
}

/** A crontab without this schedule's line; every other line kept as it was. */
export function withoutCronLine(crontab: string, id: string): string {
  const kept = crontab.split("\n").filter((line, index, all) => !line.endsWith(` ${marker(id)}`) && !(index === all.length - 1 && line === ""));
  return kept.length === 0 ? "" : `${kept.join("\n")}\n`;
}

/** A crontab with this schedule's line, replacing an earlier one for the same id. */
export function withCronLine(crontab: string, id: string, line: string): string {
  return `${withoutCronLine(crontab, id)}${line}\n`;
}

const launchdLabel = (id: string) => `app.lepons.schedule.${id}`;
const plistPath = (home: string, id: string) => `${home}/Library/LaunchAgents/${launchdLabel(id)}.plist`;
const launchdDomain = "gui/$(id -u)";

/**
 * A Mac's LaunchAgent: launchd is only the trigger, as cron was -- the login
 * shell starts launch.sh, which hands the run to tmux (macLauncher). launchd
 * needs this beside, not in, the user's own crontab, which Lepons then leaves alone.
 */
export function launchdPlist(id: string, when: When): string {
  const fields = (day?: number) =>
    `<dict>${day === undefined ? "" : `<key>Weekday</key><integer>${day}</integer>`}` +
    `${when.hour === undefined ? "" : `<key>Hour</key><integer>${when.hour}</integer>`}<key>Minute</key><integer>${when.minute}</integer></dict>`;
  const interval = when.days ? `<array>${when.days.map(fields).join("")}</array>` : fields();
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${launchdLabel(id)}</string>
<key>ProgramArguments</key><array><string>/bin/zsh</string><string>-lic</string><string>sh "$HOME/.lepons/schedules/${id}/launch.sh"</string></array>
<key>StartCalendarInterval</key>${interval}
</dict></plist>
`;
}

/** Run logs kept per schedule; older ones are pruned at the end of each run. */
export const KEEP_LOGS = 50;

/** After the limit, how long a run's processes get to stop on TERM before KILL. */
const GRACE_S = 30;

/**
 * A lock older than this is a crash's or a reboot's: past the shared budget and
 * its grace with room to spare. A run suspended with its machine asleep can
 * outlast it, which is why a run removes the lock only while it still holds it.
 */
const STALE_LOCK_MIN = 45;

/**
 * Runs its command in a process group of its own and, at the deadline, sends
 * the whole group TERM, then KILL after the grace -- an agent's own children
 * (tool runs, MCP servers) included. Exits 124 on a timeout, as timeout(1) does.
 * Single quotes are not used, so it sits inside sh's single quotes as is.
 */
const PERL_LIMIT =
  "my $t = shift; my $pid = fork; defined $pid or exit 126; " +
  "if (!$pid) { setpgrp(0, 0); exec @ARGV or exit 127 } " +
  `my $late = 0; $SIG{ALRM} = sub { $late = 1; kill "TERM", -$pid; for (1..${GRACE_S}) { sleep 1; kill(0, -$pid) or return } kill "KILL", -$pid }; ` +
  "alarm $t; waitpid($pid, 0); my $s = $?; alarm 0; " +
  "exit($late ? 124 : $s & 127 ? 128 + ($s & 127) : $s >> 8)";

/** The tmux session a Mac's run goes in; one by this name is a run under way. */
export const runSession = (id: string): string => `lepons-run-${id}`;

/** last.json's reason for a Mac run that could not start: no tmux server to start it in. */
export const NO_SESSION = "no-session";

/**
 * A Mac's launch.sh, which cron starts instead of run.sh. Under cron (and
 * launchd) a process cannot see the login keychain, where Claude Code keeps its
 * sign-in, and `claude -p` waits forever. A session that the tmux server Lepons
 * started over SSH makes can see it, so the run goes there -- and with no tmux
 * server (the Mac restarted, and Lepons has not connected since) it does not
 * start, and last.json says why.
 * ponytail: needs a tmux server left from a Lepons connection; a LaunchAgent in the user's Aqua session would not, if one is ever made to reach the keychain.
 */
export function macLauncher(id: string): string {
  const session = runSession(id);
  return `#!/bin/sh
# Lepons schedule ${id} on macOS. cron starts this through the account's login shell, so tmux is on the PATH.
dir="$HOME/.lepons/schedules/${id}"
if ! tmux list-sessions >/dev/null 2>&1; then
  mkdir -p "$dir/runs"
  now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  log="$dir/runs/$(date -u +%Y%m%dT%H%M%SZ).log"
  echo "lepons: not run -- no tmux server on this Mac (no Lepons connection since it started), and an agent started by cron cannot reach the keychain" >>"$log"
  tail -n 20 "$log" >"$dir/tail.txt" 2>/dev/null
  printf '{"startedAt":"%s","endedAt":"%s","exitCode":0,"skipped":true,"reason":"${NO_SESSION}"}\\n' "$now" "$now" >"$dir/last.json.tmp" && mv "$dir/last.json.tmp" "$dir/last.json"
  exit 0
fi
# A session by this name is a run under way: one at a time, as run.sh's lock.
tmux has-session -t '=${session}' 2>/dev/null && exit 0
# The session ends with run.sh, even where tmux is set to keep dead panes.
tmux new-session -d -s '${session}' "sh '$dir/run.sh'" \\; set-option -w -t '=${session}' remain-on-exit off
`;
}

/** The POSIX runner, run.sh. */
export function posixRunner(id: string, folder: string, command: string): string {
  return `#!/bin/sh
# Lepons schedule ${id}. cron starts this through the account's login shell.
dir="$HOME/.lepons/schedules/${id}"
mkdir -p "$dir/runs" || exit 1
# One run at a time. mkdir is atomic everywhere (flock is not on macOS). A lock
# older than any run is taken over, by one run only: the rename succeeds once.
if ! mkdir "$dir/lock" 2>/dev/null; then
  [ -n "$(find "$dir/lock" -maxdepth 0 -mmin +${STALE_LOCK_MIN} 2>/dev/null)" ] && mv "$dir/lock" "$dir/lock.$$" 2>/dev/null || exit 0
  rm -rf "$dir/lock.$$"
  mkdir "$dir/lock" 2>/dev/null || exit 0
fi
# The lock goes when this run ends, but only while it is still this run's.
token="$$.$(date +%s)"
echo "$token" >"$dir/lock/owner"
trap '[ "$(cat "$dir/lock/owner" 2>/dev/null)" = "$token" ] && rm -rf "$dir/lock"' EXIT
trap 'exit 143' HUP INT TERM
# The precheck and the agent share one budget of ${RUN_LIMIT_S / 60} minutes. Each runs in its own
# process group, which at the limit gets TERM, then KILL ${GRACE_S} s later: GNU timeout -k
# does that, perl where there is no GNU timeout (macOS).
deadline=$(( $(date +%s) + ${RUN_LIMIT_S} ))
limit() {
  input=$1
  shift
  left=$(( deadline - $(date +%s) ))
  [ "$left" -gt 0 ] || return 124
  if timeout --version >/dev/null 2>&1; then
    timeout -k ${GRACE_S} "$left" "$@" <"$input"
  else
    perl -e '${PERL_LIMIT}' "$left" "$@" <"$input"
  fi
}
started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
log="$dir/runs/$(date -u +%Y%m%dT%H%M%SZ).log"
code=0
skipped=false
if ! cd ${posixQuote(folder)} 2>>"$log"; then
  code=1
elif [ -s "$dir/precheck.sh" ]; then
  limit /dev/null sh "$dir/precheck.sh" >>"$log" 2>&1
  code=$?
  [ "$code" -eq 0 ] || skipped=true
fi
if [ "$code" -eq 0 ]; then
  limit "$dir/instructions.txt" sh -c ${posixQuote(command)} >>"$log" 2>&1
  code=$?
fi
# tail.txt before last.json: whoever sees a new last.json finds its tail already there.
tail -n 20 "$log" >"$dir/tail.txt" 2>/dev/null
printf '{"startedAt":"%s","endedAt":"%s","exitCode":%d,"skipped":%s}\\n' "$started" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$code" "$skipped" >"$dir/last.json.tmp" && mv "$dir/last.json.tmp" "$dir/last.json"
# The newest ${KEEP_LOGS} logs stay. Their names are UTC times, so name order is age.
ls "$dir/runs" | sort -r | tail -n +${KEEP_LOGS + 1} | while read -r old; do rm -f "$dir/runs/$old"; done
`;
}

/**
 * A PowerShell single-quoted string. PowerShell takes the curly quotes
 * U+2018-U+201B for ' too, so they are doubled as well, or a folder named
 * Bob\u2019s would end the string early.
 */
export const psQuote = (text: string): string => `'${text.replace(/['\u2018\u2019\u201A\u201B]/g, "$&$&")}'`;

/**
 * Windows PowerShell 5.1 reads a .ps1 without a byte-order mark in the ANSI
 * code page, which would garble a Korean folder name.
 */
const BOM = "\uFEFF";

/**
 * The Windows runner, run.ps1. cmd.exe runs the agent so its output reaches
 * the log as the agent's own UTF-8 bytes (PowerShell 5.1's redirection would
 * write UTF-16). taskkill /t /f ends the whole tree under that cmd.exe at the
 * limit -- the agent and whatever it started -- by force; Windows has no TERM
 * to send first. The precheck and the agent share one budget, as on POSIX.
 */
export function windowsRunner(id: string, folder: string, command: string): string {
  return `${BOM}# Lepons schedule ${id}. Task Scheduler starts this.
$dir = $PSScriptRoot
$null = New-Item -ItemType Directory -Force (Join-Path $dir 'runs')
# One run at a time: a file held open unshared, which Windows lets go of however this process ends.
try { $lock = [IO.File]::Open((Join-Path $dir 'lock'), 'OpenOrCreate', 'ReadWrite', 'None') } catch { exit 0 }
$started = [DateTime]::UtcNow.ToString('o')
$deadline = [DateTime]::UtcNow.AddSeconds(${RUN_LIMIT_S})
$log = Join-Path $dir ('runs\\' + [DateTime]::UtcNow.ToString('yyyyMMdd\\THHmmss\\Z') + '.log')
$code = 0
$skipped = $false
function Invoke-Logged([string]$line) {
  $left = [int]($deadline - [DateTime]::UtcNow).TotalMilliseconds
  if ($left -le 0) { return 124 }
  $info = New-Object Diagnostics.ProcessStartInfo 'cmd.exe', ('/d /s /c "' + $line + ' >> "' + $log + '" 2>&1"')
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  $run = [Diagnostics.Process]::Start($info)
  if ($run.WaitForExit($left)) { return $run.ExitCode }
  taskkill.exe /pid $run.Id /t /f | Out-Null
  return 124
}
try { Set-Location -LiteralPath ${psQuote(folder)} -ErrorAction Stop } catch { $code = 1; [IO.File]::AppendAllText($log, "$_\`r\`n") }
if ($code -eq 0 -and (Get-Item -LiteralPath (Join-Path $dir 'precheck.ps1') -ErrorAction SilentlyContinue).Length -gt 0) {
  $code = Invoke-Logged ('powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + (Join-Path $dir 'precheck.ps1') + '"')
  if ($code -ne 0) { $skipped = $true }
}
if ($code -eq 0) {
  $code = Invoke-Logged (${psQuote(command)} + ' < "' + (Join-Path $dir 'instructions.txt') + '"')
}
# tail.txt before last.json: whoever sees a new last.json finds its tail already there. Both UTF-8 without a BOM.
[IO.File]::WriteAllLines((Join-Path $dir 'tail.txt'), [string[]]@(Get-Content -LiteralPath $log -Tail 20 -Encoding UTF8 -ErrorAction SilentlyContinue))
$last = '{"startedAt":"' + $started + '","endedAt":"' + [DateTime]::UtcNow.ToString('o') + '","exitCode":' + $code + ',"skipped":' + $skipped.ToString().ToLower() + '}'
[IO.File]::WriteAllText((Join-Path $dir 'last.json'), $last)
# The newest ${KEEP_LOGS} logs stay. Their names are UTC times, so name order is age.
Get-ChildItem -LiteralPath (Join-Path $dir 'runs') -Filter '*.log' | Sort-Object Name -Descending | Select-Object -Skip ${KEEP_LOGS} | Remove-Item -Force
$lock.Close()
`;
}

/**
 * The precheck as precheck.ps1. It fails as a shell command would: by its exit
 * code, a native command's non-zero one, an error ($? false), or -- what
 * PowerShell checks print rather than exit with -- a last output of False,
 * as Test-Path gives for a path that is not there.
 */
export function windowsPrecheck(precheck: string): string {
  return [
    `${BOM}$global:LASTEXITCODE = 0`,
    // Its output reaches the log through cmd.exe as bytes: UTF-8, as the agent's is, not the console's code page.
    "[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)",
    "$Error.Clear()",
    "$out = & {",
    precheck,
    "}",
    // $? only speaks for the block's last command; an error anywhere in it is in $Error.
    "$ok = $? -and $Error.Count -eq 0",
    "$out",
    "$last = @($out) | Select-Object -Last 1",
    "if (-not $ok -or $LASTEXITCODE -ne 0 -or ($last -is [bool] -and -not $last)) { exit 1 }",
    "exit 0",
    "",
  ].join("\r\n");
}

function windowsTrigger(when: When): string {
  const time = (hour: number) => psQuote(`${String(hour).padStart(2, "0")}:${String(when.minute).padStart(2, "0")}`);
  // An explicit end: Windows PowerShell 5.1 takes 9999 days, and refuses [TimeSpan]::MaxValue as out of range (seen on Windows 11).
  if (when.hour === undefined) return `New-ScheduledTaskTrigger -Once -At ${time(0)} -RepetitionInterval (New-TimeSpan -Hours 1) -RepetitionDuration (New-TimeSpan -Days 9999)`;
  if (when.days === undefined) return `New-ScheduledTaskTrigger -Daily -At ${time(when.hour)}`;
  return `New-ScheduledTaskTrigger -Weekly -DaysOfWeek ${when.days.map((each) => windowsDays[each]).join(",")} -At ${time(when.hour)}`;
}

/**
 * How a Windows task runs: "s4u" whether or not anyone is signed in (no
 * password stored, no network shares), which Windows grants an elevated
 * administrator only; "interactive" only while this account is signed in,
 * which any account may register.
 */
export type WindowsLogon = "s4u" | "interactive";

/**
 * The Task Scheduler registration: \Lepons\<id>, as this account, S4U or interactive.
 * ponytail: Task Scheduler runs only while the machine is on and awake; a time it
 * missed runs once it is back (StartWhenAvailable). Wake timers would need the
 * owner's power settings, so they are left alone.
 */
export function windowsRegister(id: string, when: When, runner: string, logon: WindowsLogon = "s4u"): string {
  const argument = `-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "${runner}"`;
  return [
    "$ErrorActionPreference = 'Stop'",
    `$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ${psQuote(argument)}`,
    `$trigger = ${windowsTrigger(when)}`,
    `$principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType ${logon === "s4u" ? "S4U" : "Interactive"} -RunLevel Limited`,
    // A backstop past the runner's own limit, for a runner that hangs before it.
    `$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes ${RUN_LIMIT_S / 60 + 10})`,
    `Register-ScheduledTask -TaskPath '\\Lepons\\' -TaskName ${psQuote(id)} -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null`,
  ].join("\n");
}

/** Takes the task and its folder away; a task already gone is not an error. */
export function windowsUnregister(id: string, dir: string): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    `if (Get-ScheduledTask -TaskPath '\\Lepons\\' -TaskName ${psQuote(id)} -ErrorAction SilentlyContinue) { Unregister-ScheduledTask -TaskPath '\\Lepons\\' -TaskName ${psQuote(id)} -Confirm:$false }`,
    `if (Test-Path -LiteralPath ${psQuote(dir)}) { Remove-Item -LiteralPath ${psQuote(dir)} -Recurse -Force }`,
    // Empty folders go, full ones stay: the task folder when it holds no task, the schedules folder when no schedule is left.
    `$parent = Split-Path -Parent ${psQuote(dir)}`,
    "if ((Test-Path -LiteralPath $parent) -and -not (Get-ChildItem -LiteralPath $parent -Force)) { Remove-Item -LiteralPath $parent -Force }",
    "try { $svc = New-Object -ComObject Schedule.Service; $svc.Connect(); $f = $svc.GetFolder('\\Lepons'); if ($f.GetTasks(0).Count -eq 0 -and $f.GetFolders(0).Count -eq 0) { $svc.GetFolder('\\').DeleteFolder('Lepons', 0) } } catch { }",
  ].join("\n");
}

/**
 * A PowerShell script as one command line. Encoded, so it reads the same to
 * cmd.exe (this PC) and to Git Bash (a Windows PC over SSH): base64 has nothing
 * either would expand.
 */
export const powershellLine = (script: string): string =>
  `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(script, "utf16le").toString("base64")}`;

/** A Windows path with backslashes, as cmd.exe and Task Scheduler expect. */
const backslashed = (path: string): string => path.replaceAll("/", "\\");

/** A run as last.json records it. */
export interface LastRun {
  startedAt: string;
  endedAt: string;
  exitCode: number;
  skipped: boolean;
  /** Why a skipped run did not start, when it was not its precheck: NO_SESSION. */
  reason?: string;
}

export function parseLastRun(text: string | undefined): LastRun | undefined {
  try {
    const value = JSON.parse((text ?? "").replace(/^\uFEFF/, "")) as Partial<LastRun>;
    return typeof value.startedAt === "string" && typeof value.exitCode === "number"
      ? {
          startedAt: value.startedAt, endedAt: String(value.endedAt ?? ""), exitCode: value.exitCode, skipped: value.skipped === true,
          ...(typeof value.reason === "string" ? { reason: value.reason } : {}),
        }
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * What a schedule is, as schedule.json keeps it on its machine: the one place
 * it is written down. Lists and the edit form read it back from there.
 */
export interface ScheduleInfo {
  name: string;
  folder: string;
  cron: string;
  executor: string;
  /** A command run first in the folder (sh, or PowerShell on Windows); a non-zero exit skips the run. */
  precheck?: string;
  /** Its crontab line is commented out, or its task disabled. */
  paused?: boolean;
  /** On Windows, how its task runs (WindowsLogon). */
  windowsLogon?: WindowsLogon;
  /** A Mac, found at install: cron starts launch.sh, which runs it in tmux (macLauncher). */
  darwin?: true;
}

/** One schedule to put on a machine, new or edited (the same id rewrites it). */
export interface ScheduleSpec extends ScheduleInfo {
  id: string;
  when: When;
  /** The agent's headless line (agents[kind].can.delegate). */
  command: string;
  instructions: string;
}

export type ScheduleMachine = Pick<Machine, "windows" | "run" | "makeDirs" | "overwrite" | "readText" | "list" | "read">;
type Done = { ok: true } | { ok: false; error: string };

/** schedule.json's text for a spec, with how Windows ended up running it. */
export function scheduleInfo(spec: ScheduleSpec, windowsLogon?: WindowsLogon, darwin = false): string {
  const info: ScheduleInfo = {
    name: spec.name, folder: spec.folder, cron: spec.cron, executor: spec.executor,
    ...(spec.precheck ? { precheck: spec.precheck } : {}), ...(spec.paused ? { paused: true } : {}),
    ...(windowsLogon ? { windowsLogon } : {}), ...(darwin ? { darwin: true as const } : {}),
  };
  return JSON.stringify(info);
}

/**
 * The files one schedule needs besides schedule.json, by name. The precheck file is always written,
 * empty when there is none, so an edit that drops it leaves nothing behind to run.
 */
export function scheduleFiles(spec: ScheduleSpec, windows: boolean): Record<string, string> {
  return windows
    ? {
        "instructions.txt": spec.instructions,
        "run.ps1": windowsRunner(spec.id, spec.folder, spec.command),
        "precheck.ps1": spec.precheck ? windowsPrecheck(spec.precheck) : "",
      }
    : {
        "instructions.txt": spec.instructions,
        "run.sh": posixRunner(spec.id, spec.folder, spec.command),
        "precheck.sh": spec.precheck ? `${spec.precheck}\n` : "",
      };
}

export async function readCrontab(machine: Pick<Machine, "run">): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  const listed = await machine.run("crontab -l");
  if (!listed) return { ok: false, error: "unreachable: could not reach that machine" };
  if (listed.code === 0) return { ok: true, text: listed.output };
  // An account with no crontab yet; any other failure must not read as empty, or writing back would wipe it.
  if (/no crontab/i.test(listed.output)) return { ok: true, text: "" };
  return { ok: false, error: `crontab_failed: ${listed.output.trim() || `exit ${listed.code}`}` };
}

export async function writeCrontab(machine: Pick<Machine, "run">, text: string): Promise<Done> {
  const wrote = await machine.run(`printf '%s' ${posixQuote(text)} | crontab -`);
  return wrote?.code === 0 ? { ok: true } : { ok: false, error: `crontab_failed: ${wrote?.output.trim() || "unreachable"}` };
}

/** An older Mac install's crontab line goes; only a line with this schedule's marker, never the user's own. */
async function dropCronLine(machine: ScheduleMachine, id: string): Promise<Done> {
  const current = await readCrontab(machine);
  if (!current.ok) return current;
  if (!current.text.split("\n").some((line) => line.endsWith(` ${marker(id)}`))) return { ok: true };
  return writeCrontab(machine, withoutCronLine(current.text, id));
}

/** Writes the plist, then loads it, or leaves it unloaded and disabled (so a login does not load it) when paused. */
async function launchdSet(machine: ScheduleMachine, home: string, id: string, when: When, paused: boolean): Promise<Done> {
  const path = plistPath(home, id);
  try {
    await machine.makeDirs(`${home}/Library/LaunchAgents`);
  } catch (error) {
    return { ok: false, error: `write_failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  const wrote = await machine.overwrite(path, launchdPlist(id, when));
  if (!wrote.ok) return { ok: false, error: `write_failed: ${id}.plist: ${wrote.detail ?? wrote.reason}` };
  const target = `${launchdDomain}/${launchdLabel(id)}`;
  // Out first, so a reload takes the new time; it fails harmlessly when it was not loaded.
  await machine.run(`launchctl bootout ${target} 2>/dev/null; true`);
  // bootout is asynchronous: a bootstrap right after it can fail with I/O error 5, so one retry.
  const boot = `launchctl bootstrap ${launchdDomain} ${posixQuote(path)}`;
  const ran = await machine.run(paused ? `launchctl disable ${target}` : `launchctl enable ${target} && { ${boot} || { sleep 1; ${boot}; }; }`);
  return ran?.code === 0 ? { ok: true } : { ok: false, error: `launchd_failed: ${ran?.output.trim() || "unreachable"}` };
}

const powershell = async (machine: ScheduleMachine, script: string): Promise<Done> => {
  const ran = await machine.run(powershellLine(script));
  if (ran?.code === 0) return { ok: true };
  // A non-admin, or an admin's PowerShell that is not elevated, gets this for an S4U task (Windows 11, 2026-11-24).
  if (/access is denied|0x80070005|액세스가 거부|拒绝访问/i.test(ran?.output ?? "")) return { ok: false, error: TASK_DENIED };
  return { ok: false, error: `task_scheduler_failed: ${ran?.output.trim() || "unreachable"}` };
};

export const TASK_DENIED =
  "task_scheduler_denied: Windows would not let this account register the task. " +
  "A task that runs while signed out (S4U) takes an elevated administrator on that Windows PC.";

/**
 * Puts a schedule on a machine, or rewrites one with the same id -- after
 * `approve` says yes, and not a byte before. `home` is the account's home in
 * the machine's forward-slash form. A paused schedule stays paused. The
 * writing goes through `serial`, which the caller makes one-at-a-time per
 * machine: crontab is read, changed and written whole.
 * ponytail: that order holds within this Lepons only; a crontab edited by hand in the same second can still lose a line.
 */
export async function installSchedule(
  machine: ScheduleMachine, home: string, spec: ScheduleSpec, approve: () => Promise<boolean>,
  serial: (work: () => Promise<Installed>) => Promise<Installed> = (work) => work(),
): Promise<Installed> {
  if (!(await approve())) return { ok: false, error: "refused" };
  return serial(() => writeSchedule(machine, home, spec));
}

/** How an install ended; on Windows, how its task runs. */
export type Installed = { ok: true; windowsLogon?: WindowsLogon } | { ok: false; error: string };

/**
 * The files, then the scheduler, then schedule.json last: a schedule is
 * listed once its scheduler has it. On Windows an S4U task is tried first; when
 * Windows denies it, the same task runs only while this account is signed in --
 * a schedule that works some of the time rather than none. An edit tries S4U
 * again; a resume keeps the task as it is.
 */
async function writeSchedule(machine: ScheduleMachine, home: string, spec: ScheduleSpec): Promise<Installed> {
  const dir = scheduleDir(home, spec.id);
  try {
    await machine.makeDirs(dir);
  } catch (error) {
    return { ok: false, error: `write_failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  // A POSIX machine's shell, as cron will not know it (cron's SHELL is /bin/sh), and whether it is a Mac.
  const posix = machine.windows ? undefined : (await machine.run(`printf '%s\\n%s' "$SHELL" "$(uname -s)"`))?.output.trim().split("\n");
  const shell = posix?.[0]?.trim() || "/bin/sh";
  const darwin = posix?.[1]?.trim() === "Darwin";
  const files = { ...scheduleFiles(spec, machine.windows), ...(darwin ? { "launch.sh": macLauncher(spec.id) } : {}) };
  for (const [name, contents] of Object.entries(files)) {
    const wrote = await machine.overwrite(`${dir}/${name}`, contents);
    if (!wrote.ok) return { ok: false, error: `write_failed: ${name}: ${wrote.detail ?? wrote.reason}` };
  }
  const info = async (windowsLogon?: WindowsLogon): Promise<Installed> => {
    const wrote = await machine.overwrite(`${dir}/schedule.json`, scheduleInfo(spec, windowsLogon, darwin));
    if (!wrote.ok) return { ok: false, error: `write_failed: schedule.json: ${wrote.detail ?? wrote.reason}` };
    return windowsLogon ? { ok: true, windowsLogon } : { ok: true };
  };
  if (machine.windows) {
    const register = (logon: WindowsLogon) => {
      const script = windowsRegister(spec.id, spec.when, backslashed(`${dir}/run.ps1`), logon);
      return powershell(machine, spec.paused ? `${script}\n${windowsPause(spec.id, true)}` : script);
    };
    let logon: WindowsLogon = "s4u";
    let done = await register(logon);
    if (!done.ok && done.error === TASK_DENIED) done = await register(logon = "interactive");
    return done.ok ? info(logon) : done;
  }
  if (darwin) {
    // The old crontab line goes first: if that fails nothing is loaded, so only the old trigger fires, never both.
    const moved = await dropCronLine(machine, spec.id);
    if (!moved.ok) return moved;
    const loaded = await launchdSet(machine, home, spec.id, spec.when, spec.paused === true);
    return loaded.ok ? info() : loaded;
  }
  const current = await readCrontab(machine);
  if (!current.ok) return current;
  const line = cronLine(spec.id, spec.cron, shell, darwin);
  const wrote = await writeCrontab(machine, withCronLine(current.text, spec.id, spec.paused ? `#${line}` : line));
  return wrote.ok ? info() : wrote;
}

/** A crontab with this schedule's line commented out (paused) or not; every other line as it was. */
export function withCronPaused(crontab: string, id: string, paused: boolean): string {
  return crontab.split("\n").map((line) => {
    if (!line.endsWith(` ${marker(id)}`)) return line;
    const bare = line.replace(/^#+/, "");
    return paused ? `#${bare}` : bare;
  }).join("\n");
}

/** Turns a task off or on again, keeping it. */
export function windowsPause(id: string, paused: boolean): string {
  return `${paused ? "Disable" : "Enable"}-ScheduledTask -TaskPath '\\Lepons\\' -TaskName ${psQuote(id)} | Out-Null`;
}

/** Pauses or resumes: the crontab line or the task first, then schedule.json says so. */
export async function setPaused(machine: ScheduleMachine, home: string, id: string, paused: boolean): Promise<Done> {
  const dir = scheduleDir(home, id);
  const read = await machine.readText(`${dir}/schedule.json`);
  const info = read.ok ? parseInfo(read.contents) : undefined;
  if (!info) return { ok: false, error: read.ok ? `unknown_schedule: ${id} is not on that machine` : "unreachable: could not reach that machine" };
  if (machine.windows) {
    const done = await powershell(machine, `$ErrorActionPreference = 'Stop'\n${windowsPause(id, paused)}`);
    if (!done.ok) return done;
  } else if (info.darwin) {
    const parsed = parseWhen(info.cron);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    const moved = await dropCronLine(machine, id);
    if (!moved.ok) return moved;
    const set = await launchdSet(machine, home, id, parsed.when, paused);
    if (!set.ok) return set;
  } else {
    const current = await readCrontab(machine);
    if (!current.ok) return current;
    const wrote = await writeCrontab(machine, withCronPaused(current.text, id, paused));
    if (!wrote.ok) return wrote;
  }
  const { paused: _was, ...rest } = info;
  const saved = await machine.overwrite(`${dir}/schedule.json`, JSON.stringify(paused ? { ...rest, paused: true } : rest));
  return saved.ok ? { ok: true } : { ok: false, error: `write_failed: schedule.json: ${saved.detail ?? saved.reason}` };
}

/** Takes a schedule off a machine: its crontab line or task, then its folder and logs. */
export async function removeSchedule(machine: ScheduleMachine, home: string, id: string): Promise<Done> {
  const dir = scheduleDir(home, id);
  if (machine.windows) return powershell(machine, windowsUnregister(id, backslashed(dir)));
  const darwin = (await machine.run("uname -s"))?.output.trim() === "Darwin";
  const current = await readCrontab(machine);
  // On a Mac the crontab is cleanup of an older install only; one that cannot be read must not keep the schedule from going.
  if (!current.ok && !darwin) return current;
  if (current.ok && current.text.split("\n").some((line) => line.endsWith(` ${marker(id)}`))) {
    const wrote = await writeCrontab(machine, withoutCronLine(current.text, id));
    if (!wrote.ok && !darwin) return wrote;
  }
  // By the machine or the plist, not schedule.json, which may be gone or broken: a loaded agent must not outlive launch.sh.
  const plist = posixQuote(plistPath(home, id));
  const target = `${launchdDomain}/${launchdLabel(id)}`;
  await machine.run(`if [ "$(uname -s)" = Darwin ] || [ -e ${plist} ]; then launchctl bootout ${target} 2>/dev/null; launchctl enable ${target} 2>/dev/null; rm -f ${plist}; fi`);
  // rmdir takes the schedules folder only when this was its last schedule.
  const removed = await machine.run(`rm -rf ${posixQuote(dir)} && { rmdir ${posixQuote(`${home}/.lepons/schedules`)} 2>/dev/null; true; }`);
  return removed?.code === 0 ? { ok: true } : { ok: false, error: `remove_failed: ${removed?.output.trim() || "unreachable"}` };
}

export function parseInfo(text: string | undefined): ScheduleInfo | undefined {
  try {
    const value = JSON.parse((text ?? "").replace(/^\uFEFF/, "")) as Partial<ScheduleInfo>;
    return typeof value.name === "string" && typeof value.folder === "string" && typeof value.cron === "string" && typeof value.executor === "string"
      ? (value as ScheduleInfo)
      : undefined;
  } catch {
    return undefined;
  }
}

/** One schedule as its machine has it now. */
export interface ScheduleRead {
  info: ScheduleInfo | undefined;
  instructions: string;
  last: LastRun | undefined;
  /** The end of the latest run's output. */
  tail: string;
}

/** Reads a schedule back from its machine; undefined when the machine could not be read, `info` undefined when it is not there. */
export async function readSchedule(machine: ScheduleMachine, home: string, id: string): Promise<ScheduleRead | undefined> {
  const dir = scheduleDir(home, id);
  const text = async (name: string) => {
    const read = await machine.readText(`${dir}/${name}`);
    return read.ok ? (read.contents ?? "") : undefined;
  };
  const [info, instructions, last, tail] = await Promise.all(["schedule.json", "instructions.txt", "last.json", "tail.txt"].map(text));
  if (info === undefined) return undefined;
  return { info: parseInfo(info), instructions: instructions ?? "", last: parseLastRun(last), tail: tail ?? "" };
}

/** The run logs' names, newest first (they are named by their UTC start). */
export async function runLogs(machine: ScheduleMachine, home: string, id: string): Promise<string[]> {
  const listed = await machine.list(`${scheduleDir(home, id)}/runs`);
  return listed.ok ? listed.entries.filter((entry) => !entry.isDirectory && entry.name.endsWith(".log")).map((entry) => entry.name).sort().reverse() : [];
}

/** How much of one run's log is brought over: its end, which is where an agent's answer is. */
const LOG_BYTES = 512 * 1024;

/** One run's log, its last 512KB when longer; undefined when it cannot be read. */
export async function runLog(machine: ScheduleMachine, home: string, id: string, name: string): Promise<string | undefined> {
  if (!/^[\w.-]+\.log$/.test(name)) return undefined;
  // ponytail: a log over 4MB is not shown at all; read its end alone if agents ever print that much.
  const bytes = await machine.read(`${scheduleDir(home, id)}/runs/${name}`, 8 * LOG_BYTES);
  return bytes === undefined ? undefined : bytes.subarray(Math.max(0, bytes.length - LOG_BYTES)).toString("utf8");
}

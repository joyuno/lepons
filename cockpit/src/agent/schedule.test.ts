import { test } from "node:test";
import assert from "node:assert/strict";

import {
  cronLine, installSchedule, parseLastRun, parseWhen, posixRunner, presetCron, presetOf, powershellLine, readSchedule, removeSchedule, runLog, runLogs, scheduleFiles,
  launchdPlist, macLauncher, MAX_SCHEDULE_TEXT, NO_SESSION, runSession, scheduleTextProblem, setPaused, TASK_DENIED, windowsPause, windowsPrecheck, windowsRegister, windowsRunner, windowsUnregister, withCronLine, withCronPaused, withoutCronLine,
  type ScheduleMachine, type ScheduleSpec,
} from "./schedule.ts";

const cron = (when: string) => {
  const parsed = parseWhen(when);
  return parsed.ok ? parsed.cron : parsed.error.split(":")[0];
};

test("presets and the supported cron come out as one cron form", () => {
  assert.equal(cron("hourly"), "0 * * * *");
  assert.equal(cron("daily 7:05"), "5 7 * * *");
  assert.equal(cron("Weekdays 09:00"), "0 9 * * 1,2,3,4,5");
  assert.equal(cron("weekly fri 18:30"), "30 18 * * 5");
  assert.equal(cron("weekly Sunday 08:00"), "0 8 * * 0");
  assert.equal(cron("15 * * * *"), "15 * * * *");
  assert.equal(cron("0 9 * * mon-fri"), "0 9 * * 1,2,3,4,5");
  assert.equal(cron("0 9 * * 7,1"), "0 9 * * 0,1", "7 is Sunday too");
  assert.equal(cron("0 9 * * 0-6"), "0 9 * * *", "every day is *");
  assert.equal(cron("0 9 * * 0-7"), "0 9 * * *", "0-7 is every day too: 7 is Sunday at a range's end");
  assert.equal(cron("0 9 * * 5-7"), "0 9 * * 0,5,6");
  assert.equal(cron("0 9 * * fri-sun"), "0 9 * * 0,5,6");
});

test("the settings form's choices go to cron and back", () => {
  for (const [preset, time, expected] of [
    ["hourly", "00:15", "15 * * * *"], ["daily", "07:05", "5 7 * * *"], ["weekdays", "09:00", "0 9 * * 1-5"], ["w5", "18:30", "30 18 * * 5"],
  ] as const) {
    assert.equal(presetCron(preset, time, ""), expected);
    const parsed = parseWhen(expected);
    assert.ok(parsed.ok);
    assert.equal(presetOf(parsed.when), preset);
  }
  assert.equal(presetCron("cron", "09:00", "0 9 * * 1,3"), "0 9 * * 1,3");
  const twoDays = parseWhen("0 9 * * 1,3");
  assert.ok(twoDays.ok);
  assert.equal(presetOf(twoDays.when), "cron");
});

test("more often than hourly, or what Task Scheduler could not say the same way, is refused", () => {
  for (const when of ["*/5 * * * *", "0,30 * * * *", "* 9 * * *", "0-10 9 * * *"]) assert.equal(cron(when), "too_often", when);
  for (const when of ["", "daily", "daily 24:00", "daily 9:60", "weekly 9:00", "weekly xyz 9:00", "0 9,17 * * *", "0 */2 * * *",
    "0 9 1 * *", "0 9 * 1 *", "0 * * * 1", "0 9 * * 5-1", "0 9 * * *  extra", "every minute"]) {
    assert.equal(cron(when), "unsupported_schedule", when);
  }
});

test("a crontab gains and loses only this schedule's line", () => {
  const line = cronLine("s-1", "0 9 * * 1,2,3,4,5", "/bin/zsh");
  assert.equal(line, `0 9 * * 1,2,3,4,5 '/bin/zsh' -lic 'sh "$HOME/.lepons/schedules/s-1/run.sh"' </dev/null >/dev/null 2>&1 # lepons-schedule:s-1`);
  assert.match(cronLine("s-1", "0 * * * *", "/opt/100%/sh"), /100\\%/, "cron reads a bare % as a newline");

  const theirs = "MAILTO=me\n# keep me\n30 2 * * * backup.sh\n";
  const added = withCronLine(theirs, "s-1", line);
  assert.equal(added, `${theirs}${line}\n`);
  assert.equal(withCronLine(added, "s-1", line), added, "the same id replaces its line, never adds a second");
  const both = withCronLine(added, "s-2", cronLine("s-2", "0 * * * *", "/bin/bash"));
  assert.equal(withoutCronLine(both, "s-2"), added);
  assert.equal(withoutCronLine(both, "s-1").includes("s-1"), false);
  assert.equal(withoutCronLine(added, "s-1"), theirs);
  assert.equal(withoutCronLine("30 2 * * * backup.sh", "s-1"), "30 2 * * * backup.sh\n", "a crontab without a final newline gets one");
  assert.equal(withCronLine("", "s-1", line), `${line}\n`);
  assert.equal(withoutCronLine(`${line}\n`, "s-1"), "");
  // A line that only mentions the id elsewhere is someone else's.
  assert.equal(withoutCronLine("0 1 * * * echo '# lepons-schedule:s-1 note'\n", "s-1"), "0 1 * * * echo '# lepons-schedule:s-1 note'\n");
});

test("the POSIX runner locks, limits, honours the precheck and records the run", () => {
  const script = posixRunner("s-1", "/srv/it's", "claude -p");
  assert.match(script, /^#!\/bin\/sh\n/);
  assert.match(script, /mkdir "\$dir\/lock"/);
  assert.match(script, /cd '\/srv\/it'\\''s'/);
  // One budget for both, and the whole process group killed at its end: TERM, then KILL.
  assert.match(script, /deadline=\$\(\( \$\(date \+%s\) \+ 1800 \)\)/);
  assert.match(script, /timeout -k 30 "\$left" "\$@" <"\$input"/);
  assert.match(script, /setpgrp\(0, 0\)/);
  assert.match(script, /kill "TERM", -\$pid; for \(1\.\.30\)/);
  assert.match(script, /kill "KILL", -\$pid/);
  assert.equal(script.match(/perl -e '([^']*)'/)?.[1]?.includes("'"), false, "the perl text sits inside sh's single quotes");
  assert.match(script, /limit \/dev\/null sh "\$dir\/precheck.sh" >>"\$log" 2>&1\n\s*code=\$\?\n\s*\[ "\$code" -eq 0 \] \|\| skipped=true/);
  assert.match(script, /limit "\$dir\/instructions.txt" sh -c 'claude -p' >>"\$log" 2>&1/);
  // A lock is taken over past the longest run, by one run, and let go of only by the run that holds it.
  assert.match(script, /-mmin \+45/);
  assert.match(script, /mv "\$dir\/lock" "\$dir\/lock\.\$\$"/);
  assert.match(script, /trap '\[ "\$\(cat "\$dir\/lock\/owner" 2>\/dev\/null\)" = "\$token" \] && rm -rf "\$dir\/lock"' EXIT/);
  assert.match(script, /tail -n \+51/, "the newest 50 logs stay");
  assert.match(script, /"exitCode":%d,"skipped":%s}\\n/);
  assert.ok(script.indexOf("tail.txt") < script.indexOf("last.json"));
});

test("the Windows runner and its registration", () => {
  const runner = windowsRunner("s-1", "C:/Users/me/폴더", 'codex exec -c model_reasoning_effort="high" -');
  assert.equal(runner[0], "\uFEFF", "PowerShell 5.1 needs the BOM to read Korean");
  assert.match(runner, /Set-Location -LiteralPath 'C:\/Users\/me\/폴더'/);
  assert.match(runner, /\[IO\.File\]::Open\(\(Join-Path \$dir 'lock'\), 'OpenOrCreate', 'ReadWrite', 'None'\)/);
  assert.match(runner, /\$deadline = \[DateTime\]::UtcNow\.AddSeconds\(1800\)/);
  assert.match(runner, /WaitForExit\(\$left\)/);
  assert.match(runner, /Select-Object -Skip 50 \| Remove-Item -Force/);
  assert.match(runner, /taskkill\.exe \/pid \$run\.Id \/t \/f/);
  assert.match(runner, /Invoke-Logged \('codex exec -c model_reasoning_effort="high" -' \+ ' < "'/);

  const daily = windowsRegister("s-1", { minute: 5, hour: 7 }, "C:\\Users\\me\\.lepons\\schedules\\s-1\\run.ps1");
  assert.match(daily, /New-ScheduledTaskTrigger -Daily -At '07:05'/);
  assert.match(daily, /-LogonType S4U/);
  assert.match(daily, /Register-ScheduledTask -TaskPath '\\Lepons\\' -TaskName 's-1'/);
  assert.match(daily, /-File "C:\\Users\\me\\.lepons\\schedules\\s-1\\run\.ps1"/);
  assert.match(windowsRegister("s-1", { minute: 0, hour: 9, days: [1, 5] }, "r"), /-Weekly -DaysOfWeek Monday,Friday -At '09:00'/);
  assert.match(windowsRegister("s-1", { minute: 15 }, "r"), /-Once -At '00:15' -RepetitionInterval \(New-TimeSpan -Hours 1\) -RepetitionDuration \(New-TimeSpan -Days 9999\)/);
  assert.match(windowsUnregister("s-1", "C:\\x"), /Unregister-ScheduledTask -TaskPath '\\Lepons\\' -TaskName 's-1' -Confirm:\$false/);

  const line = powershellLine("Write-Output 'hi'");
  const encoded = line.split(" ").at(-1)!;
  assert.match(encoded, /^[A-Za-z0-9+/=]+$/, "nothing cmd.exe or bash would expand");
  assert.equal(Buffer.from(encoded, "base64").toString("utf16le"), "Write-Output 'hi'");
});

test("curly single quotes are doubled too, as PowerShell reads them as quotes", () => {
  const runner = windowsRunner("s-1", "C:/Users/me/Bob\u2019s \u2018x\u201A\u201B'", "claude -p");
  assert.ok(runner.includes("Set-Location -LiteralPath 'C:/Users/me/Bob\u2019\u2019s \u2018\u2018x\u201A\u201A\u201B\u201B'''"));
});

test("a Windows precheck fails on an exit code, an error, or a last output of False", () => {
  const script = windowsPrecheck("Test-Path C:\\nope");
  assert.equal(script[0], "\uFEFF");
  assert.match(script, /\$out = & \{\r\nTest-Path C:\\nope\r\n\}/);
  assert.match(script, /if \(-not \$ok -or \$LASTEXITCODE -ne 0 -or \(\$last -is \[bool\] -and -not \$last\)\) \{ exit 1 \}/);
});

test("instructions too long to show whole in the approval are refused", () => {
  assert.equal(scheduleTextProblem("x".repeat(MAX_SCHEDULE_TEXT)), undefined);
  assert.match(scheduleTextProblem("x".repeat(MAX_SCHEDULE_TEXT + 1)) ?? "", /^too_long/);
  assert.match(scheduleTextProblem("ok", "y".repeat(MAX_SCHEDULE_TEXT + 1)) ?? "", /^too_long/);
  assert.match(scheduleTextProblem("  ") ?? "", /^no_instructions/);
});

test("a Mac's crontab line starts the launcher, a Linux box's the runner", () => {
  assert.equal(cronLine("s-1", "0 9 * * *", "/bin/zsh"),
    `0 9 * * * '/bin/zsh' -lic 'sh "$HOME/.lepons/schedules/s-1/run.sh"' </dev/null >/dev/null 2>&1 # lepons-schedule:s-1`);
  assert.equal(cronLine("s-1", "0 9 * * *", "/bin/zsh", true),
    `0 9 * * * '/bin/zsh' -lic 'sh "$HOME/.lepons/schedules/s-1/launch.sh"' </dev/null >/dev/null 2>&1 # lepons-schedule:s-1`);
});

test("the Mac launcher runs the schedule in a tmux session, or records why it could not", () => {
  const script = macLauncher("s-1");
  assert.match(script, /^#!\/bin\/sh\n/);
  assert.match(script, /if ! tmux list-sessions >\/dev\/null 2>&1; then\n/);
  assert.match(script, /"skipped":true,"reason":"no-session"\}\\n' "\$now" "\$now" >"\$dir\/last\.json\.tmp" && mv/);
  assert.match(script, /echo "lepons: not run -- no tmux server/);
  // The no-server branch ends before any session is made.
  assert.ok(script.indexOf("exit 0\nfi") < script.indexOf("new-session"));
  assert.match(script, /tmux has-session -t '=lepons-run-s-1' 2>\/dev\/null && exit 0\n/);
  assert.match(script, /tmux new-session -d -s 'lepons-run-s-1' "sh '\$dir\/run\.sh'" \\; set-option -w -t '=lepons-run-s-1' remain-on-exit off\n/);
  assert.equal(runSession("s-1"), "lepons-run-s-1");
  assert.equal(NO_SESSION, "no-session");
});

test("a Mac install writes the launcher and a LaunchAgent, never touching the user's crontab; Linux keeps cron", async () => {
  const mac = { text: "30 2 * * * backup.sh\n" as string | undefined };
  const { machine, files, calls } = fakeMachine(false, mac, "Darwin");
  assert.deepEqual(await installSchedule(machine, "/home/me", spec, async () => true), { ok: true });
  assert.deepEqual(names(new Map([...files].filter(([path]) => path.startsWith(dir))), dir), ["instructions.txt", "launch.sh", "precheck.sh", "run.sh", "schedule.json"]);
  assert.equal(files.get(`${dir}/launch.sh`), macLauncher("s-1"));
  assert.equal(files.get("/home/me/Library/LaunchAgents/app.lepons.schedule.s-1.plist"), launchdPlist("s-1", spec.when));
  assert.ok(calls.some((command) => command.includes("launchctl bootstrap gui/$(id -u) '/home/me/Library/LaunchAgents/app.lepons.schedule.s-1.plist'")));
  assert.equal(calls.some((command) => command.endsWith("| crontab -")), false, "no crontab line of ours to remove, none written");
  assert.equal(mac.text, "30 2 * * * backup.sh\n");
  assert.equal(JSON.parse(files.get(`${dir}/schedule.json`)!).darwin, true);

  const linux = { text: "" as string | undefined };
  const other = fakeMachine(false, linux);
  await installSchedule(other.machine, "/home/me", spec, async () => true);
  assert.equal(other.files.has(`${dir}/launch.sh`), false);
  assert.equal(linux.text, `${cronLine("s-1", "0 9 * * *", "/bin/zsh")}\n`);
  assert.equal(JSON.parse(other.files.get(`${dir}/schedule.json`)!).darwin, undefined);
});

test("the LaunchAgent plist: the login-shell hand-off, and a calendar interval from When", () => {
  const parsed = parseWhen("weekdays 09:00");
  assert.ok(parsed.ok);
  const weekdays = launchdPlist("s-1", parsed.when);
  assert.equal(weekdays.match(/<key>Weekday<\/key>/g)?.length, 5);
  assert.match(weekdays, /<integer>9<\/integer>/);
  assert.match(weekdays, /<key>Label<\/key><string>app\.lepons\.schedule\.s-1<\/string>/);
  assert.match(weekdays, /<string>\/bin\/zsh<\/string><string>-lic<\/string><string>sh "\$HOME\/\.lepons\/schedules\/s-1\/launch\.sh"<\/string>/);
  assert.doesNotMatch(launchdPlist("s-1", { minute: 5 }), /Hour|Weekday|<array><dict>/);
  assert.match(launchdPlist("s-1", { minute: 5, hour: 7 }), /<key>Hour<\/key><integer>7<\/integer>/);
});

test("a Mac schedule that cron once held moves to launchd: only its marker line goes", async () => {
  const mine = cronLine("s-1", "0 9 * * *", "/bin/zsh", true);
  const crontab = { text: `30 2 * * * backup.sh\n${mine}\n` as string | undefined };
  const { machine, files, calls } = fakeMachine(false, crontab, "Darwin");
  files.set(`${dir}/schedule.json`, JSON.stringify({ name: "요약", folder: "/srv/api", cron: "0 9 * * *", executor: "claude", darwin: true }));
  assert.deepEqual(await setPaused(machine, "/home/me", "s-1", true), { ok: true });
  assert.equal(crontab.text, "30 2 * * * backup.sh\n");
  assert.ok(files.has("/home/me/Library/LaunchAgents/app.lepons.schedule.s-1.plist"));
  assert.ok(calls.some((command) => command.includes("launchctl bootout gui/$(id -u)/app.lepons.schedule.s-1")));
  assert.equal(calls.some((command) => command.includes("launchctl bootstrap")), false, "paused stays unloaded");
  assert.deepEqual(await setPaused(machine, "/home/me", "s-1", false), { ok: true });
  assert.ok(calls.some((command) => command.includes("launchctl bootstrap")));
  assert.deepEqual(await removeSchedule(machine, "/home/me", "s-1"), { ok: true });
  assert.ok(calls.some((command) => command.includes("rm -f '/home/me/Library/LaunchAgents/app.lepons.schedule.s-1.plist'")));
  assert.equal(crontab.text, "30 2 * * * backup.sh\n");
});

test("removing the last schedule removes the empty schedules folder, never a full one", async () => {
  const { machine, calls } = fakeMachine(false, { text: "" });
  await removeSchedule(machine, "/home/me", "s-1");
  assert.ok(calls.some((command) => command.includes("rmdir '/home/me/.lepons/schedules'")), "rmdir only removes an empty folder");
  assert.equal(calls.some((command) => command.includes("rm -rf '/home/me/.lepons/schedules'")), false);
  const script = windowsUnregister("s-1", "C:\\Users\\me\\.lepons\\schedules\\s-1");
  assert.match(script, /GetTasks\(0\)\.Count -eq 0/, "the task folder goes only when it holds no task");
  assert.match(script, /DeleteFolder\('Lepons', 0\)/);
});

test("last.json reads, a BOM or garbage included", () => {
  assert.deepEqual(parseLastRun('\uFEFF{"startedAt":"a","endedAt":"b","exitCode":2,"skipped":false}'), { startedAt: "a", endedAt: "b", exitCode: 2, skipped: false });
  assert.equal(parseLastRun("{"), undefined);
  assert.deepEqual(parseLastRun('{"startedAt":"a","endedAt":"a","exitCode":0,"skipped":true,"reason":"no-session"}'),
    { startedAt: "a", endedAt: "a", exitCode: 0, skipped: true, reason: "no-session" });
  assert.equal(parseLastRun(undefined), undefined);
});

/** A machine that records what was done to it. */
function fakeMachine(windows: boolean, crontab: { text: string | undefined }, uname = "Linux") {
  const calls: string[] = [];
  const files = new Map<string, string>();
  const machine: ScheduleMachine = {
    windows,
    run: async (command) => {
      calls.push(command);
      if (command === "uname -s") return { code: 0, output: `${uname}
` };
      if (command === "crontab -l") return crontab.text === undefined ? { code: 1, output: "crontab: no crontab for me\n" } : { code: 0, output: crontab.text };
      const piped = /^printf '%s' '([\s\S]*)' \| crontab -$/.exec(command);
      if (piped) crontab.text = piped[1]!.replaceAll(`'\\''`, "'");
      return { code: 0, output: command.startsWith("printf '%s\\n%s'") ? `/bin/zsh\n${uname}\n` : "" };
    },
    makeDirs: async () => {},
    overwrite: async (path, contents) => { files.set(path, contents); return { ok: true }; },
    readText: async (path) => ({ ok: true, contents: files.get(path) }),
    list: async (path) => ({
      ok: true, path,
      entries: [...files.keys()].filter((file) => file.startsWith(`${path}/`)).map((file) => ({ name: file.slice(path.length + 1), isDirectory: false } as never)),
    }),
    read: async (path) => (files.has(path) ? Buffer.from(files.get(path)!) : undefined),
  };
  return { machine, calls, files };
}

const spec: ScheduleSpec = {
  id: "s-1", folder: "/srv/api", when: { minute: 0, hour: 9 }, cron: "0 9 * * *", command: "claude -p", instructions: "요약해 줘 'now'", precheck: "git log -1",
  name: "요약", executor: "claude",
};
const dir = "/home/me/.lepons/schedules/s-1";
const names = (files: Map<string, string>, root: string) => [...files.keys()].map((path) => path.slice(root.length + 1)).sort();

test("an install waits for the yes, then writes the files and one crontab line", async () => {
  const crontab = { text: "30 2 * * * backup.sh\n" as string | undefined };
  const refused = fakeMachine(false, crontab);
  assert.deepEqual(await installSchedule(refused.machine, "/home/me", spec, async () => false), { ok: false, error: "refused" });
  assert.deepEqual(refused.calls, []);
  assert.equal(refused.files.size, 0);

  const { machine, files } = fakeMachine(false, crontab);
  assert.deepEqual(await installSchedule(machine, "/home/me", spec, async () => true), { ok: true });
  assert.deepEqual(names(files, dir), ["instructions.txt", "precheck.sh", "run.sh", "schedule.json"]);
  assert.equal(files.get(`${dir}/instructions.txt`), "요약해 줘 'now'", "the instructions are a file, never a command line");
  assert.deepEqual(JSON.parse(files.get(`${dir}/schedule.json`)!), { name: "요약", folder: "/srv/api", cron: "0 9 * * *", executor: "claude", precheck: "git log -1" });
  assert.equal(crontab.text, `30 2 * * * backup.sh\n${cronLine("s-1", "0 9 * * *", "/bin/zsh")}\n`);

  const read = await readSchedule(machine, "/home/me", "s-1");
  assert.equal(read?.info?.name, "요약");
  assert.equal(read?.instructions, "요약해 줘 'now'");
  assert.equal(read?.last, undefined, "no run yet");

  assert.deepEqual(await removeSchedule(machine, "/home/me", "s-1"), { ok: true });
  assert.equal(crontab.text, "30 2 * * * backup.sh\n");
});

test("an account with no crontab gets one; a crontab that cannot be read is never written over", async () => {
  const empty = { text: undefined as string | undefined };
  assert.deepEqual(await installSchedule(fakeMachine(false, empty).machine, "/home/me", spec, async () => true), { ok: true });
  assert.equal(empty.text, `${cronLine("s-1", "0 9 * * *", "/bin/zsh")}\n`);

  const { machine, calls } = fakeMachine(false, { text: "" });
  machine.run = async (command) => {
    calls.push(command);
    return command === "crontab -l" ? { code: 1, output: "crontab: permission denied" } : { code: 0, output: "" };
  };
  const result = await installSchedule(machine, "/home/me", spec, async () => true);
  assert.equal(result.ok, false);
  assert.equal(calls.some((command) => command.endsWith("| crontab -")), false);
});

test("pausing comments out only this schedule's crontab line, and resuming restores it", () => {
  const line = cronLine("s-1", "0 9 * * *", "/bin/zsh");
  const other = cronLine("s-2", "0 * * * *", "/bin/zsh");
  const crontab = `# a note\n30 2 * * * backup.sh\n${line}\n${other}\n`;
  const paused = withCronPaused(crontab, "s-1", true);
  assert.equal(paused, `# a note\n30 2 * * * backup.sh\n#${line}\n${other}\n`);
  assert.equal(withCronPaused(paused, "s-1", true), paused, "pausing twice is one #");
  assert.equal(withCronPaused(paused, "s-1", false), crontab);
  assert.equal(withCronPaused(crontab, "s-1", false), crontab, "resuming a running one changes nothing");
  // A paused line is still found by its marker, so it can be removed or replaced.
  assert.equal(withoutCronLine(paused, "s-1"), `# a note\n30 2 * * * backup.sh\n${other}\n`);

  assert.equal(windowsPause("s-1", true), "Disable-ScheduledTask -TaskPath '\\Lepons\\' -TaskName 's-1' | Out-Null");
  assert.equal(windowsPause("s-1", false), "Enable-ScheduledTask -TaskPath '\\Lepons\\' -TaskName 's-1' | Out-Null");
});

test("pause and resume change the crontab, then schedule.json", async () => {
  const crontab = { text: "30 2 * * * backup.sh\n" as string | undefined };
  const { machine, files } = fakeMachine(false, crontab);
  await installSchedule(machine, "/home/me", spec, async () => true);
  assert.deepEqual(await setPaused(machine, "/home/me", "s-1", true), { ok: true });
  assert.equal(crontab.text, `30 2 * * * backup.sh\n#${cronLine("s-1", "0 9 * * *", "/bin/zsh")}\n`);
  assert.equal(JSON.parse(files.get(`${dir}/schedule.json`)!).paused, true);
  assert.deepEqual(await setPaused(machine, "/home/me", "s-1", false), { ok: true });
  assert.equal(crontab.text, `30 2 * * * backup.sh\n${cronLine("s-1", "0 9 * * *", "/bin/zsh")}\n`);
  assert.equal(JSON.parse(files.get(`${dir}/schedule.json`)!).paused, undefined);
  assert.equal((await setPaused(machine, "/home/me", "s-9", true)).ok, false, "one that is not there");
});

test("an edit rewrites the same schedule in place: its files, its one crontab line, a pause kept", async () => {
  const crontab = { text: "" as string | undefined };
  const { machine, files } = fakeMachine(false, crontab);
  await installSchedule(machine, "/home/me", spec, async () => true);
  const edited: ScheduleSpec = { ...spec, when: { minute: 30, hour: 18, days: [5] }, cron: "30 18 * * 5", instructions: "새 지시", paused: true };
  delete edited.precheck;
  assert.deepEqual(await installSchedule(machine, "/home/me", edited, async () => true), { ok: true });
  assert.equal(crontab.text, `#${cronLine("s-1", "30 18 * * 5", "/bin/zsh")}\n`, "one line, the new time, still paused");
  assert.equal(files.get(`${dir}/instructions.txt`), "새 지시");
  assert.equal(files.get(`${dir}/precheck.sh`), "", "a precheck taken out leaves an empty file, which the runner skips");
  assert.deepEqual(JSON.parse(files.get(`${dir}/schedule.json`)!), { name: "요약", folder: "/srv/api", cron: "30 18 * * 5", executor: "claude", paused: true });
  assert.match(posixRunner("s-1", "/srv/api", "claude -p"), /elif \[ -s "\$dir\/precheck.sh" \]/);
});

test("on Windows the install registers a task through one encoded line; an edit of a paused one disables it again", async () => {
  const { machine, calls, files } = fakeMachine(true, { text: undefined });
  const root = "C:/Users/me/.lepons/schedules/s-1";
  const runner = "C:\\Users\\me\\.lepons\\schedules\\s-1\\run.ps1";
  const decode = (call: string) => Buffer.from(call.split(" ").at(-1)!, "base64").toString("utf16le");
  assert.deepEqual(await installSchedule(machine, "C:/Users/me", spec, async () => true), { ok: true, windowsLogon: "s4u" });
  assert.deepEqual(names(files, root), ["instructions.txt", "precheck.ps1", "run.ps1", "schedule.json"]);
  assert.equal(calls.length, 1);
  assert.equal(decode(calls[0]!), windowsRegister("s-1", spec.when, runner));
  assert.equal(scheduleFiles(spec, true)["precheck.ps1"], windowsPrecheck("git log -1"));
  assert.equal(scheduleFiles({ ...spec, precheck: "" }, true)["precheck.ps1"], "");

  const edit = { ...spec, when: { minute: 0, hour: 7 }, cron: "0 7 * * *", paused: true };
  assert.deepEqual(await installSchedule(machine, "C:/Users/me", edit, async () => true), { ok: true, windowsLogon: "s4u" });
  assert.equal(decode(calls[1]!), `${windowsRegister("s-1", edit.when, runner)}\n${windowsPause("s-1", true)}`);
  assert.match(decode(calls[1]!), /Register-ScheduledTask [^\n]*-Force/, "-Force replaces the task of the same name");

  assert.deepEqual(await setPaused(machine, "C:/Users/me", "s-1", false), { ok: true });
  assert.match(decode(calls[2]!), /Enable-ScheduledTask -TaskPath '\\Lepons\\' -TaskName 's-1'/);

  // Refused even as a signed-in task: said in words, not in Windows' raw error.
  machine.run = async () => ({ code: 1, output: "Register-ScheduledTask : Access is denied.\r\n(HRESULT 0x80070005)" });
  assert.deepEqual(await installSchedule(machine, "C:/Users/me", spec, async () => true), { ok: false, error: TASK_DENIED });
});

test("the two Windows logon modes, as registered", () => {
  const s4u = windowsRegister("s-1", { minute: 0, hour: 9 }, "r");
  const interactive = windowsRegister("s-1", { minute: 0, hour: 9 }, "r", "interactive");
  assert.match(s4u, /New-ScheduledTaskPrincipal -UserId \(\[Security\.Principal\.WindowsIdentity\]::GetCurrent\(\)\.Name\) -LogonType S4U -RunLevel Limited/);
  assert.match(interactive, /New-ScheduledTaskPrincipal -UserId \(\[Security\.Principal\.WindowsIdentity\]::GetCurrent\(\)\.Name\) -LogonType Interactive -RunLevel Limited/);
  assert.equal(interactive.replace("-LogonType Interactive", "-LogonType S4U"), s4u, "the same task otherwise");
});

test("S4U denied, the same task is registered to run while signed in, and schedule.json says so", async () => {
  const { machine, calls, files } = fakeMachine(true, { text: undefined });
  const root = "C:/Users/me/.lepons/schedules/s-1";
  const decode = (call: string) => Buffer.from(call.split(" ").at(-1)!, "base64").toString("utf16le");
  machine.run = async (command) => {
    calls.push(command);
    return /-LogonType S4U/.test(decode(command)) ? { code: 1, output: "Register-ScheduledTask : Access is denied." } : { code: 0, output: "" };
  };
  assert.deepEqual(await installSchedule(machine, "C:/Users/me", { ...spec, paused: true }, async () => true), { ok: true, windowsLogon: "interactive" });
  assert.equal(calls.length, 2);
  assert.match(decode(calls[1]!), /-LogonType Interactive/);
  assert.match(decode(calls[1]!), /Disable-ScheduledTask/, "a paused one stays paused in either mode");
  assert.equal(JSON.parse(files.get(`${root}/schedule.json`)!).windowsLogon, "interactive");

  // An edit tries S4U again first; where it is allowed, the record says s4u.
  machine.run = async (command) => { calls.push(command); return { code: 0, output: "" }; };
  assert.deepEqual(await installSchedule(machine, "C:/Users/me", spec, async () => true), { ok: true, windowsLogon: "s4u" });
  assert.match(decode(calls.at(-1)!), /-LogonType S4U/);
  assert.equal(JSON.parse(files.get(`${root}/schedule.json`)!).windowsLogon, "s4u");

  // Pausing keeps the mode it was registered with.
  assert.deepEqual(await setPaused(machine, "C:/Users/me", "s-1", true), { ok: true });
  assert.equal(JSON.parse(files.get(`${root}/schedule.json`)!).windowsLogon, "s4u");
});

test("the caller's serial line holds the writing, not the question", async () => {
  const { machine } = fakeMachine(false, { text: "" });
  const order: string[] = [];
  const serial = async (work: () => Promise<{ ok: true } | { ok: false; error: string }>) => {
    order.push("queued");
    return work();
  };
  await installSchedule(machine, "/home/me", spec, async () => { order.push("asked"); return true; }, serial);
  assert.deepEqual(order, ["asked", "queued"]);
  order.length = 0;
  await installSchedule(machine, "/home/me", spec, async () => { order.push("asked"); return false; }, serial);
  assert.deepEqual(order, ["asked"], "a no never joins the line");
});

test("run logs list newest first, and only log names are read", async () => {
  const { machine, files } = fakeMachine(false, { text: "" });
  files.set(`${dir}/runs/20261123T000000Z.log`, "old");
  files.set(`${dir}/runs/20261124T000000Z.log`, "new");
  assert.deepEqual(await runLogs(machine, "/home/me", "s-1"), ["20261124T000000Z.log", "20261123T000000Z.log"]);
  assert.equal(await runLog(machine, "/home/me", "s-1", "20261123T000000Z.log"), "old");
  assert.equal(await runLog(machine, "/home/me", "s-1", "../schedule.json"), undefined);
});

test("a Mac install whose crontab cannot be written loads nothing: only the old trigger is left", async () => {
  const mine = cronLine("s-1", "0 9 * * *", "/bin/zsh", true);
  const crontab = { text: `${mine}\n` as string | undefined };
  const { machine, calls, files } = fakeMachine(false, crontab, "Darwin");
  const run = machine.run;
  machine.run = async (command) => (command.endsWith("| crontab -") ? { code: 1, output: "denied" } : run(command));
  assert.equal((await installSchedule(machine, "/home/me", spec, async () => true)).ok, false);
  assert.equal(calls.some((command) => command.includes("launchctl bootstrap")), false);
  assert.equal(files.has("/home/me/Library/LaunchAgents/app.lepons.schedule.s-1.plist"), false);
});

test("removing a Mac schedule boots out its plist whatever schedule.json says, and does not need the crontab", async () => {
  for (const json of [undefined, "{not json"]) {
    const { machine, calls, files } = fakeMachine(false, { text: "" }, "Darwin");
    if (json !== undefined) files.set(`${dir}/schedule.json`, json);
    const run = machine.run;
    machine.run = async (command) => (command === "crontab -l" ? { code: 1, output: "Operation not permitted" } : run(command));
    assert.deepEqual(await removeSchedule(machine, "/home/me", "s-1"), { ok: true });
    assert.ok(calls.some((command) => command.includes("launchctl bootout gui/$(id -u)/app.lepons.schedule.s-1")));
    assert.ok(calls.some((command) => command.includes("rm -f '/home/me/Library/LaunchAgents/app.lepons.schedule.s-1.plist'")));
  }
});

test("a bootstrap that fails right after bootout is tried once more", async () => {
  const { machine, calls } = fakeMachine(false, { text: "" }, "Darwin");
  await installSchedule(machine, "/home/me", spec, async () => true);
  assert.ok(calls.some((command) => /launchctl bootstrap [^|]*\|\| \{ sleep 1; launchctl bootstrap/.test(command)));
});

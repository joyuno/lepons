import { test } from "node:test";
import assert from "node:assert/strict";

import {
  controlOsJob, describeItem, describeLines, editOsJob, jobCommand, jobOrigin, jobProgram, jobTitle, windowsListScript, listOsJobs, osJobName, parseCrontab, parseDescribed, parseLaunchd, parsePosixListing, parseSystemdTimers, parseWindowsTasks, posixListScript, scheduleText,
  type OsJob, type OsJobMachine,
} from "./os-jobs.ts";
import { setLocale } from "../i18n/i18n.ts";
import { parseWhen } from "./schedule.ts";

setLocale("ko");
const text = (job: OsJob) => (job.schedule ? scheduleText(job.schedule) : undefined);

const collect = {
  Label: "com.rafeed.collect", ProgramArguments: ["/bin/zsh", "-lc", "run collect"], StandardOutPath: "/Users/a/log/collect.log",
  StartCalendarInterval: [{ Hour: 6, Minute: 30 }, { Hour: 15, Minute: 30 }],
};
const loaded = "PID\tStatus\tLabel\n-\t0\tcom.rafeed.collect\n123\t0\tcom.rafeed.bot\n";

test("launchd: times, resident, interval, loaded", () => {
  const [a, b, c, d] = parseLaunchd([
    { file: "/p/collect.plist", json: collect },
    { file: "/p/bot.plist", json: { Label: "com.rafeed.bot", ProgramArguments: ["bot"], KeepAlive: true } },
    { file: "/p/poll.plist", json: { Label: "com.x.poll", Program: "/bin/poll", StartInterval: 300 } },
    { file: "/p/l.plist", json: { Label: "app.lepons.schedule.abc", StartCalendarInterval: { Minute: 0 } } },
  ], loaded);
  assert.deepEqual(a!.schedule, { kind: "calendar", entries: [{ minute: 30, hour: 6 }, { minute: 30, hour: 15 }] });
  assert.equal(text(a!), "매일 06:30, 15:30");
  assert.equal(a!.enabled, true);
  assert.equal(a!.logPath, "/Users/a/log/collect.log");
  assert.equal(b!.resident, true);
  assert.equal(b!.schedule, undefined);
  assert.equal(text(c!), "5분마다");
  assert.equal(c!.enabled, false);
  assert.equal(d!.source, "lepons");
});

test("crontab: two jobs, one Lepons line, paused and notes", () => {
  const jobs = parseCrontab([
    "# a note", "MAILTO=me", "30 6 * * * /bin/a --x", "# 0 5 * * * not a job, a note", "#15 * * * 1-5 /bin/paused",
    "0 9 * * * sh x </dev/null # lepons-schedule:abc", "",
  ].join("\n"));
  assert.deepEqual(jobs.map((job) => job.source), ["cron", "cron", "lepons"]);
  assert.equal(text(jobs[0]!), "매일 06:30");
  assert.equal(jobs[0]!.command, "/bin/a --x");
  assert.equal(jobs[1]!.enabled, false);
  assert.equal(jobs[2]!.label, "abc");
});

test("systemd timers", () => {
  const [one] = parseSystemdTimers("Tue 2026-11-24 10:00:00 KST 1h left Tue 2026-11-24 09:00:00 KST 5min ago backup.timer backup.service\nn/a n/a n/a n/a idle.timer idle.service\n");
  assert.equal(one!.label, "backup.timer");
  assert.equal(one!.command, "backup.service");
  assert.equal(one!.enabled, true);
  assert.equal(parseSystemdTimers("n/a n/a n/a n/a idle.timer idle.service")[0]!.enabled, false);
});

test("Task Scheduler: one task is not an array, \\Microsoft\\ and \\Lepons\\ are sorted", () => {
  const one = parseWindowsTasks(JSON.stringify({ TaskName: "t", TaskPath: "\\", State: 3, LastResult: 0, Actions: [{ Execute: "a.exe", Arguments: "-x" }], Triggers: [{ Type: "MSFT_TaskDailyTrigger", StartBoundary: "2026-10-29T12:30:00" }] }));
  assert.equal(one.length, 1);
  assert.equal(one[0]!.label, "\\t");
  assert.equal(one[0]!.command, "a.exe -x");
  assert.equal(text(one[0]!), "매일 12:30");
  assert.equal(one[0]!.lastResult, "0");
  const many = parseWindowsTasks(JSON.stringify([
    { TaskName: "x", TaskPath: "\\Microsoft\\Windows\\", State: 3 }, { TaskName: "s1", TaskPath: "\\Lepons\\", State: 1 }, { TaskName: "d", TaskPath: "\\", State: 1 },
  ]));
  assert.deepEqual(many.map((job) => [job.source, job.enabled]), [["lepons", false], ["taskscheduler", false]]);
});

const mac: OsJob = { id: "launchd:/Users/a/Library/LaunchAgents/com.x.plist", source: "launchd", label: "com.x", command: "c", enabled: true, logPath: "/tmp/x.log" };

test("jobCommand: launchd pause also disables, labels are quoted", () => {
  const pause = jobCommand(mac, "pause");
  assert.ok(pause.startsWith("launchctl bootout gui/$(id -u)/'com.x'"));
  assert.ok(pause.includes("; launchctl disable gui/$(id -u)/'com.x'"));
  assert.ok(jobCommand(mac, "resume").startsWith("launchctl enable gui/$(id -u)/'com.x' && "));
  assert.equal(jobCommand(mac, "run"), "launchctl kickstart -k gui/$(id -u)/'com.x'");
  assert.equal(jobCommand(mac, "log"), "tail -n 200 -- '/tmp/x.log'");
  const evil = jobCommand({ ...mac, label: "a'; rm -rf ~; '" }, "run");
  assert.equal(evil, "launchctl kickstart -k gui/$(id -u)/'a'\\''; rm -rf ~; '\\'''");
});

test("jobCommand: systemd and Task Scheduler", () => {
  const timer: OsJob = { id: "systemd:b.timer", source: "systemd", label: "b.timer", command: "b.service", enabled: true };
  assert.equal(jobCommand(timer, "pause"), "systemctl --user disable --now -- 'b.timer'");
  assert.equal(jobCommand(timer, "resume"), "systemctl --user enable --now -- 'b.timer'");
  assert.equal(jobCommand(timer, "run"), "systemctl --user start -- 'b.service'");
  assert.equal(jobCommand(timer, "log"), "journalctl --user --unit='b.service' -n 200 --no-pager");
  const task: OsJob = { id: "taskscheduler:\\Mine\\it's", source: "taskscheduler", label: "\\Mine\\it's", command: "", enabled: true };
  assert.equal(jobCommand(task, "pause"), "Disable-ScheduledTask -TaskPath '\\Mine\\' -TaskName 'it''s' | Out-Null");
  assert.equal(jobCommand(task, "run"), "Start-ScheduledTask -TaskPath '\\Mine\\' -TaskName 'it''s'");
});

/** A machine that records what it was told to run. */
function fake(answers: (command: string) => { code: number; output: string } = () => ({ code: 0, output: "" })) {
  const ran: string[] = [];
  const machine: OsJobMachine = { windows: false, run: async (command) => (ran.push(command), answers(command)) };
  return { machine, ran };
}

test("control: a refusal runs nothing; log needs no approval; Lepons' own jobs are refused", async () => {
  const { machine, ran } = fake(() => ({ code: 0, output: "tail" }));
  assert.deepEqual(await controlOsJob(machine, mac, "pause", async () => false), { ok: false, error: "refused" });
  assert.deepEqual(ran, []);
  assert.deepEqual(await controlOsJob(machine, mac, "log", async () => assert.fail("asked")), { ok: true, output: "tail" });
  const own = await controlOsJob(machine, { ...mac, source: "lepons" }, "pause", async () => true);
  assert.equal(own.ok, false);
  assert.equal(ran.length, 1);
});

test("control: cron pause touches only that line, resume restores it", async () => {
  const tab = "MAILTO=me\n30 6 * * * /bin/a\n30 6 * * * /bin/a2\n";
  let written = "";
  const { machine } = fake((command) => {
    if (command === "crontab -l") return { code: 0, output: tab };
    written = command;
    return { code: 0, output: "" };
  });
  const job = parseCrontab(tab)[0]!;
  assert.deepEqual(await controlOsJob(machine, job, "pause", async () => true), { ok: true });
  assert.ok(written.includes("MAILTO=me\n#30 6 * * * /bin/a\n30 6 * * * /bin/a2\n"));
  const paused = parseCrontab("#30 6 * * * /bin/a\n")[0]!;
  assert.equal(paused.enabled, false);
  const second = fake((command) => (command === "crontab -l" ? { code: 0, output: "#30 6 * * * /bin/a\nx\n" } : { code: 0, output: "" }));
  await controlOsJob(second.machine, paused, "resume", async () => true);
  assert.ok(second.ran.at(-1)!.includes("30 6 * * * /bin/a\nx\n"));
  assert.ok(!second.ran.at(-1)!.includes("#30"));
});

test("control: a crontab line that changed meanwhile is not guessed at", async () => {
  const { machine, ran } = fake(() => ({ code: 0, output: "0 1 * * * other\n" }));
  const result = await controlOsJob(machine, parseCrontab("30 6 * * * /bin/a")[0]!, "pause", async () => true);
  assert.equal(result.ok, false);
  assert.deepEqual(ran, ["crontab -l"]);
});

test("edit: cron changes five fields, launchd replaces the calendar and reloads only a loaded job", async () => {
  const when = (text: string) => {
    const parsed = parseWhen(text);
    assert.ok(parsed.ok);
    return parsed.when;
  };
  const cronMachine = fake((command) => (command === "crontab -l" ? { code: 0, output: "30 6 * * 1 /bin/a >/dev/null\n" } : { code: 0, output: "" }));
  const done = await editOsJob(cronMachine.machine, parseCrontab("30 6 * * 1 /bin/a >/dev/null")[0]!, when("daily 07:05"), async () => true);
  assert.deepEqual(done, { ok: true });
  assert.ok(cronMachine.ran.at(-1)!.includes("5 7 * * * /bin/a >/dev/null\n"));
  const reboot = await editOsJob(cronMachine.machine, parseCrontab("@reboot /bin/a")[0]!, when("hourly"), async () => true);
  assert.equal(reboot.ok, false);

  const loadedMac = fake();
  assert.deepEqual(await editOsJob(loadedMac.machine, mac, when("weekdays 09:00"), async () => true), { ok: true });
  const line = loadedMac.ran[0]!;
  assert.ok(line.startsWith(`plutil -replace StartCalendarInterval -json '[{"Weekday":1,"Hour":9,"Minute":0}`));
  assert.ok(line.includes("launchctl bootout") && line.includes("launchctl bootstrap"));
  const pausedMac = fake();
  await editOsJob(pausedMac.machine, { ...mac, enabled: false }, when("daily 08:00"), async () => true);
  assert.ok(!pausedMac.ran[0]!.includes("launchctl"));
  const refused = fake();
  assert.deepEqual(await editOsJob(refused.machine, mac, when("hourly"), async () => false), { ok: false, error: "refused" });
  assert.deepEqual(refused.ran, []);
  assert.equal((await editOsJob(refused.machine, { ...mac, source: "systemd" }, when("hourly"), async () => true)).ok, false);
});

test("listing: the POSIX script's sections become jobs, Lepons' own counted once", async () => {
  const plist = JSON.stringify(collect);
  const leponsPlist = JSON.stringify({ Label: "app.lepons.schedule.z", StartCalendarInterval: { Minute: 5 } });
  const output = [
    "@@lepons-osjobs:cron", "30 6 * * * /bin/a", "0 9 * * * sh x # lepons-schedule:z",
    "@@lepons-osjobs:timers", "@@lepons-osjobs:loaded", "-\t0\tcom.rafeed.collect",
    "@@lepons-osjobs:plist /Users/a/Library/LaunchAgents/com.rafeed.collect.plist", plist, "",
    "@@lepons-osjobs:plist /Users/a/Library/LaunchAgents/app.lepons.schedule.z.plist", leponsPlist, "",
    "@@lepons-osjobs:plist /Users/a/Library/LaunchAgents/broken.plist", "not json", "",
  ].join("\n");
  assert.deepEqual(parsePosixListing(output).map((job) => job.source), ["launchd", "lepons", "cron", "lepons"]);
  const { machine, ran } = fake(() => ({ code: 0, output }));
  const listed = await listOsJobs(machine, "/Users/a");
  assert.ok(listed.ok && listed.jobs.length === 4);
  assert.ok(ran[0]!.includes("cd '/Users/a/Library/LaunchAgents'"));
  assert.ok(posixListScript("/h").length > 0);
  const lost = await listOsJobs({ windows: false, run: async () => undefined }, "/h");
  assert.ok(!lost.ok && /unreachable/.test(lost.error));
});

test("schedule words come from t() in each language", () => {
  const every = { kind: "interval", seconds: 7200 } as const;
  assert.equal(scheduleText(every), "2시간마다");
  setLocale("en");
  assert.equal(scheduleText(every), "Every 2 h");
  assert.equal(scheduleText({ kind: "calendar", entries: [{ weekday: 1, hour: 9, minute: 5 }, { minute: 30 }] }), "Mon 09:05, Every hour at :30");
  assert.equal(scheduleText({ kind: "many", items: [{ kind: "logon" }, { kind: "boot" }] }), "At sign-in, At startup");
  setLocale("zh");
  assert.equal(scheduleText({ kind: "logon" }), "登录时");
  setLocale("ko");
  assert.equal(scheduleText({ kind: "calendar", entries: [{ weekday: 0, hour: 7, minute: 0 }] }), "일 07:00");
});

const CLIXML = '#< CLIXML\n<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04"><Obj S="progress" RefId="0"><MS><PR N="Record"><AV>Preparing</AV></PR></MS></Obj></Objs>';
const TASKS = '[{"TaskName":"t","TaskPath":"\\\\","State":3,"Actions":[],"Triggers":[]}]';

test("Windows listing: CLIXML around the JSON is skipped, inside it or no JSON is an error, not an empty list", async () => {
  const around = (output: string) => listOsJobs({ windows: true, run: async () => ({ code: 0, output }) }, "C:/Users/a");
  const ok = await around(`${CLIXML}\n${TASKS}\n${CLIXML}`);
  assert.ok(ok.ok && ok.jobs.length === 1);
  const inside = await around(`${TASKS.slice(0, 20)}${CLIXML}${TASKS.slice(20)}`);
  assert.equal(inside.ok, false);
  assert.equal((await around(CLIXML)).ok, false);
  const none = await around("");
  assert.ok(none.ok && none.jobs.length === 0);
  const failed = await listOsJobs({ windows: false, run: async () => ({ code: 255, output: "ssh: connection refused" }) }, "/h");
  assert.ok(!failed.ok && /connection refused/.test(failed.error));
  const odd = await listOsJobs({ windows: false, run: async () => ({ code: 0, output: "Welcome to a shell" }) }, "/h");
  assert.equal(odd.ok, false);
});

test("a path or unit that starts with a dash is not an option", () => {
  assert.equal(jobCommand({ ...mac, logPath: "-f" }, "log"), "tail -n 200 -- '-f'");
  const timer: OsJob = { id: "systemd:-x.timer", source: "systemd", label: "-x.timer", command: "-x.service", enabled: true };
  assert.equal(jobCommand(timer, "pause"), "systemctl --user disable --now -- '-x.timer'");
  assert.equal(jobCommand(timer, "log"), "journalctl --user --unit='-x.service' -n 200 --no-pager");
});

test("control: pause only an enabled job, resume only a paused one", async () => {
  const { machine, ran } = fake();
  const never = async () => assert.fail("asked");
  const paused = await controlOsJob(machine, { ...mac, enabled: false }, "pause", never);
  assert.ok(!paused.ok && /already_paused/.test(paused.error));
  const on = await controlOsJob(machine, mac, "resume", never);
  assert.ok(!on.ok && /not_paused/.test(on.error));
  assert.deepEqual(ran, []);
  assert.deepEqual(await controlOsJob(machine, { ...mac, enabled: false }, "resume", async () => true), { ok: true });
});

test("the approval is asked outside the queue, the work inside it", async () => {
  const events: string[] = [];
  const serial = async <T,>(work: () => Promise<T>) => (events.push("queue in"), work().finally(() => events.push("queue out")));
  const { machine } = fake(() => (events.push("run"), { code: 0, output: "" }));
  await controlOsJob(machine, mac, "run", async () => (events.push("ask"), true), serial);
  assert.deepEqual(events, ["ask", "queue in", "run", "queue out"]);
});

test("a resident launchd job has no time to edit", async () => {
  const { machine, ran } = fake();
  const parsed = parseWhen("hourly");
  assert.ok(parsed.ok);
  const result = await editOsJob(machine, { ...mac, resident: true }, parsed.when, async () => assert.fail("asked"));
  assert.ok(!result.ok && /unsupported/.test(result.error));
  assert.deepEqual(ran, []);
});

test("cron: names in fields and indented lines are listed; a note stuck to a word is not a job", () => {
  const jobs = parseCrontab(["0 9 * * mon-fri /bin/a", "  15 6 1 jan * /bin/b", "#30 6 * * mon /bin/c", "#remember to do a b c d e"].join("\n"));
  assert.equal(jobs.length, 3);
  assert.equal(scheduleText(jobs[0]!.schedule!), "0 9 * * mon-fri");
  assert.equal(jobs[2]!.enabled, false);
  assert.equal(jobs[1]!.enabled, true);
});

test("cron: pausing an indented line keeps it findable and resumable", async () => {
  let written = "";
  const { machine } = fake((command) => (command === "crontab -l" ? { code: 0, output: "  15 6 * * * /bin/b\n" } : ((written = command), { code: 0, output: "" })));
  const job = parseCrontab("  15 6 * * * /bin/b")[0]!;
  assert.deepEqual(await controlOsJob(machine, job, "pause", async () => true), { ok: true });
  assert.ok(written.includes("#15 6 * * * /bin/b"));
  assert.equal(parseCrontab("#15 6 * * * /bin/b")[0]!.enabled, false);
});

test("every day at clock times reads 매일, a cron hour list too; what cannot be said stays as written", () => {
  setLocale("ko");
  const [daily, other] = parseCrontab("0 10,22 * * * devreport\n*/30 9-18 * * 1-5 poll\n");
  assert.equal(text(daily!), "매일 10:00, 22:00");
  assert.equal(text(other!), "*/30 9-18 * * 1-5");
  assert.equal(scheduleText({ kind: "calendar", entries: [{ weekday: 1, hour: 9, minute: 5 }] }), "월 09:05");
});

test("a job's name from its id: a plist's file name, else what follows the source", () => {
  assert.equal(osJobName("launchd:/Users/me/Library/LaunchAgents/com.rafeed.collect.plist"), "com.rafeed.collect");
  assert.equal(osJobName("cron:0 9 * * * /bin/x"), "0 9 * * * /bin/x");
  assert.equal(osJobName("taskscheduler:\\Me\\backup"), "\\Me\\backup");
});

test("what the OS says about a job is read: Task Scheduler's Description, Author, program and folder; the account it ran as", () => {
  const [mine, google, tips] = parseWindowsTasks(JSON.stringify({ User: "PC\\me", Tasks: [
    { TaskName: "backup", TaskPath: "\\", State: 3, Author: "pc\\ME", Actions: [{ Execute: "C:\\w\\run.cmd", Arguments: "", WorkingDirectory: "C:\\w" }] },
    { TaskName: "Daily", TaskPath: "\\GoogleUserPEH\\", State: 3, Author: "PC\\other", Description: " Runs daily ", Actions: [{ Execute: "\"C:\\Program Files\\Google\\h.exe\"" }] },
    { TaskName: "tips", TaskPath: "\\", State: 3, Actions: [{}] },
  ] }));
  assert.deepEqual([mine!.mine, mine!.program, mine!.cwd], [true, "C:\\w\\run.cmd", "C:\\w"]);
  assert.deepEqual([google!.mine, google!.description, google!.program], [undefined, "Runs daily", "C:\\Program Files\\Google\\h.exe"]);
  assert.deepEqual([tips!.program, tips!.author, tips!.description], [undefined, undefined, undefined]);
  // Korean Descriptions come as UTF-8, not the console's code page.
  assert.ok(windowsListScript.includes("[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)"));
});

test("what launchd, cron and systemd say about a job is read", () => {
  const [agent] = parseLaunchd([{ file: "/Users/a/Library/LaunchAgents/x.plist", json: { Label: "x", ProgramArguments: ["/bin/x", "-y"], WorkingDirectory: "/w" } }], "");
  assert.deepEqual([agent!.program, agent!.cwd, agent!.file], ["/bin/x", "/w", "/Users/a/Library/LaunchAgents/x.plist"]);
  assert.equal(parseCrontab("0 1 * * * cd /w && ./run.sh -x")[0]!.program, "./run.sh");
  assert.equal(parseCrontab("0 1 * * * /bin/a b")[0]!.program, "/bin/a");
  const units = [
    "Id=backup.service", "Description=Nightly backup", "FragmentPath=/home/u/.config/systemd/user/backup.service",
    "ExecStart={ path=/home/u/bin/backup ; argv[]=/home/u/bin/backup --all ; ignore_errors=no }", "WorkingDirectory=!/home/u", "",
    "Id=idle.service", "Description=idle.service", "FragmentPath=/usr/lib/systemd/user/idle.service", "ExecStart=", "WorkingDirectory=",
  ].join("\n");
  const [backup, idle] = parseSystemdTimers("n/a n/a n/a n/a backup.timer backup.service\nn/a n/a n/a n/a idle.timer idle.service", units);
  assert.deepEqual([backup!.description, backup!.program, backup!.cwd, backup!.file, backup!.command],
    ["Nightly backup", "/home/u/bin/backup", "/home/u", "/home/u/.config/systemd/user/backup.service", "backup.service"]);
  assert.deepEqual([idle!.description, idle!.program, idle!.cwd, idle!.file], [undefined, undefined, undefined, "/usr/lib/systemd/user/idle.service"]);
  // The listing's own section reaches the parser.
  assert.equal(parsePosixListing(["@@lepons-osjobs:cron", "@@lepons-osjobs:timers", "n/a n/a n/a n/a backup.timer backup.service", "@@lepons-osjobs:units", units].join("\n"))[0]!.description, "Nightly backup");
  // The substitution is the argument itself, so zsh splits it as sh does.
  assert.ok(posixListScript("/h").includes("systemctl --user show --property=Id,Description,FragmentPath,ExecStart,WorkingDirectory -- $(systemctl --user list-timers"));
  assert.deepEqual(backup!.args, ["--all"]);
});

const task = (label: string, more: Partial<OsJob> = {}): OsJob => ({ id: `taskscheduler:${label}`, source: "taskscheduler", label, command: "", enabled: true, ...more });

test("a job's name in words: SIDs, GUIDs, long numbers and a trailing Task go; the first folder or a reverse-DNS vendor is its source", () => {
  assert.deepEqual(jobTitle(task("\\SoftLanding\\S-1-5-21-3877578454-1073624142-324005627-1001\\SoftLandingRefreshForExpirationTask-{febb167b-b0ea-405e-b0bb-e17ff211ff76}")),
    { name: "Soft Landing Refresh For Expiration", source: "SoftLanding" });
  assert.deepEqual(jobTitle(task("\\OneDrive Reporting Task-S-1-5-21-3877578454-1073624142-324005627-1001")), { name: "OneDrive Reporting" });
  assert.deepEqual(jobTitle(task("\\S-1-5-21-1-2-3-1001\\EnterpriseMgmt\\F4F7AFB9-7FE4-405F-88F7-0AE060B0C4F5\\Login Schedule created by enrollment client")),
    { name: "Login Schedule created by enrollment client", source: "EnterpriseMgmt" });
  assert.equal(jobTitle(task("\\SoftLanding\\S-1-5-21-1\\SoftLandingTriggerTask-128000000001615609-render-{09fce64c-c0e4-43d3-b1ea-0299e5a1a459}")).name, "Soft Landing Trigger Task render");
  assert.deepEqual(jobTitle(task("\\GoogleUserPEH\\RunPlatformExperienceHelper_Daily")), { name: "Run Platform Experience Helper Daily", source: "GoogleUserPEH" });
  assert.equal(jobTitle(task("\\C__Program Files_HeidiSQL_heidisql.exe")).name, "heidisql");
  assert.equal(jobTitle(task("\\RAONK Task 1.0")).name, "RAONK Task 1.0");
  // Letters of any script count as a name.
  assert.deepEqual(jobTitle(task("\\내폴더\\매일 백업")), { name: "매일 백업", source: "내폴더" });
  assert.equal(jobTitle(task("\\백업")).name, "백업");
  assert.equal(jobTitle(task("\\Task")).name, "Task");
  assert.equal(jobTitle(task("\\{febb167b-b0ea-405e-b0bb-e17ff211ff76}")).name, "\\{febb167b-b0ea-405e-b0bb-e17ff211ff76}");
  const launchd = (label: string): OsJob => ({ id: `launchd:/Users/a/Library/LaunchAgents/${label}.plist`, source: "launchd", label, command: "", enabled: true });
  assert.deepEqual(jobTitle(launchd("com.google.keystone.agent")), { name: "keystone agent", source: "Google" });
  assert.deepEqual(jobTitle(launchd("my-backup")), { name: "my backup" });
  assert.equal(jobTitle({ id: "systemd:backup.timer", source: "systemd", label: "backup.timer", command: "backup.service", enabled: true }).name, "backup");
  assert.equal(jobTitle(parseCrontab("0 1 * * * /home/u/bin/clean_logs.sh --old")[0]!).name, "clean logs sh");
});

test("what a job really runs: an interpreter's script, cmd /c's program, env's program; inline code leaves the interpreter", () => {
  const run = (program: string, ...args: string[]) => jobProgram({ id: "x", source: "cron", label: "x", command: "", enabled: true, program, args });
  assert.equal(run("/usr/bin/python3", "/home/u/backup.py"), "/home/u/backup.py");
  assert.equal(run("/usr/bin/python3", "-u", "/home/u/report.py", "--x"), "/home/u/report.py");
  assert.equal(run("python3", "-m", "http.server"), "http.server");
  assert.equal(run("python3", "-c", "print(1)"), "python3");
  assert.equal(run("/usr/bin/env", "-S", "LANG=C", "node", "/w/app.js"), "/w/app.js");
  assert.equal(run("/bin/bash", "-e", "/w/run.sh"), "/w/run.sh");
  assert.equal(run("/bin/sh", "-c", "/opt/homebrew/bin/python3 /Users/a/w/sync.py --all"), "/Users/a/w/sync.py");
  assert.equal(run("powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "C:\\Users\\me\\x.ps1"), "C:\\Users\\me\\x.ps1");
  assert.equal(run("pwsh.exe", "-Command", "& 'C:\\w\\y.ps1' -Now"), "C:\\w\\y.ps1");
  assert.equal(run("powershell.exe", "-Command", "Get-Date"), "powershell.exe");
  assert.equal(run("C:\\Windows\\System32\\cmd.exe", "/c", "C:\\w\\x.bat", "a"), "C:\\w\\x.bat");
  assert.equal(run("wscript.exe", "//B", "C:\\w\\x.vbs"), "C:\\w\\x.vbs");
  assert.equal(run("/usr/bin/rsync", "-a", "/x", "/y"), "/usr/bin/rsync");
  // The script is the first word that is not a flag; flags after it are the script's own.
  assert.equal(run("python3", "/w/backup.py", "-c", "conf.ini"), "/w/backup.py");
  assert.equal(run("node", "/w/app.js", "-e", "prod"), "/w/app.js");
  assert.equal(run("python3", "/w/x.py", "-m", "5"), "/w/x.py");
  assert.equal(run("bash", "/w/run.sh", "-c", "foo"), "/w/run.sh");
  // Combined shell flags carry -c; value-taking flags skip their value.
  assert.equal(run("/bin/zsh", "-lc", "cd /w && ./go.sh"), "./go.sh");
  assert.equal(run("/bin/bash", "-ic", "/w/go.sh --now"), "/w/go.sh");
  assert.equal(run("python3", "-W", "ignore", "/w/x.py"), "/w/x.py");
  assert.equal(run("python3", "-X", "utf8", "/w/x.py"), "/w/x.py");
  assert.equal(run("/usr/bin/env", "-u", "HOME", "python3", "/w/x.py"), "/w/x.py");
  assert.equal(run("node", "-r", "dotenv/config", "/w/app.js"), "/w/app.js");
  assert.equal(run("node", "--require", "ts-node/register", "/w/app.ts"), "/w/app.ts");
  // Launchers count as interpreters too.
  assert.equal(run("C:\\Program Files\\Python312\\pythonw.exe", "C:\\w\\x.py"), "C:\\w\\x.py");
  assert.equal(run("py.exe", "-3", "C:\\w\\x.py"), "C:\\w\\x.py");
  assert.equal(run("/usr/local/bin/uv", "run", "/w/x.py"), "/w/x.py");
  assert.equal(run("pipx", "run", "black"), "black");
  assert.equal(run("npx", "-y", "some-tool"), "some-tool");
  // Read that way by the parsers too: cron names two Python scripts apart; a Windows action's words.
  assert.equal(jobTitle(parseCrontab("0 1 * * * /usr/bin/python3 /home/u/backup.py")[0]!).name, "backup py");
  assert.equal(jobTitle(parseCrontab("0 2 * * * /usr/bin/python3 /home/u/report.py")[0]!).name, "report py");
  assert.equal(parseCrontab("0 1 * * * cd \"/w/a\" && ./run")[0]!.cwd, "/w/a");
  const [ps] = parseWindowsTasks(JSON.stringify({ User: "PC\\me", Tasks: [{ TaskName: "t", TaskPath: "\\", RunAs: "me", Actions: [{ Execute: "powershell.exe", Arguments: "-NoProfile -File \"C:\\Users\\me\\my scripts\\x.ps1\"" }] }] }));
  assert.deepEqual([ps!.args, ps!.runsAsMe, jobProgram(ps!)], [["-NoProfile", "-File", "C:\\Users\\me\\my scripts\\x.ps1"], true, "C:\\Users\\me\\my scripts\\x.ps1"]);
});

test("where a job comes from: the person's own first (project inside a folder), then OS, app with its vendor, then the rest", () => {
  const folders = [{ label: "lepons", path: "C:\\Users\\me\\projects\\lepons" }, { label: "cockpit", path: "C:/Users/me/projects/lepons/cockpit/" }, { label: "w", path: "/home/u/w" }, { label: "home", path: "C:\\Users\\me" }];
  const mine = { author: "PC\\me", mine: true };
  // Mine: inside a folder is that project (the deepest one); a longer name is not inside; an interpreter's place changes nothing.
  assert.deepEqual(jobOrigin(task("\\a", { ...mine, program: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", args: ["-File", "C:\\Users\\me\\projects\\lepons\\cockpit\\x.ps1"] }), folders), { kind: "project", name: "cockpit" });
  assert.deepEqual(jobOrigin(task("\\a", { ...mine, program: "C:\\x.exe", cwd: "c:\\users\\me\\projects\\lepons" }), folders), { kind: "project", name: "lepons" });
  assert.deepEqual(jobOrigin(task("\\a", { ...mine, program: "D:\\lepons2\\x.cmd" }), folders), { kind: "mine" });
  assert.deepEqual(jobOrigin(task("\\a", { ...mine, program: "powershell.exe", args: ["-File", "D:\\scripts\\sync.ps1"] }), folders), { kind: "mine" });
  assert.deepEqual(jobOrigin(parseCrontab("0 1 * * * cd /home/u/w && ./run")[0]!, folders), { kind: "project", name: "w" });
  assert.deepEqual(jobOrigin(parseCrontab("0 1 * * * /opt/x/run")[0]!, []), { kind: "mine" });
  // ... except a real program in an install folder, which is that app's (Chrome files its tasks under the person's name), even inside a registered home.
  assert.deepEqual(jobOrigin(task("\\x", { ...mine, program: "C:\\Program Files\\Google\\Chrome\\h.exe" }), []), { kind: "app", name: "Google" });
  assert.deepEqual(jobOrigin(task("\\x", { ...mine, program: "C:\\Users\\me\\AppData\\Local\\Programs\\Obsidian\\o.exe" }), folders), { kind: "app", name: "Obsidian" });
  assert.deepEqual(jobOrigin(task("\\x", { ...mine, program: "C:\\Users\\me\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe", args: ["--no-startup-window"] }), folders), { kind: "app", name: "Google" });
  // ... but a script or a folder behind an installed interpreter keeps the person's mark.
  assert.deepEqual(jobOrigin(task("\\x", { ...mine, program: "C:\\Program Files\\Python312\\pythonw.exe", args: ["C:\\Users\\me\\projects\\lepons\\x.py"] }), folders), { kind: "project", name: "lepons" });
  assert.deepEqual(jobOrigin(task("\\x", { ...mine, program: "C:\\Program Files\\Python312\\pythonw.exe", args: ["D:\\scripts\\x.py"] }), folders), { kind: "mine" });
  assert.deepEqual(jobOrigin(task("\\x", { ...mine, program: "C:\\Program Files\\Tool\\t.exe", cwd: "C:\\Users\\me\\projects\\lepons" }), folders), { kind: "project", name: "lepons" });
  // Windows: OS, app, the rest.
  assert.equal(jobOrigin(task("\\SoftLanding\\x"), []).kind, "os");
  assert.equal(jobOrigin(task("\\x", { program: "C:\\Program Files\\Microsoft OneDrive\\u.exe", author: "Microsoft Corporation" }), []).kind, "os");
  // A Microsoft-authored task is the OS's even when its script sits in a project.
  assert.equal(jobOrigin(task("\\a", { program: "powershell", args: ["-File", "C:\\Users\\me\\projects\\lepons\\x.ps1"], author: "Microsoft" }), folders).kind, "os");
  assert.equal(jobOrigin(task("\\x", { program: "%windir%\\system32\\deviceenroller.exe" }), []).kind, "os");
  assert.deepEqual(jobOrigin(task("\\x", { program: "C:\\ProgramData\\RAONWIZ\\r.exe", author: "HeidiSQL 12.15.0.7171" }), []), { kind: "app", name: "HeidiSQL" });
  // An account is not a vendor: NT AUTHORITY\SYSTEM's task with no other mark is an unnamed app; one that runs as me is mine.
  assert.deepEqual(jobOrigin(task("\\x", { program: "C:\\Tools\\t.exe", author: "NT AUTHORITY\\SYSTEM" }), []), { kind: "app" });
  assert.deepEqual(jobOrigin(task("\\x", { program: "powershell.exe", args: ["-File", "C:\\Users\\me\\s.ps1"], runsAsMe: true }), []), { kind: "mine" });
  assert.deepEqual(jobOrigin(task("\\x", { program: "C:\\Users\\me\\projects\\lepons\\x.exe" }), folders), { kind: "project", name: "lepons" });
  // launchd
  const agent = (label: string, program: string, args: string[] = [], file = `/Users/a/Library/LaunchAgents/${label}.plist`): OsJob => ({ id: `launchd:${file}`, source: "launchd", label, command: [program, ...args].join(" "), program, args, enabled: true, file });
  assert.equal(jobOrigin(agent("com.apple.x", "/usr/libexec/x"), []).kind, "os");
  assert.equal(jobOrigin(agent("x", "/System/Library/x", [], "/Library/LaunchAgents/x.plist"), []).kind, "os");
  assert.deepEqual(jobOrigin(agent("com.google.keystone.agent", "/Users/a/Library/Google/GoogleSoftwareUpdate/agent"), []), { kind: "app", name: "Google" });
  assert.deepEqual(jobOrigin(agent("homebrew.mxcl.postgresql@16", "/opt/homebrew/opt/postgresql@16/bin/postgres"), []), { kind: "app", name: "Homebrew" });
  assert.deepEqual(jobOrigin(agent("x.helper", "/Applications/Docker.app/Contents/helper"), []), { kind: "app", name: "Docker" });
  assert.deepEqual(jobOrigin(agent("com.me.backup", "/Users/a/bin/backup"), []), { kind: "mine" });
  // My LaunchAgent running Homebrew's Python is mine, its script in a folder a project.
  assert.deepEqual(jobOrigin(agent("com.me.sync", "/opt/homebrew/bin/python3", ["/Users/a/scripts/sync.py"]), []), { kind: "mine" });
  assert.deepEqual(jobOrigin(agent("com.me.sync", "/opt/homebrew/bin/python3", ["/home/u/w/sync.py"]), folders), { kind: "project", name: "w" });
  // systemd
  const unit = (file: string, program?: string): OsJob => ({ id: "systemd:x.timer", source: "systemd", label: "x.timer", command: "x.service", enabled: true, file, ...(program ? { program } : {}) });
  assert.equal(jobOrigin(unit("/usr/lib/systemd/user/x.service", "/usr/bin/x"), []).kind, "os");
  assert.equal(jobOrigin(unit("/lib/systemd/user/x.service", "/usr/bin/x"), []).kind, "os");
  assert.deepEqual(jobOrigin(unit("/etc/systemd/user/x.service", "/opt/acme/bin/x"), []), { kind: "app", name: "acme" });
  assert.deepEqual(jobOrigin(unit("/home/u/.config/systemd/user/x.service", "/home/u/bin/x"), []), { kind: "mine" });
  assert.deepEqual(jobOrigin(unit("/home/u/.config/systemd/user/x.service", "/usr/bin/node"), []), { kind: "mine" });
});

test("the AI line: its key changes with the command and the language; the answer is read strictly", () => {
  const job = task("\\SoftLanding\\S-1-5-21-1\\SoftLandingDeferralTask-{2b2be2f9-49ae-428d-bc49-05ddd079c15b}", { command: "a.exe -x" });
  const item = describeItem("pc", job, "ko");
  assert.equal(item.name, "Soft Landing Deferral");
  assert.equal(item.os, "Windows");
  assert.equal(describeItem("pc", job, "ko").key, item.key);
  assert.notEqual(describeItem("pc", { ...job, command: "a.exe -y" }, "ko").key, item.key);
  assert.notEqual(describeItem("pc", job, "en").key, item.key);
  assert.notEqual(describeItem("other", job, "ko").key, item.key);
  assert.ok(item.key.startsWith(`pc\n${job.id}\n`));
  assert.equal(describeItem("pc", { ...job, command: "a\tb\nc".repeat(100) }, "ko").run.length, 200);
  assert.equal(describeLines([item, { ...item, run: "" }]), `1\tSoft Landing Deferral\t${job.label}\ta.exe -x\tWindows\n2\tSoft Landing Deferral\t${job.label}\t-\tWindows`);
  const read = parseDescribed([
    "Here are the descriptions:", "1\tShows Windows tips later", "2 no tab here", "3\t\"Quoted line\"", "3\tsecond answer for 3", "9\tnot asked", "0\tzero", "4\t   ", `5\t${"x".repeat(200)}`, "",
  ].join("\r\n"), 5);
  assert.deepEqual([...read.entries()], [[1, "Shows Windows tips later"], [3, "Quoted line"], [5, "x".repeat(120)]]);
  assert.equal(parseDescribed("", 3).size, 0);
});

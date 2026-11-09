import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  UsageGate,
  readRemoteUsage,
  agyStatusLineCommand,
  agyStatusLineWith,
  agyUsageFile,
  claudeStatusLineCommand,
  claudeStatusLineSettings,
  claudeUsageFile,
  localUsage,
  newestUsage,
  ownStatusLine,
  parseAgyUsage,
  parseClaudeUsage,
  parseCodexUsage,
  parseUsageCommand,
  asStatusLineInput,
  remoteUsageScript,
  splitRemoteUsage,
  statusLineSettings,
} from "./usage.ts";

// Shapes as the two CLIs write them: Claude Code's status line input (per its
// docs; checked on 2.1.300) and a Codex 0.154 token_count event.
const claudeInput = JSON.stringify({
  model: { display_name: "Opus" },
  rate_limits: { five_hour: { used_percentage: 47, resets_at: 1792056600 }, seven_day: { used_percentage: 78.4, resets_at: 1792468800 } },
});
const codexEvent = JSON.stringify({
  type: "event_msg",
  payload: {
    type: "token_count",
    rate_limits: { primary: { used_percent: 88, window_minutes: 300, resets_at: 1 }, secondary: { used_percent: 14, window_minutes: 10080, resets_at: 2 } },
  },
});

// Antigravity's status line input, per its status line docs (quota bucket
// shape and the "gemini-weekly" id are from the docs' example; the 5-hour
// id is not documented, so this one is made up and found by its reset).
const agyInput = JSON.stringify({
  product: "antigravity",
  plan_tier: "Pro",
  quota: {
    "gemini-weekly": { remaining_fraction: 0.75, reset_time: "2026-07-06T07:50:32Z", reset_in_seconds: 560580 },
    "claude-weekly": { remaining_fraction: 0.5, reset_time: "2026-07-07T00:00:00Z", reset_in_seconds: 600000 },
    "short-bucket": { remaining_fraction: 0.875, reset_time: "2026-07-01T05:00:00Z", reset_in_seconds: 3600 },
    "credits": { remaining_amount: 120, reset_in_seconds: 100 },
    "off-weekly": { remaining_fraction: 0, disabled: true },
    "monthly-thing": { remaining_fraction: 0, reset_in_seconds: 2_000_000 },
  },
});

test("Antigravity's quota gives its 5-hour and 7-day use, the most used bucket of each", () => {
  assert.deepEqual(parseAgyUsage(agyInput), {
    fiveHour: { usedPercent: 12.5, resetsAt: Date.parse("2026-07-01T05:00:00Z") / 1000 },
    week: { usedPercent: 50, resetsAt: Date.parse("2026-07-07T00:00:00Z") / 1000 },
  });
  assert.equal(parseAgyUsage(JSON.stringify({ product: "antigravity" })), undefined, "before the quota is known");
  assert.equal(parseAgyUsage(JSON.stringify({ quota: { credits: { remaining_amount: 5 } } })), undefined);
  assert.equal(parseAgyUsage("not json"), undefined);
});

test("another PC's Antigravity reading comes back with the file's time", () => {
  const usage = splitRemoteUsage(`1793250000\n@@claude\n${claudeInput}\n@@agy\n1793250100\n${agyInput}\n@@codex\n${codexEvent}\n`);
  assert.equal(usage.claude?.fiveHour?.usedPercent, 47);
  assert.equal(usage.agy?.week?.usedPercent, 50);
  assert.equal(usage.agy?.at, 1793250100);
  assert.equal(usage.codex?.week?.usedPercent, 14);
  assert.deepEqual(splitRemoteUsage("\n@@claude\n\n@@agy\n\n@@codex\n"), {});
});

test("Claude's status line input gives its 5-hour and 7-day use", () => {
  assert.deepEqual(parseClaudeUsage(claudeInput), {
    fiveHour: { usedPercent: 47, resetsAt: 1792056600 },
    week: { usedPercent: 78.4, resetsAt: 1792468800 },
  });
  assert.equal(parseClaudeUsage(JSON.stringify({ model: {} })), undefined, "API-key sessions carry no rate_limits");
  assert.equal(parseClaudeUsage("not json"), undefined);
});

test("a plan with no 5-hour limit has no 5-hour reading, on every agent", () => {
  const codex = (limits: unknown) => parseCodexUsage(JSON.stringify({ timestamp: "2026-11-05T00:00:00Z", payload: { rate_limits: limits } }));
  const week = { used_percent: 40, window_minutes: 10080, resets_at: 9 };
  // The weekly limit is Codex's primary when it is the only one.
  assert.deepEqual(codex({ primary: week, secondary: null })?.fiveHour, undefined);
  assert.equal(codex({ primary: week, secondary: null })?.week?.usedPercent, 40);
  assert.equal(codex({ primary: null, secondary: week })?.fiveHour, undefined);
  assert.equal(codex({ primary: null, secondary: week })?.week?.usedPercent, 40);
  // Both, in either slot.
  const five = { used_percent: 10, window_minutes: 300, resets_at: 1 };
  assert.equal(codex({ primary: five, secondary: week })?.fiveHour?.usedPercent, 10);
  assert.equal(codex({ primary: week, secondary: five })?.fiveHour?.usedPercent, 10);
  assert.equal(codex({ primary: week, secondary: five })?.week?.usedPercent, 40);
  // An older record with no lengths still reads by slot.
  assert.equal(codex({ primary: { used_percent: 7 }, secondary: { used_percent: 8 } })?.fiveHour?.usedPercent, 7);
  assert.equal(codex({ primary: null, secondary: null }), undefined);

  for (const limits of [{ seven_day: { used_percentage: 5 } }, { five_hour: null, seven_day: { used_percentage: 5 } }, { five_hour: {}, seven_day: { used_percentage: 5 } }]) {
    const claude = parseClaudeUsage(JSON.stringify({ rate_limits: limits }));
    assert.equal(claude?.fiveHour, undefined);
    assert.equal(claude?.week?.usedPercent, 5);
  }

  const agy = parseAgyUsage(JSON.stringify({ quota: { "gemini-weekly": { remaining_fraction: 0.5, reset_in_seconds: 86400 } } }));
  assert.equal(agy?.fiveHour, undefined);
  assert.equal(agy?.week?.usedPercent, 50);
});

test("Codex's last rate_limits wins, past a line cut by tail", () => {
  const older = codexEvent.replace('"used_percent":88', '"used_percent":10');
  assert.deepEqual(parseCodexUsage(`{"type":"x","rate_limits":{trunc\n${older}\n${codexEvent}\n{"type":"event_msg"}`), {
    fiveHour: { usedPercent: 88, resetsAt: 1 },
    week: { usedPercent: 14, resetsAt: 2 },
  });
  assert.equal(parseCodexUsage('{"type":"event_msg"}'), undefined);
});

test("another PC's readings come back from one command", () => {
  const usage = splitRemoteUsage(`1793250000\n@@claude\n${claudeInput}\n@@codex\n${codexEvent}\n`);
  assert.equal(usage.claude?.fiveHour?.usedPercent, 47);
  assert.equal(usage.claude?.at, 1793250000, "when the file was saved");
  assert.equal(usage.codex?.week?.usedPercent, 14);
  assert.deepEqual(splitRemoteUsage("\n@@claude\n\n@@codex\n"), {}, "nothing saved yet reads as nothing");
});

test("Codex readings carry the time of their line", () => {
  const line = JSON.stringify({ timestamp: "2026-10-28T01:52:19.190Z", ...JSON.parse(codexEvent) });
  assert.equal(parseCodexUsage(line)?.at, Math.floor(Date.parse("2026-10-28T01:52:19.190Z") / 1000));
});

// The limits are the account's, so any PC's reading will do -- the newest.
// This PC's file used to win even when it was a day old and another PC's
// session had just replied.
test("the newest reading of each agent wins, wherever it came from", () => {
  const usage = newestUsage([
    { claude: { at: 100, week: { usedPercent: 10 } }, codex: { at: 300, week: { usedPercent: 3 } }, agy: { at: 1, week: { usedPercent: 5 } } },
    { claude: { at: 200, fiveHour: { usedPercent: 20 }, week: { usedPercent: 12 } }, agy: { at: 2, week: { usedPercent: 6 } } },
    { codex: { week: { usedPercent: 99 } } },
  ]);
  assert.equal(usage.claude?.at, 200);
  assert.equal(usage.claude?.fiveHour?.usedPercent, 20);
  assert.equal(usage.codex?.week?.usedPercent, 3, "a reading with no time loses to one with");
  assert.equal(usage.agy?.at, 2);
});

// An operator with a status line of their own (a HUD, say) used to get no
// usage at all. Lepons now saves the input and hands it on to theirs.
test("an own status line still runs, after the input is saved", async () => {
  const home = mkdtempSync(join(tmpdir(), "lepons-own-"));
  try {
    mkdirSync(join(home, ".claude"));
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ statusLine: { type: "command", command: "cat > ~/own.txt; printf hud", padding: 1 } }));
    const own = await ownStatusLine(home);
    assert.equal(own?.padding, 1);
    const line = JSON.parse(statusLineSettings(own)).statusLine;
    assert.equal(line.padding, 1, "the operator's other status line options are kept");
    const out = execFileSync("sh", ["-c", line.command], { input: claudeInput, env: { ...process.env, HOME: home } }).toString();
    assert.equal(out, "hud", "their status line still shows");
    assert.equal(readFileSync(join(home, claudeUsageFile), "utf8"), claudeInput);
    assert.equal(readFileSync(join(home, "own.txt"), "utf8"), claudeInput, "and gets the same input");
    assert.equal(statusLineSettings(undefined), claudeStatusLineSettings);
    assert.equal(await ownStatusLine(join(home, "none")), undefined);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("this PC's readings: the saved Claude and Antigravity files and the newest Codex record", async () => {
  const home = mkdtempSync(join(tmpdir(), "lepons-usage-"));
  try {
    writeFileSync(join(home, claudeUsageFile), claudeInput);
    writeFileSync(join(home, agyUsageFile), agyInput);
    const day = join(home, ".codex", "sessions", "2026", "10", "15");
    mkdirSync(day, { recursive: true });
    writeFileSync(join(day, "rollout-a.jsonl"), `${JSON.stringify({ type: "session_meta", payload: { cwd: "/any" } })}\n${codexEvent}\n`);
    const usage = await localUsage(home);
    assert.equal(usage.claude?.week?.usedPercent, 78.4);
    assert.equal(usage.codex?.fiveHour?.usedPercent, 88);
    assert.equal(usage.agy?.fiveHour?.usedPercent, 12.5);
    assert.equal(typeof usage.agy?.at, "number");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// Every open session runs the status line; one that has not replied yet
// carries no rate_limits and must not wipe what another session saved.
// Run for real in sh (Git Bash here, as Claude Code itself uses on Windows).
test("the status line saves an input with rate_limits and ignores one without", () => {
  assert.equal(JSON.parse(claudeStatusLineSettings).statusLine.command, claudeStatusLineCommand);
  const home = mkdtempSync(join(tmpdir(), "lepons-sl-"));
  const run = (input: string) =>
    execFileSync("sh", ["-c", claudeStatusLineCommand], { input, env: { ...process.env, HOME: home } });
  try {
    run(claudeInput);
    run(JSON.stringify({ model: { display_name: "Opus" } }));
    assert.equal(readFileSync(join(home, claudeUsageFile), "utf8"), claudeInput);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("agy's settings get the saving status line only where none is set", () => {
  const added = agyStatusLineWith('{\n  "agentMode": "plan"\n}', "posix");
  assert.deepEqual(JSON.parse(added!), {
    agentMode: "plan",
    statusLine: { type: "command", command: agyStatusLineCommand("posix"), stack_with_default: true },
  });
  assert.ok(agyStatusLineWith(undefined, "cmd")!.includes("%USERPROFILE%"), "a missing file is created");
  assert.equal(agyStatusLineWith(added, "posix"), undefined, "already ours");
  assert.equal(agyStatusLineWith(JSON.stringify({ statusLine: { command: "my-hud" } }), "posix"), undefined, "the operator's own stays");
  assert.equal(agyStatusLineWith("{oops", "posix"), undefined, "never rewrites what it cannot read");
  assert.equal(agyStatusLineWith("[]", "posix"), undefined);
});

// agy runs the command with sh -c, or cmd /c on Windows (status line docs).
test("agy's status line saves its input, in sh", () => {
  const home = mkdtempSync(join(tmpdir(), "lepons-agy-"));
  try {
    execFileSync("sh", ["-c", agyStatusLineCommand("posix")], { input: agyInput, env: { ...process.env, HOME: home } });
    assert.equal(readFileSync(join(home, agyUsageFile), "utf8"), agyInput);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("agy's status line saves its input, in cmd", { skip: process.platform !== "win32" }, () => {
  const home = mkdtempSync(join(tmpdir(), "lepons-agy-"));
  try {
    execSync(agyStatusLineCommand("cmd"), { input: agyInput, shell: "cmd.exe", env: { ...process.env, USERPROFILE: home } });
    assert.deepEqual(JSON.parse(readFileSync(join(home, agyUsageFile), "utf8")), JSON.parse(agyInput));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a PC's usage is read once at a time, at most once a window, and a read asked for too soon runs at its end", async () => {
  let clock = 0, reads = 0, later = 0;
  const gate = new UsageGate(10_000, () => clock);
  let finish!: () => void;
  const read = () => { reads++; return new Promise<number>((done) => (finish = () => done(1))); };
  const first = gate.run("mac", read, () => later++);
  assert.ok(first);
  assert.equal(gate.run("mac", read, () => later++), first, "while one runs, the same read is shared");
  assert.equal(reads, 1);
  finish();
  await first;
  clock = 4000;
  assert.equal(gate.run("mac", read, () => later++), undefined, "too soon");
  assert.equal(gate.run("mac", read, () => later++), undefined);
  assert.ok(gate.run("vm", read, () => later++), "another PC has its own window");
  assert.equal(reads, 2);
  clock = 10_000;
  assert.ok(gate.run("mac", read, () => later++), "the window is over");
  assert.equal(reads, 3);
  gate.clear();
});

test("a read put off does not run after the gate is cleared (quit)", async () => {
  let later = 0;
  const gate = new UsageGate(30);
  await gate.run("mac", async () => 1, () => later++);
  gate.run("mac", async () => 1, () => later++);
  gate.clear();
  await new Promise((done) => setTimeout(done, 80));
  assert.equal(later, 0);
});

test("a read put off runs once when its window ends", async () => {
  let later = 0;
  const gate = new UsageGate(30);
  await gate.run("mac", async () => 1, () => later++);
  gate.run("mac", async () => 1, () => later++);
  gate.run("mac", async () => 1, () => later++);
  await new Promise((done) => setTimeout(done, 80));
  assert.equal(later, 1);
});

test("a read that read nothing gives its window back", async () => {
  let clock = 0;
  const gate = new UsageGate(10_000, () => clock);
  assert.equal(await gate.run("mac", async () => undefined, () => {}), undefined);
  clock = 1000;
  const next = gate.run("mac", async () => "read", () => {});
  assert.ok(next, "nothing ran, so the next read is not put off");
  assert.equal(await next, "read");
  assert.equal(gate.run("mac", async () => "again", () => {}), undefined, "a read that ran keeps its window");
  gate.clear();
});

test("a PC's usage is read through the pool, else by one exec of its own, and given up when stuck", async () => {
  let oneShots = 0;
  const oneShot = async () => { oneShots++; return "own"; };
  assert.equal(await readRemoteUsage(async () => "pooled", oneShot, 1000), "pooled");
  assert.equal(oneShots, 0, "the pool read, so no exec of its own");
  assert.equal(await readRemoteUsage(async () => undefined, oneShot, 1000), "own", "pool off: one exec of its own");
  assert.equal(await readRemoteUsage(async () => undefined, () => new Promise(() => {}), 20), undefined, "stuck: given up");
  assert.equal(await readRemoteUsage(() => new Promise(() => {}), oneShot, 20), undefined);
});

test("the remote usage script finds Codex's record under a home with a space", () => {
  const home = mkdtempSync(join(tmpdir(), "lepons usage-")).replaceAll("\\", "/");
  const dir = join(home, ".codex/sessions/2026/11/04");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "rollout-a.jsonl"), `${codexEvent}\n`);
  try {
    const output = execFileSync("bash", ["-c", remoteUsageScript], { encoding: "utf8", env: { ...process.env, HOME: home } });
    assert.equal(splitRemoteUsage(output).codex?.fiveHour?.usedPercent, 88);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("Claude's /usage reads as a reading, its reset times in this PC's time", () => {
  const now = new Date(2026, 10, 9, 16, 40);
  const text = [
    "You are currently using your subscription to power your Claude Code usage",
    "",
    "Current session: 12% used · resets 5pm (Asia/Seoul)",
    "Current week (all models): 74% used · resets Nov 10, 12:59pm (Asia/Seoul)",
    "Current week (Fable): 0% used · resets Nov 10, 1pm (Asia/Seoul)",
  ].join("\n");
  const read = parseUsageCommand(text, now)!;
  assert.deepEqual(read, {
    fiveHour: { usedPercent: 12, resetsAt: new Date(2026, 10, 9, 17, 0).getTime() / 1000 },
    week: { usedPercent: 74, resetsAt: new Date(2026, 10, 10, 12, 59).getTime() / 1000 },
  });
  // Back through the usage file, as the status line's input.
  assert.deepEqual(parseClaudeUsage(asStatusLineInput(read)), read);
  // A time with no date that has passed is tomorrow's; a December reset read in January is this year's.
  assert.equal(parseUsageCommand("Current session: 3% used · resets 9am", now)!.fiveHour!.resetsAt, new Date(2026, 10, 10, 9, 0).getTime() / 1000);
  assert.equal(parseUsageCommand("Current week (all models): 1% used · resets Jan 2, 1am", new Date(2026, 11, 30))!.week!.resetsAt, new Date(2027, 0, 2, 1, 0).getTime() / 1000);
  assert.equal(parseUsageCommand("Current week (all models): 5% used", now)!.week!.resetsAt, undefined);
  assert.equal(parseUsageCommand("Not logged in · Please run /login", now), undefined);
});

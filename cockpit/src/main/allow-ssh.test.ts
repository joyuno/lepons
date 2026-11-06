import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import ssh2 from "ssh2";

import {
  allowSshScript,
  sshdConfigFunctions,
  sshdConfigMarker,
  authorizedKeyLine,
  disallowSshScript,
  elevatedOutcome,
  elevatedScript,
  encodeCommand,
  errorHint,
  firewallRule,
  parseWhoami,
  gitBashCandidates,
  isPerUserGit,
  launcherArgs,
  reportFile,
  unsafeFolderExit,
} from "./allow-ssh.ts";

const env = { ProgramW6432: "C:\\Program Files", ProgramFiles: "C:\\Program Files (x86)", LOCALAPPDATA: "C:\\Users\\김철수\\AppData\\Local" };
const bash = gitBashCandidates(env);

test("Git Bash is looked for in 64-bit Program Files, then Program Files, then this user's own install", () => {
  assert.deepEqual(bash, [
    "C:\\Program Files\\Git\\bin\\bash.exe",
    "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
    "C:\\Users\\김철수\\AppData\\Local\\Programs\\Git\\bin\\bash.exe",
  ]);
  assert.equal(gitBashCandidates({ ProgramFiles: "C:\\Program Files" }).length, 1, "the same folder is not asked twice");
  assert.equal(isPerUserGit(bash[2]!, env), true);
  assert.equal(isPerUserGit(bash[0]!, env), false);
});

test("turning on: sshd with Git Bash as its shell, reachable from the local network only", () => {
  const script = allowSshScript("id1", bash, false);
  assert.match(script, /Add-WindowsCapability -Online -Name \$cap\.Name/);
  assert.match(script, /if \(\$added\.RestartNeeded\) \{ Say 'restart' \}/);
  assert.match(script, /-Name DefaultShell -Value \$bash/);
  assert.match(script, /Set-Service -Name sshd -StartupType Automatic/);
  assert.match(script, /-LocalPort 22 -RemoteAddress LocalSubnet /);
  // An earlier version's tailnet-only rule goes, so only one Lepons rule is left.
  assert.match(script, /Remove-NetFirewallRule -Name 'Lepons-SSH-LAN','Lepons-SSH-Tailscale'/);
  // The capability's own allow-from-anywhere rule is switched off, or the LAN rule limits nothing.
  assert.match(script, /OpenSSH-Server-In-TCP' -ErrorAction SilentlyContinue \| Disable-NetFirewallRule/);
  assert.doesNotMatch(script, /winget/);
  assert.match(allowSshScript("id1", bash, true), /winget install --id Git\.Git -e/);
});

test("turning on records what was there first, once, before changing anything", () => {
  const script = allowSshScript("id1", bash, false);
  const record = script.indexOf("ssh-prev.json");
  assert.ok(record > 0 && record < script.indexOf("Add-WindowsCapability") && record < script.indexOf("Disable-NetFirewallRule"));
  assert.match(script, /if \(-not \(Test-Path -LiteralPath \$prev\)\)/);
  for (const field of ["sshd =", "running =", "startType =", "ruleEnabled =", "shell ="]) assert.ok(script.includes(field), field);
});

test("turning off puts back what turning on found, and removes only Lepons' rule", () => {
  const script = disallowSshScript("id1");
  assert.match(script, new RegExp(`Remove-NetFirewallRule -Name '${firewallRule}','Lepons-SSH-Tailscale'`));
  assert.match(script, /if \(\$before -and \$before\.ruleEnabled\) \{ Get-NetFirewallRule -Name 'OpenSSH-Server-In-TCP'.*Enable-NetFirewallRule/);
  // An sshd that was already running before Lepons is left running.
  assert.match(script, /if \(-not \$before\.running\) \{ Stop-Service -Name sshd -Force \}/);
  assert.match(script, /Remove-ItemProperty -Path 'HKLM:\\SOFTWARE\\OpenSSH' -Name DefaultShell/);
  assert.doesNotMatch(script, /Remove-WindowsCapability/);
});

test("the script travels encoded, so a Korean path survives and no file can be swapped", () => {
  const script = allowSshScript("id1", bash, true);
  const args = launcherArgs(script);
  const encoded = /-EncodedCommand (\S+)'/.exec(args.at(-1)!)?.[1];
  assert.equal(Buffer.from(encoded!, "base64").toString("utf16le"), script);
  assert.ok(script.includes("김철수"));
  assert.doesNotMatch(args.join(" "), /\.ps1|-File /);
  // CreateProcess allows 32767 characters for the whole command line.
  assert.ok(["powershell.exe", ...args].join(" ").length < 30000, `${args.join(" ").length} characters`);
  // Still so with the longest key likely pasted (RSA 4096) on an administrator.
  const rsa = String(ssh2.utils.generateKeyPairSync("rsa", { bits: 4096 }).public);
  const keyed = launcherArgs(allowSshScript("id1", bash, true, { line: authorizedKeyLine(rsa)!, home: "C:\\Users\\김철수", sid: "S-1-5-21-1", admin: true }));
  assert.ok(["powershell.exe", ...keyed].join(" ").length < 30000, `${keyed.join(" ").length} characters`);
  assert.equal(encodeCommand("a"), "YQA=");
});

test("how a run went: declined, done, refused, or never ran", () => {
  const id = "abc";
  const bom = "\uFEFF";
  assert.deepEqual(elevatedOutcome(1223, "", "", id), { kind: "cancelled" });
  assert.deepEqual(elevatedOutcome(0, "", `${bom}abc ok\r\n`, id), { kind: "ok", restart: false });
  assert.deepEqual(elevatedOutcome(0, "", "abc restart\r\nabc ok\r\n", id), { kind: "ok", restart: true });
  assert.deepEqual(elevatedOutcome(1, "", "abc error: Access denied\r\n", id), { kind: "failed", reason: "error", detail: "Access denied" });
  assert.deepEqual(elevatedOutcome(unsafeFolderExit, "", "", id), { kind: "failed", reason: "unsafe", detail: "" });
  // No report from this run -- an old run's "ok" does not count -- is never taken for a declined prompt.
  assert.deepEqual(elevatedOutcome(0, "", "old ok\r\n", id), { kind: "failed", reason: "notRun", detail: "exit 0" });
  assert.deepEqual(elevatedOutcome(2, "boom", "", id), { kind: "failed", reason: "notRun", detail: "exit 2\nboom" });
});

const pub = (type: "ed25519" | "rsa" | "ecdsa") =>
  String(ssh2.utils.generateKeyPairSync(type, type === "rsa" ? { bits: 2048 } : type === "ecdsa" ? { bits: 256 } : {}).public).trim();
const ed = pub("ed25519");
const edBody = ed.split(" ")[1]!;

test("a pasted key: one line, a known type, no options, a real key; the comment is replaced", () => {
  assert.equal(authorizedKeyLine(`  ${ed}\r\n`), `ssh-ed25519 ${edBody} lepons`);
  assert.equal(authorizedKeyLine(`ssh-ed25519 ${edBody} me@pc it's mine; $(calc)`), `ssh-ed25519 ${edBody} lepons`);
  assert.match(authorizedKeyLine(pub("rsa"))!, /^ssh-rsa [A-Za-z0-9+/]+=* lepons$/);
  assert.match(authorizedKeyLine(pub("ecdsa"))!, /^ecdsa-sha2-nistp256 [A-Za-z0-9+/]+=* lepons$/);
  for (const bad of [
    "",
    `command="calc" ${ed}`,
    `no-pty ${ed}`,
    `${ed}\n${ed}`,
    `ssh-dss ${edBody}`,
    `ssh-rsa ${edBody}`, // the type does not match the body
    `ssh-ed25519 ${edBody.slice(0, -4)}`,
    `ssh-ed25519 ${edBody}'; calc; '`,
    "-----BEGIN OPENSSH PRIVATE KEY-----",
  ]) assert.equal(authorizedKeyLine(bad), undefined, bad);
});

test("whoami tells this account's SID and whether it is an administrator", () => {
  const user = '"pc\\김철수","S-1-5-21-1-2-3-1001"\r\n\r\n"Everyone","x","S-1-1-0","y"\r\n';
  assert.deepEqual(parseWhoami(user), { sid: "S-1-5-21-1-2-3-1001", admin: false });
  assert.deepEqual(parseWhoami(`${user}"BUILTIN\\Administrators","x","S-1-5-32-544","y"\r\n`), { sid: "S-1-5-21-1-2-3-1001", admin: true });
  assert.equal(parseWhoami("Access denied"), undefined);
});

test("a pasted key goes into the user's authorized_keys, and an administrator's into administrators_authorized_keys too", () => {
  const key = { line: authorizedKeyLine(ed)!, home: "C:\\Users\\O'Brien 김", sid: "S-1-5-21-1-2-3-1001", admin: true };
  const script = allowSshScript("id1", bash, false, key);
  // Every value is a single-quoted PowerShell literal, its own quote doubled.
  assert.ok(script.includes(`$key = 'ssh-ed25519 ${edBody} lepons'`));
  assert.ok(script.includes(`$body = '${edBody}'`));
  assert.ok(script.includes("$sid = 'S-1-5-21-1-2-3-1001'"));
  assert.ok(script.includes("$ssh = Join-Path 'C:\\Users\\O''Brien 김' '.ssh'"));
  assert.match(script, /icacls\.exe \$auth \/setowner \('\*' \+ \$sid\)/);
  assert.match(script, /\$adminKeys = Join-Path \$sshData 'administrators_authorized_keys'/);
  assert.match(script, /icacls\.exe \$adminKeys \/inheritance:r \/grant:r '\*S-1-5-32-544:F' '\*S-1-5-18:F'/);
  // Written after sshd is set up, inside the try that reports.
  assert.ok(script.indexOf("AddKey $auth") > script.indexOf("New-NetFirewallRule"));
  assert.ok(script.indexOf("AddKey $auth") < script.indexOf("Say 'ok'"));

  assert.doesNotMatch(allowSshScript("id1", bash, false, { ...key, admin: false }), /administrators_authorized_keys/);
  // Without a key, the default path is untouched.
  assert.doesNotMatch(allowSshScript("id1", bash, false), /authorized_keys|\$key/);
});

test("known failures are told in plain words, with what to do next", () => {
  assert.equal(errorHint("OpenSSH Server is not offered on this Windows"), "allow.err.noOpenSsh");
  assert.equal(errorHint("winget is missing: install Git for Windows from https://git-scm.com"), "allow.err.noWinget");
  assert.equal(errorHint("Add-WindowsCapability failed: Add-WindowsCapability failed. Error code = 0x800f0954"), "allow.err.capability");
  assert.equal(errorHint("Access denied"), undefined);
  // The strings matched are the ones the script throws.
  const script = allowSshScript("id1", bash, true);
  for (const text of ["OpenSSH Server is not offered", "winget is missing", "Add-WindowsCapability failed: "]) assert.ok(script.includes(text), text);
});

// The sshd_config rewrite, run as PowerShell on text only: nothing on disk is read or written.
// Each text goes through AdminKeysOff, then AdminKeysOn, then AdminKeysOff twice -- one PowerShell for all.
const sshdTransforms = (texts: string[]): { off: string; on: string; twice: string }[] => {
  const b64 = (text: string) => Buffer.from(text).toString("base64");
  const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodeCommand([
    ...sshdConfigFunctions,
    "function B($s) { [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($s)) }",
    `foreach ($b in @(${texts.map((text) => `'${b64(text)}'`).join(", ")})) {`,
    "  $t = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b)); $off = AdminKeysOff $t",
    "  (B $off) + ' ' + (B (AdminKeysOn $off)) + ' ' + (B (AdminKeysOff $off))",
    "}",
  ].join("\r\n"))], { encoding: "utf8" });
  const text = (value: string) => Buffer.from(value, "base64").toString("utf8");
  return out.trim().split(/\r?\n/).map((line) => line.split(" ")).map(([off, on, twice]) => ({ off: text(off!), on: text(on!), twice: text(twice!) }));
};

test("allow switches off Windows' admin-keys block in sshd_config, and off puts it back exactly", { skip: process.platform !== "win32" }, () => {
  const shipped = "#PasswordAuthentication yes\r\nSubsystem\tsftp\tsftp-server.exe\r\n\r\nMatch Group administrators\r\n       AuthorizedKeysFile __PROGRAMDATA__/ssh/administrators_authorized_keys\r\n";
  // Another Match block, before or after, is left alone; so is a file with no such block, or one the user commented out.
  const mixed = "Match User bob\nX11Forwarding no\nMatch Group administrators\nAuthorizedKeysFile a\nMatch all\nPermitTTY yes\n";
  const untouched = ["Port 22\r\n", "#Match Group administrators\r\n#AuthorizedKeysFile a\r\n"];
  const [a, b, ...rest] = sshdTransforms([shipped, mixed, ...untouched]);
  assert.equal(a!.off, "#PasswordAuthentication yes\r\nSubsystem\tsftp\tsftp-server.exe\r\n\r\n" +
    `${sshdConfigMarker}Match Group administrators\r\n${sshdConfigMarker}       AuthorizedKeysFile __PROGRAMDATA__/ssh/administrators_authorized_keys\r\n`);
  assert.equal(a!.twice, a!.off, "a second allow changes nothing");
  assert.equal(a!.on, shipped, "CRLF and all, byte for byte");
  assert.equal(b!.off,
    `Match User bob\nX11Forwarding no\n${sshdConfigMarker}Match Group administrators\n${sshdConfigMarker}AuthorizedKeysFile a\nMatch all\nPermitTTY yes\n`);
  assert.equal(b!.on, mixed);
  rest.forEach((result, i) => assert.deepEqual(result, { off: untouched[i], on: untouched[i], twice: untouched[i] }));
});

test("allow rewrites sshd_config after sshd first starts, on every allow; off undoes it", () => {
  const on = allowSshScript("id1", bash, false);
  // After Start-Service, which is outside the once-only ssh-prev.json record:
  // a PC allowed by an older Lepons gets it by allowing again.
  assert.ok(on.indexOf("AdminKeysOff $text") > on.indexOf("Start-Service -Name sshd"));
  assert.match(on, /Restart-Service -Name sshd -Force/);
  assert.match(disallowSshScript("id1"), /\$new = AdminKeysOn \$text/);
});

// Parsed by PowerShell itself, never run: a syntax slip would otherwise show
// up only behind a UAC prompt on someone else's PC.
test("the scripts and the launcher parse as PowerShell", { skip: process.platform !== "win32" }, () => {
  const key = { line: authorizedKeyLine(ed)!, home: "C:\\Users\\O'Brien", sid: "S-1-5-21-1", admin: true };
  for (const script of [allowSshScript("id1", bash, true), allowSshScript("id1", bash, true, key), disallowSshScript("id1"), launcherArgs("x").at(-1)!]) {
    const errors = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-Command", "$e = $null; [void][System.Management.Automation.Language.Parser]::ParseInput([Console]::In.ReadToEnd(), [ref]$null, [ref]$e); $e.Count"],
      { input: script, encoding: "utf8" },
    );
    assert.equal(errors.trim(), "0");
  }
});

// The wrapper itself, run unelevated against a stand-in ProgramData with a
// body that changes nothing: it makes its folder, fails to hand it to
// Administrators (no elevation), and says so in the report -- the path a
// real failure takes. A folder it did not make is refused untouched.
test("the elevated wrapper reports through its own folder and refuses one it did not make", { skip: process.platform !== "win32" }, () => {
  const root = mkdtempSync(join(tmpdir(), "lepons-allow-"));
  // The variable keeps whatever case Windows gave it (PROGRAMDATA); a second
  // key in another case would leave the real C:\ProgramData in use.
  const key = Object.keys(process.env).find((name) => name.toLowerCase() === "programdata") ?? "ProgramData";
  const envFor = (programData: string) => ({ ...process.env, [key]: programData });
  const run = (programData: string) => {
    const seen = execFileSync("powershell.exe", ["-NoProfile", "-Command", "$env:ProgramData"], { env: envFor(programData), encoding: "utf8" });
    assert.equal(seen.trim(), programData, "refusing to run against the real ProgramData");
    return spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodeCommand(elevatedScript("t1", ["Say 'body'"]))], {
      env: envFor(programData),
    });
  };
  try {
    const fresh = join(root, "fresh");
    mkdirSync(fresh);
    const first = run(fresh);
    const report = readFileSync(reportFile(fresh), "utf8");
    const outcome = elevatedOutcome(first.status ?? -1, String(first.stderr), report, "t1");
    // Elevated (an admin running the suite) the body runs; otherwise the ACL step refuses.
    if (outcome.kind === "ok") assert.match(report, /t1 body/);
    else assert.deepEqual([outcome.kind, outcome.kind === "failed" && outcome.reason], ["failed", "error"]);

    const planted = join(root, "planted");
    mkdirSync(join(planted, "Lepons"), { recursive: true });
    const second = run(planted);
    assert.equal(second.status, unsafeFolderExit);
    assert.equal(existsSync(reportFile(planted)), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

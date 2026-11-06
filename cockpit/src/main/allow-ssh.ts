import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, win32 } from "node:path";
// ssh2 is CommonJS; its named exports are not statically detectable.
import ssh2 from "ssh2";

/**
 * "다른 PC에서 이 PC에 연결 허용" on Windows: one elevated PowerShell run that
 * turns on Windows' own OpenSSH server with Git Bash as its shell (what the
 * remote side of Lepons speaks; see ssh/windows.ts), reachable from this
 * PC's local network only. By default the key is not handled here: adding the PC from
 * the other Lepons asks for this PC's password once and installs the key
 * itself into ~/.ssh/authorized_keys (ssh/keys.ts), which this script makes
 * count for administrators too (sshdConfigFunctions). An account
 * with no password to give (PIN / Windows Hello only) pastes the other PC's
 * key instead, and this script writes it (KeyFor).
 *
 * The script travels as -EncodedCommand (UTF-16), never as a file: a .ps1 in
 * the user's temp folder could be swapped between writing it and the UAC
 * prompt being accepted, and Windows PowerShell would read a non-ASCII path
 * in it (a Korean user name) in the ANSI code page. What it reports comes
 * back through %ProgramData%\Lepons, which only Administrators and SYSTEM
 * may write; this side only ever reads it.
 */

export const firewallRule = "Lepons-SSH-LAN";
/** The rule earlier versions made (tailnet ranges only): taken away wherever Lepons' own rule is. */
export const oldFirewallRule = "Lepons-SSH-Tailscale";
/** What the OpenSSH capability adds: TCP 22 from anywhere. Disabled while allowed, restored after. */
export const defaultFirewallRule = "OpenSSH-Server-In-TCP";

/** Where Git for Windows puts bash: for all users (64-bit Program Files first), then for this user only. */
export function gitBashCandidates(env: NodeJS.ProcessEnv): string[] {
  const roots = [env.ProgramW6432, env.ProgramFiles, "C:\\Program Files"].filter((root): root is string => !!root);
  return [
    ...new Set(roots.map((root) => win32.join(root, "Git", "bin", "bash.exe"))),
    ...(env.LOCALAPPDATA ? [win32.join(env.LOCALAPPDATA, "Programs", "Git", "bin", "bash.exe")] : []),
  ];
}

export const findGitBash = (env: NodeJS.ProcessEnv = process.env): string | undefined =>
  gitBashCandidates(env).find((path) => existsSync(path));

/** A Git installed for this user only: DefaultShell then works for this account's logins alone. */
export const isPerUserGit = (bash: string, env: NodeJS.ProcessEnv = process.env): boolean =>
  !!env.LOCALAPPDATA && bash.toLowerCase().startsWith(env.LOCALAPPDATA.toLowerCase());

const psQuote = (value: string) => `'${value.replaceAll("'", "''")}'`;

export const reportDir = (programData: string) => join(programData, "Lepons");
export const reportFile = (programData: string) => join(reportDir(programData), "ssh-result.txt");
/** The elevated script's exit code when %ProgramData%\Lepons is not one it made: it stops without writing. */
export const unsafeFolderExit = 3;

/**
 * Every report line starts with this run's id, so a file left by an earlier
 * run is never read as this one's answer: `<id> ok`, `<id> restart`, or
 * `<id> error:<message>`.
 */
export function elevatedScript(id: string, body: string[]): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    `$id = ${psQuote(id)}`,
    "$dir = Join-Path $env:ProgramData 'Lepons'",
    "$result = Join-Path $dir 'ssh-result.txt'",
    "function Say($text) { Add-Content -LiteralPath $result -Value ($id + ' ' + $text) -Encoding UTF8 }",
    // A folder someone else made (or a link planted in its place) could
    // point these writes anywhere; only one this script made, owned by
    // Administrators, is used.
    "if (Test-Path -LiteralPath $dir) {",
    "  $item = Get-Item -LiteralPath $dir -Force",
    "  $owner = (Get-Acl -LiteralPath $dir).GetOwner([Security.Principal.SecurityIdentifier]).Value",
    `  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or ($owner -notin 'S-1-5-32-544', 'S-1-5-18')) { exit ${unsafeFolderExit} }`,
    "} else { New-Item -ItemType Directory -Path $dir | Out-Null }",
    "try {",
    "  & icacls.exe $dir /setowner '*S-1-5-32-544' | Out-Null",
    "  if ($LASTEXITCODE -ne 0) { throw ('icacls /setowner failed: ' + $LASTEXITCODE) }",
    "  & icacls.exe $dir /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-11:(OI)(CI)RX' | Out-Null",
    "  if ($LASTEXITCODE -ne 0) { throw ('icacls /grant failed: ' + $LASTEXITCODE) }",
    "  if (Test-Path -LiteralPath $result) { Remove-Item -LiteralPath $result -Force }",
    ...body.map((line) => `  ${line}`),
    "  Say 'ok'",
    "} catch {",
    "  Say ('error:' + $_.Exception.Message)",
    "  exit 1",
    "}",
  ].join("\r\n");
}

const keyPattern = /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)) ([A-Za-z0-9+/]+={0,2})(?: [^\r\n]*)?$/;

/**
 * A pasted public key as the one authorized_keys line it may become, or
 * undefined: a single line, a known type, no options prefix, and a body that
 * really is a key of that type. The comment is replaced, so only the type
 * name and base64 ever reach the script.
 */
export function authorizedKeyLine(text: string): string | undefined {
  const match = keyPattern.exec(text.trim());
  if (!match) return undefined;
  const parsed = ssh2.utils.parseKey(`${match[1]} ${match[2]}`);
  if (parsed instanceof Error || Array.isArray(parsed) || parsed.type !== match[1]) return undefined;
  return `${match[1]} ${match[2]} lepons`;
}

/** A key for the account this app runs as -- which the elevated run, maybe another administrator's, is not. */
export interface KeyFor {
  line: string;
  home: string;
  sid: string;
  admin: boolean;
}

/** This account's SID, and whether it is in Administrators (S-1-5-32-544), from `whoami /user /groups /fo csv /nh`. */
export function parseWhoami(output: string): { sid: string; admin: boolean } | undefined {
  const sid = /"(S-1-[\d-]+)"/.exec(output)?.[1];
  return sid === undefined ? undefined : { sid, admin: output.includes('"S-1-5-32-544"') };
}

/** Asked unelevated, so it is this account and not whoever accepts the UAC prompt. */
export const whoami = (): Promise<{ sid: string; admin: boolean } | undefined> =>
  new Promise((resolve) =>
    execFile("whoami.exe", ["/user", "/groups", "/fo", "csv", "/nh"], { windowsHide: true }, (error, stdout) =>
      resolve(error ? undefined : parseWhoami(String(stdout)))));

/**
 * The key into this account's authorized_keys, owned by the account, and --
 * for an administrator, in case Windows' admin-keys rule is back on -- into
 * administrators_authorized_keys with the ACL sshd demands (Administrators
 * and SYSTEM only). This runs elevated in a folder the user controls, so a
 * link planted there is refused rather than followed.
 */
function keyLines(key: KeyFor): string[] {
  return [
    `$key = ${psQuote(key.line)}`,
    `$body = ${psQuote(key.line.split(" ")[1]!)}`,
    `$sid = ${psQuote(key.sid)}`,
    "function Plain($path) {",
    "  if (Test-Path -LiteralPath $path) {",
    "    $item = Get-Item -LiteralPath $path -Force",
    "    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $item.LinkType) { throw ('not a plain file or folder: ' + $path) }",
    "  }",
    "}",
    "function AddKey($file) {",
    "  Plain $file",
    "  $text = ''",
    "  if (Test-Path -LiteralPath $file) { $text = [IO.File]::ReadAllText($file) }",
    "  if ($text.Contains($body)) { return }",
    "  if ($text -and -not $text.EndsWith(\"`n\")) { $text += \"`r`n\" }",
    "  [IO.File]::WriteAllText($file, $text + $key + \"`r`n\")",
    "}",
    // ponytail: checked, then written -- not atomic. Racing your own administrator's UAC run is out of scope.
    `$ssh = Join-Path ${psQuote(key.home)} '.ssh'`,
    "Plain $ssh",
    "if (-not (Test-Path -LiteralPath $ssh)) { New-Item -ItemType Directory -Path $ssh | Out-Null }",
    "$auth = Join-Path $ssh 'authorized_keys'",
    "AddKey $auth",
    "& icacls.exe $auth /setowner ('*' + $sid) | Out-Null",
    "if ($LASTEXITCODE -ne 0) { throw ('icacls /setowner authorized_keys failed: ' + $LASTEXITCODE) }",
    "& icacls.exe $auth /inheritance:r /grant:r ('*' + $sid + ':F') '*S-1-5-18:F' '*S-1-5-32-544:F' | Out-Null",
    "if ($LASTEXITCODE -ne 0) { throw ('icacls /grant authorized_keys failed: ' + $LASTEXITCODE) }",
    ...(key.admin
      ? [
          "$sshData = Join-Path $env:ProgramData 'ssh'",
          "if (-not (Test-Path -LiteralPath $sshData)) { New-Item -ItemType Directory -Path $sshData | Out-Null }",
          "$adminKeys = Join-Path $sshData 'administrators_authorized_keys'",
          "AddKey $adminKeys",
          "& icacls.exe $adminKeys /inheritance:r /grant:r '*S-1-5-32-544:F' '*S-1-5-18:F' | Out-Null",
          "if ($LASTEXITCODE -ne 0) { throw ('icacls administrators_authorized_keys failed: ' + $LASTEXITCODE) }",
        ]
      : []),
  ];
}

/** Put in front of each sshd_config line Lepons switches off; taking it away again is the whole undo. */
export const sshdConfigMarker = "#lepons# ";

/**
 * Windows' default sshd_config ends with `Match Group administrators` /
 * `AuthorizedKeysFile __PROGRAMDATA__/ssh/administrators_authorized_keys`,
 * so an administrator's own ~/.ssh/authorized_keys is never read. Writing
 * that ProgramData file needs an elevated token, and a password SSH login
 * gets a filtered one: the other PC's Lepons cannot install its key there.
 * So "allow" switches the block off -- the Match line and every line up to
 * the next Match -- with a marker, and "off" takes the marker away again.
 * The marker is the record: it also undoes a PC allowed before this change
 * once allowed again, whatever ssh-prev.json says. Text in, text out; line
 * endings (CRLF) are kept as they were.
 */
export const sshdConfigFunctions = [
  "function AdminKeysOff([string]$text) {",
  "  $in = $false",
  "  $out = foreach ($line in $text -split '(?<=\\n)') {",
  "    if ($line -match '^\\s*Match\\s') { $in = $line -match '^\\s*Match\\s+Group\\s+administrators\\s*$' }",
  `    if ($in -and $line) { ${psQuote(sshdConfigMarker)} + $line } else { $line }`,
  "  }",
  "  -join $out",
  "}",
  `function AdminKeysOn([string]$text) { -join ($text -split '(?<=\\n)' | ForEach-Object { if ($_.StartsWith(${psQuote(sshdConfigMarker)})) { $_.Substring(${sshdConfigMarker.length}) } else { $_ } }) }`,
];

/** Rewrites sshd_config with AdminKeysOff or AdminKeysOn and restarts a running sshd if that changed anything. */
const sshdConfigLines = (transform: "AdminKeysOff" | "AdminKeysOn") => [
  ...sshdConfigFunctions,
  "$conf = Join-Path $env:ProgramData 'ssh\\sshd_config'",
  "if (Test-Path -LiteralPath $conf) {",
  "  $text = [IO.File]::ReadAllText($conf)",
  `  $new = ${transform} $text`,
  "  if ($new -cne $text) {",
  // ponytail: written back as UTF-8 without a BOM; the shipped sshd_config is ASCII.
  "    [IO.File]::WriteAllText($conf, $new)",
  "    if ((Get-Service -Name sshd -ErrorAction SilentlyContinue).Status -eq 'Running') { Restart-Service -Name sshd -Force }",
  "  }",
  "}",
];

export function allowSshScript(id: string, bashCandidates: string[], installGit: boolean, key?: KeyFor): string {
  return elevatedScript(id, [
    // What was there before, kept once (a second "allow" must not record
    // Lepons' own settings as the original), so "off" can put it back.
    "$prev = Join-Path $dir 'ssh-prev.json'",
    "if (-not (Test-Path -LiteralPath $prev)) {",
    "  $svc = Get-Service -Name sshd -ErrorAction SilentlyContinue",
    `  $rule = Get-NetFirewallRule -Name ${psQuote(defaultFirewallRule)} -ErrorAction SilentlyContinue`,
    "  $shell = (Get-ItemProperty -Path 'HKLM:\\SOFTWARE\\OpenSSH' -Name DefaultShell -ErrorAction SilentlyContinue).DefaultShell",
    "  [pscustomobject]@{",
    "    sshd = [bool]$svc",
    "    running = [bool]($svc -and $svc.Status -eq 'Running')",
    "    startType = $(if ($svc) { [string]$svc.StartType } else { $null })",
    "    ruleEnabled = [bool]($rule -and [string]$rule.Enabled -eq 'True')",
    "    shell = $shell",
    "  } | ConvertTo-Json | Set-Content -LiteralPath $prev -Encoding UTF8",
    "}",
    // Recent Windows ships sshd already; older ones need the optional feature (Windows Update).
    "if (-not (Get-Service -Name sshd -ErrorAction SilentlyContinue)) {",
    "  $cap = Get-WindowsCapability -Online | Where-Object Name -like 'OpenSSH.Server*' | Select-Object -First 1",
    "  if (-not $cap) { throw 'OpenSSH Server is not offered on this Windows' }",
    "  try { $added = Add-WindowsCapability -Online -Name $cap.Name } catch { throw ('Add-WindowsCapability failed: ' + $_.Exception.Message) }",
    "  if ($added.RestartNeeded) { Say 'restart' }",
    "}",
    ...(installGit
      ? [
          "if (-not (Get-Command winget -ErrorAction SilentlyContinue)) { throw 'winget is missing: install Git for Windows from https://git-scm.com' }",
          "& winget install --id Git.Git -e --source winget --silent --scope machine --accept-package-agreements --accept-source-agreements | Out-Null",
          "if ($LASTEXITCODE -ne 0) { throw ('winget install Git.Git failed: ' + $LASTEXITCODE) }",
        ]
      : []),
    `$bash = @(${bashCandidates.map(psQuote).join(", ")}) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1`,
    "if (-not $bash) { throw 'Git Bash (bash.exe) was not found' }",
    "New-Item -Path 'HKLM:\\SOFTWARE\\OpenSSH' -Force | Out-Null",
    "New-ItemProperty -Path 'HKLM:\\SOFTWARE\\OpenSSH' -Name DefaultShell -Value $bash -PropertyType String -Force | Out-Null",
    "Set-Service -Name sshd -StartupType Automatic",
    "Start-Service -Name sshd",
    `Get-NetFirewallRule -Name ${psQuote(defaultFirewallRule)} -ErrorAction SilentlyContinue | Disable-NetFirewallRule`,
    `Remove-NetFirewallRule -Name ${psQuote(firewallRule)},${psQuote(oldFirewallRule)} -ErrorAction SilentlyContinue`,
    `New-NetFirewallRule -Name ${psQuote(firewallRule)} -DisplayName 'Lepons SSH (local network)' -Direction Inbound -Protocol TCP -LocalPort 22 ` +
      "-RemoteAddress LocalSubnet -Action Allow -Profile Any | Out-Null",
    // After Start-Service: a first start is what writes sshd_config.
    ...sshdConfigLines("AdminKeysOff"),
    ...(key ? keyLines(key) : []),
  ]);
}

/**
 * The undo. With a record from "allow": the default rule, DefaultShell and
 * sshd's start type go back to what they were, and an sshd that was already
 * running is left running. Without one: sshd stopped and left off. Either
 * way Lepons' rule goes and OpenSSH itself stays installed.
 */
export function disallowSshScript(id: string): string {
  return elevatedScript(id, [
    "$prev = Join-Path $dir 'ssh-prev.json'",
    "$before = $null",
    "if (Test-Path -LiteralPath $prev) { $before = Get-Content -LiteralPath $prev -Raw | ConvertFrom-Json }",
    `Remove-NetFirewallRule -Name ${psQuote(firewallRule)},${psQuote(oldFirewallRule)} -ErrorAction SilentlyContinue`,
    `if ($before -and $before.ruleEnabled) { Get-NetFirewallRule -Name ${psQuote(defaultFirewallRule)} -ErrorAction SilentlyContinue | Enable-NetFirewallRule }`,
    ...sshdConfigLines("AdminKeysOn"),
    "if ($before -and $before.sshd) {",
    "  if ($before.shell) { New-ItemProperty -Path 'HKLM:\\SOFTWARE\\OpenSSH' -Name DefaultShell -Value ([string]$before.shell) -PropertyType String -Force | Out-Null }",
    "  else { Remove-ItemProperty -Path 'HKLM:\\SOFTWARE\\OpenSSH' -Name DefaultShell -ErrorAction SilentlyContinue }",
    "  if ($before.startType -in 'Automatic', 'Manual', 'Disabled') { Set-Service -Name sshd -StartupType $before.startType }",
    "  if (-not $before.running) { Stop-Service -Name sshd -Force }",
    "} elseif (Get-Service -Name sshd -ErrorAction SilentlyContinue) {",
    "  Stop-Service -Name sshd -Force",
    "  Set-Service -Name sshd -StartupType Disabled",
    "}",
    "if ($before) { Remove-Item -LiteralPath $prev -Force }",
  ]);
}

/** The i18n key that says plainly what a known failure of the scripts above means, and what to do next. */
export function errorHint(detail: string): string | undefined {
  if (detail.includes("OpenSSH Server is not offered")) return "allow.err.noOpenSsh";
  if (detail.includes("winget is missing")) return "allow.err.noWinget";
  if (detail.includes("Add-WindowsCapability failed")) return "allow.err.capability";
  return undefined;
}

/** UTF-16LE base64, what -EncodedCommand takes. */
export const encodeCommand = (script: string) => Buffer.from(script, "utf16le").toString("base64");

/**
 * The unelevated PowerShell that raises the elevated one -- one UAC prompt
 * -- waits, and exits with its code. A declined prompt is ERROR_CANCELLED
 * (1223) inside Start-Process's exception; that, and only that, exits 1223.
 */
export function launcherArgs(script: string): string[] {
  const inner = `-NoProfile -NonInteractive -EncodedCommand ${encodeCommand(script)}`;
  return [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "try { $p = Start-Process -FilePath powershell.exe -Verb RunAs -Wait -PassThru -WindowStyle Hidden " +
      `-ArgumentList ${psQuote(inner)} } catch { $e = $_.Exception; ` +
      "while ($e) { if ($e -is [ComponentModel.Win32Exception] -and $e.NativeErrorCode -eq 1223) { exit 1223 }; $e = $e.InnerException }; " +
      "[Console]::Error.WriteLine($_.Exception.Message); exit 2 }; exit $p.ExitCode",
  ];
}

export type ElevatedOutcome =
  | { kind: "ok"; restart: boolean }
  | { kind: "cancelled" }
  | { kind: "failed"; reason: "error" | "unsafe" | "notRun"; detail: string };

/** What a run came to, from the launcher's exit code and stderr and this run's report lines. */
export function elevatedOutcome(code: number, stderr: string, report: string, id: string): ElevatedOutcome {
  const lines = report.replace(/^\uFEFF/, "").split(/\r?\n/)
    .filter((line) => line.startsWith(`${id} `))
    .map((line) => line.slice(id.length + 1));
  const error = lines.find((line) => line.startsWith("error:"));
  if (code === 1223) return { kind: "cancelled" };
  if (code === 0 && lines.includes("ok")) return { kind: "ok", restart: lines.includes("restart") };
  if (error !== undefined) return { kind: "failed", reason: "error", detail: error.slice("error:".length).trim() };
  if (code === unsafeFolderExit) return { kind: "failed", reason: "unsafe", detail: "" };
  return { kind: "failed", reason: "notRun", detail: [`exit ${code}`, stderr.trim()].filter(Boolean).join("\n") };
}

/** Runs one of the scripts above elevated and says how it went. */
export async function runElevated(
  make: (id: string) => string,
  programData: string = process.env.ProgramData ?? "C:\\ProgramData",
): Promise<ElevatedOutcome> {
  const id = randomUUID();
  const { code, stderr } = await new Promise<{ code: number; stderr: string }>((resolve) =>
    execFile("powershell.exe", launcherArgs(make(id)), { windowsHide: true }, (error, _stdout, stderr) =>
      resolve({ code: error ? (typeof error.code === "number" ? error.code : -1) : 0, stderr: String(stderr) || (error?.message ?? "") })));
  const report = await readFile(reportFile(programData), "utf8").catch(() => "");
  return elevatedOutcome(code, stderr, report, id);
}

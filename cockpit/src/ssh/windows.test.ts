import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { fromSftpPath, isWindowsUname } from "./windows.ts";
import { probeScript } from "./capabilities.ts";
import { authorizeKeyScript } from "./keys.ts";

test("a Windows PC is told apart by uname under Git Bash, MSYS2 and Cygwin", () => {
  for (const name of ["MINGW64_NT-10.0-26200", "MSYS_NT-10.0-19045", "CYGWIN_NT-10.0", "mingw32_nt\r\n"]) {
    assert.equal(isWindowsUname(name), true, name);
  }
  for (const name of ["Linux", "Darwin", "", "FreeBSD"]) assert.equal(isWindowsUname(name), false, name);
});

test("Windows SFTP paths read the way the operator knows them", () => {
  assert.equal(fromSftpPath("/C:/Users/me"), "C:/Users/me");
  assert.equal(fromSftpPath("/C:"), "C:/");
  assert.equal(fromSftpPath("/C:/"), "C:/");
  assert.equal(fromSftpPath("/home/me"), "/home/me");
  assert.equal(fromSftpPath("/Cx:/a"), "/Cx:/a");
});

// Run for real in this machine's bash: Git Bash on Windows, the usual one elsewhere.
test("the probe reports the home in this machine's own form and whether it is Windows", () => {
  const output = execFileSync("bash", ["-c", probeScript], { encoding: "utf8" });
  const home = /home:(.+)/.exec(output)?.[1]?.trim();
  assert.equal(home?.toLowerCase(), homedir().replaceAll("\\", "/").toLowerCase());
  assert.equal(isWindowsUname(/os:(.*)/.exec(output)?.[1] ?? ""), process.platform === "win32");
});

// Against a stand-in ProgramData -- `cygpath -F` (where the script finds it)
// is shadowed by an exported bash function -- so nothing outside the temp
// folder is touched: the user's file gets the key, and an administrator's
// administrators_authorized_keys is made with only Administrators and
// SYSTEM on it. Its contents are not read back: once the ACL is set, only an
// elevated token may read it. Where that write fails (here: no ssh folder),
// the install still succeeds.
test("on Windows an administrator's key also lands in administrators_authorized_keys", { skip: process.platform !== "win32" }, () => {
  const root = mkdtempSync(join(tmpdir(), "lepons-winkey-"));
  try {
    const home = join(root, "home");
    const programData = join(root, "ProgramData");
    mkdirSync(home);
    const line = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample lepons";
    const env = {
      ...process.env,
      HOME: home,
      LEPONS_TEST_PROGRAMDATA: programData,
      "BASH_FUNC_cygpath%%": '() { if [ "$1" = -F ]; then command cygpath -u "$LEPONS_TEST_PROGRAMDATA"; else command cygpath "$@"; fi; }',
    };
    const seen = execFileSync("bash", ["-c", 'cygpath -w "$(cygpath -F 35)"'], { env, encoding: "utf8" });
    assert.equal(seen.trim().toLowerCase(), programData.toLowerCase(), "refusing to run against the real ProgramData");
    const run = () => execFileSync("bash", ["-c", authorizeKeyScript(line)], { env });
    run();
    assert.equal(readFileSync(join(home, ".ssh", "authorized_keys"), "utf8"), line + "\n");
    const system32 = join(process.env.SystemRoot ?? "C:\\Windows", "System32");
    const admin = execFileSync(join(system32, "whoami.exe"), ["/groups"]).includes("S-1-5-32-544");
    const adminFile = join(programData, "ssh", "administrators_authorized_keys");
    assert.equal(existsSync(adminFile), false, "no ssh folder: the try failed, and quietly");
    mkdirSync(join(programData, "ssh"), { recursive: true });
    run();
    assert.equal(existsSync(adminFile), admin);
    if (admin) assert.doesNotMatch(execFileSync(join(system32, "icacls.exe"), [adminFile]).toString("latin1"), /\(I\)/);
  } finally {
    // That ACL locks this unelevated test out of its own file; as the
    // owner it may still hand the inherited one back, and then delete it.
    const adminFile = join(root, "ProgramData", "ssh", "administrators_authorized_keys");
    if (existsSync(adminFile)) execFileSync(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "icacls.exe"), [adminFile, "/reset"]);
    rmSync(root, { recursive: true, force: true });
  }
});

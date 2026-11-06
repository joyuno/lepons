import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import ssh2 from "ssh2";

import { agentAccounts, collectSetupInfo, ensureLeponsKey, remoteAgentAccounts } from "./setup-info.ts";
import { leponsIdentityName } from "../ssh/ssh-config.ts";

// Made without ssh-keygen, and a key that exists is never replaced: its
// nodes already trust it.
test("the Lepons key is made once, as an OpenSSH pair ssh2 can use", async () => {
  const home = mkdtempSync(join(tmpdir(), "lepons-key-"));
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    await ensureLeponsKey();
    const path = join(home, ".ssh", leponsIdentityName);
    const first = readFileSync(path, "utf8");
    assert.match(first, /^-----BEGIN OPENSSH PRIVATE KEY-----/);
    assert.match(readFileSync(`${path}.pub`, "utf8"), /^ssh-ed25519 \S+ lepons\n$/);
    const parsed = ssh2.utils.parseKey(first);
    assert.ok(!(parsed instanceof Error), String(parsed));

    await ensureLeponsKey();
    assert.equal(readFileSync(path, "utf8"), first);
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(home, { recursive: true, force: true });
  }
});

test("a remote PC's agents from its probe: absent is missing only when the shell answered", () => {
  const full = "home:/h\nos:Linux\ntmux:no\nclaude:2.1.0\ncodex:no\ngrok:no\nagy:no\nagent:no\n";
  const read = remoteAgentAccounts(full);
  assert.deepEqual(read.find((account) => account.kind === "claude"), { kind: "claude", version: "2.1.0" });
  assert.deepEqual(read.find((account) => account.kind === "codex"), { kind: "codex" });
  assert.deepEqual(remoteAgentAccounts("home:/h\nclaude:2.1.0\n").find((account) => account.kind === "codex"), { kind: "codex", unknown: true });
  assert.ok(remoteAgentAccounts(undefined).every((account) => account.unknown));
});

test("a remote PC's sign-in from its login lines: killed, absent or no status command is unknown", () => {
  const probe = "home:/h\nos:Linux\ntmux:no\nclaude:2.1.0\ncodex:0.5\ngrok:1.0\nagy:no\nagent:2.0\n";
  const read = remoteAgentAccounts(probe + "claude-login:{ \"loggedIn\": true } rc:0\ncodex-login:Not logged in rc:1\nagent-login: rc:143\ngrok-login:x rc:0\n");
  assert.deepEqual(read.find((account) => account.kind === "claude"), { kind: "claude", version: "2.1.0", signedIn: true });
  assert.deepEqual(read.find((account) => account.kind === "codex"), { kind: "codex", version: "0.5", signedIn: false });
  assert.deepEqual(read.find((account) => account.kind === "agent"), { kind: "agent", version: "2.0" });
  assert.deepEqual(read.find((account) => account.kind === "grok"), { kind: "grok", version: "1.0" });
  assert.deepEqual(remoteAgentAccounts(probe).find((account) => account.kind === "claude"), { kind: "claude", version: "2.1.0" });
  assert.deepEqual(remoteAgentAccounts(probe + "claude-login:\"loggedIn\": false rc:0\n").find((account) => account.kind === "claude")?.signedIn, false);
});

// An app opened from Finder or the Dock has launchd's bare PATH, while a
// terminal -- and a session here -- finds its agents through the account's
// shell. A fake shell that alone knows where claude is stands in for that.
test("this PC's agents are found the way its shell finds them, not on the app's own PATH", { skip: process.platform === "win32" }, async () => {
  const base = mkdtempSync(join(tmpdir(), "lepons-shell-"));
  const saved = { SHELL: process.env["SHELL"], PATH: process.env["PATH"], HOME: process.env["HOME"] };
  try {
    const bin = join(base, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "claude"), '#!/bin/sh\ncase "$1" in --version) echo "9.9.9 (Claude Code)";; auth) echo "Logged in";; esac\n');
    // A sign-in check that hangs and shrugs off TERM, as npm's codex.js does: cut off, it is unknown, not signed in.
    writeFileSync(join(bin, "codex"), '#!/bin/sh\ncase "$1" in --version) echo "codex-cli 9.9.9";; login) trap "" TERM; sleep 8; exit 0;; esac\n');
    chmodSync(join(bin, "codex"), 0o755);
    // zsh where there is one: the Mac's own shell, which once dropped the sign-in check whole.
    const shell = existsSync("/bin/zsh") ? "/bin/zsh" : "/bin/sh";
    writeFileSync(join(base, "shell"), `#!/bin/sh\nPATH="${bin}:/usr/bin:/bin"; export PATH; exec ${shell} -c "$2"\n`);
    chmodSync(join(bin, "claude"), 0o755);
    chmodSync(join(base, "shell"), 0o755);
    Object.assign(process.env, { SHELL: join(base, "shell"), PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: base });

    const accounts = await agentAccounts();
    assert.deepEqual(accounts.find((account) => account.kind === "claude"), { kind: "claude", version: "9.9.9 (Claude Code)", signedIn: true });
    assert.deepEqual(accounts.find((account) => account.kind === "codex"), { kind: "codex", version: "codex-cli 9.9.9" });
    assert.deepEqual(accounts.find((account) => account.kind === "grok"), { kind: "grok" });
    assert.equal((await collectSetupInfo()).agentVersions.claude, "9.9.9 (Claude Code)");
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(base, { recursive: true, force: true });
  }
});

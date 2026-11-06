import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import ssh2 from "ssh2";

import { ensureLeponsKey, remoteAgentAccounts } from "./setup-info.ts";
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

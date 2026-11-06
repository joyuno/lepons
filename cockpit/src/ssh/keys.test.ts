import { test } from "node:test";
import assert from "node:assert/strict";
import ssh2 from "ssh2";

import { authorizeKeyScript, generateKeyPair, inspectKey, PassphraseCache, publicKeyLine } from "./keys.ts";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "./connect.ts";
import { MemoryKnownHosts } from "./known-hosts.ts";

const { utils } = ssh2;

// Generated per run rather than committed: a private key in the repository is
// a bad habit even when it is only a test key.
const locked = Buffer.from(
  String(
    generateKeyPair({
      passphrase: "correct horse",
      cipher: "aes256-cbc",
      rounds: 16,
    }).private,
  ),
);
const open = Buffer.from(String(generateKeyPair().private));

test("an unencrypted key is usable as it is", () => {
  assert.deepEqual(inspectKey(open), { kind: "usable" });
});

test("an encrypted key asks for a passphrase", () => {
  assert.deepEqual(inspectKey(locked), { kind: "needs_passphrase" });
});

// A mistyped passphrase and a corrupt file need different answers: one is a
// question to re-ask, the other is a file to fix.
test("a wrong passphrase is distinguished from an unusable file", () => {
  assert.deepEqual(inspectKey(locked, "wrong"), { kind: "wrong_passphrase" });

  const notAKey = inspectKey(Buffer.from("this is not a key\n"));
  assert.equal(notAKey.kind, "invalid");
});

test("the right passphrase unlocks the key", () => {
  assert.deepEqual(inspectKey(locked, "correct horse"), { kind: "usable" });
});

test("a passphrase on an unencrypted key is harmless", () => {
  assert.deepEqual(inspectKey(open, "irrelevant"), { kind: "usable" });
});

test("the cache answers per key path and can be cleared", () => {
  const cache = new PassphraseCache();
  assert.equal(cache.get("/home/me/.ssh/id_ed25519"), undefined);

  cache.remember("/home/me/.ssh/id_ed25519", "secret");
  assert.equal(cache.get("/home/me/.ssh/id_ed25519"), "secret");
  assert.equal(cache.get("/home/me/.ssh/other"), undefined);

  cache.forget("/home/me/.ssh/id_ed25519");
  assert.equal(cache.get("/home/me/.ssh/id_ed25519"), undefined);
});

// The passphrase exists so that holding the key file is not enough. A cache
// that could be written out would give that back.
// ssh2 throws synchronously when it cannot parse the key, which for a locked
// key with no passphrase is the ordinary case. Every other failure in connect
// is reported, so this one must be too rather than escaping as a crash. No
// network is involved: the throw happens before any socket is opened.
test("connecting with a locked key fails closed instead of throwing", async () => {
  const result = await connect({
    host: "203.0.113.1",
    port: 22,
    username: "nobody",
    auth: { kind: "privateKey", privateKey: locked },
    knownHosts: new MemoryKnownHosts(),
    readyTimeoutMs: 500,
  });

  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, "auth_failed");
});

test("the cache exposes no way to persist itself", () => {
  const cache = new PassphraseCache();
  cache.remember("/k", "secret");

  assert.doesNotMatch(JSON.stringify(cache), /secret/);
  assert.deepEqual(Object.keys(cache), []);
});

// ssh2 drops a leading zero byte from about one ed25519 key in 256 and then
// cannot read the key it wrote; a key nobody can parse locks the operator out.
test("a generated key is always one ssh2 can read back", () => {
  for (let i = 0; i < 1500; i++) {
    assert.ok(!(utils.parseKey(Buffer.from(String(generateKeyPair().private))) instanceof Error));
  }
});

// The line has to be the one ssh2 itself would offer, or the node would hold
// a key nobody connects with.
test("the public line comes from the private key, locked or not", () => {
  const pair = generateKeyPair();
  const line = publicKeyLine(Buffer.from(String(pair.private)));
  assert.equal(line?.split(" ").slice(0, 2).join(" "), String(pair.public).trim().split(" ").slice(0, 2).join(" "));
  assert.match(publicKeyLine(locked, "correct horse") ?? "", /^ssh-ed25519 \S+ lepons$/);
  assert.equal(publicKeyLine(locked), undefined);
});

// A password SSH login on Windows gets a filtered token and an empty
// $PROGRAMDATA: the ProgramData copy is a try, never what fails the install.
test("an administrator's ProgramData key file is best-effort, found without $PROGRAMDATA", () => {
  const script = authorizeKeyScript("ssh-ed25519 AAAA lepons");
  assert.doesNotMatch(script, /\$PROGRAMDATA/);
  assert.ok(script.includes('d="$(cygpath -F 35 2>/dev/null)"; f="${d:-/c/ProgramData}/ssh/administrators_authorized_keys"'));
  assert.match(script, /\{ \{ grep -qsF 'AAAA' "\$f" .*icacls .* >\/dev\/null; \} 2>\/dev\/null \|\| true; fi;; esac$/);
  // The user's own file is still written, and still fails out loud.
  assert.ok(script.indexOf("~/.ssh/authorized_keys") < script.indexOf("administrators_authorized_keys"));
});

// Run for real in a POSIX shell where there is one: adds the key once however
// many times it runs, keeps lines already there, and leaves sshd's permissions.
test("authorizing a key adds it once and keeps what was there", { skip: process.platform === "win32" }, () => {
  const home = mkdtempSync(join(tmpdir(), "lepons-auth-"));
  try {
    const line = publicKeyLine(open)!;
    const run = () => execFileSync("sh", ["-c", authorizeKeyScript(line)], { env: { ...process.env, HOME: home } });
    execFileSync("sh", ["-c", "mkdir -p ~/.ssh && echo 'ssh-rsa AAAAold me@laptop' > ~/.ssh/authorized_keys"], { env: { ...process.env, HOME: home } });
    run();
    run();
    const lines = readFileSync(join(home, ".ssh", "authorized_keys"), "utf8").trim().split(String.fromCharCode(10));
    assert.deepEqual(lines, ["ssh-rsa AAAAold me@laptop", line]);
    assert.equal(statSync(join(home, ".ssh", "authorized_keys")).mode & 0o777, 0o600);
    assert.equal(statSync(join(home, ".ssh")).mode & 0o777, 0o700);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

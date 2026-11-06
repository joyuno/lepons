import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";

import { MemoryKnownHosts, fingerprintOf, verifyHostKey } from "./known-hosts.ts";

const keyA = randomBytes(64);
const keyB = randomBytes(64);

test("fingerprint matches the OpenSSH SHA256 form so an operator can compare it", () => {
  const expected =
    "SHA256:" + createHash("sha256").update(keyA).digest("base64").replace(/=+$/, "");

  assert.equal(fingerprintOf(keyA), expected);
  assert.match(fingerprintOf(keyA), /^SHA256:[A-Za-z0-9+/]+$/);
});

test("a host we have never seen is unknown, never trusted", () => {
  const store = new MemoryKnownHosts();

  const verdict = verifyHostKey(store, "node-c:22", keyA);

  assert.equal(verdict.kind, "unknown");
  assert.equal(verdict.fingerprint, fingerprintOf(keyA));
});

test("a host presenting the remembered key is trusted", () => {
  const store = new MemoryKnownHosts();
  store.remember("node-c:22", fingerprintOf(keyA));

  assert.equal(verifyHostKey(store, "node-c:22", keyA).kind, "trusted");
});

// A changed host key is the signature of an interception. It must never
// resolve to trusted, and the verdict has to carry both fingerprints so the
// operator can see what changed rather than being asked a yes/no question.
test("a host presenting a different key is changed, not unknown and not trusted", () => {
  const store = new MemoryKnownHosts();
  store.remember("node-c:22", fingerprintOf(keyA));

  const verdict = verifyHostKey(store, "node-c:22", keyB);

  assert.equal(verdict.kind, "changed");
  assert.equal(verdict.fingerprint, fingerprintOf(keyB));
  assert.equal(verdict.knownFingerprint, fingerprintOf(keyA));
});

test("host identity is scoped per host and port", () => {
  const store = new MemoryKnownHosts();
  store.remember("node-c:22", fingerprintOf(keyA));

  assert.equal(verifyHostKey(store, "node-c:2222", keyA).kind, "unknown");
  assert.equal(verifyHostKey(store, "node-b:22", keyA).kind, "unknown");
});

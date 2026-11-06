import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { scratchDir } from "../scratch-dir.ts";

import { GrantStore, IdSetStore, SaltStore, TokenStore, openSecret, preferredSharePort, sealSecret, type SecretBox } from "./stores.ts";

const scratch = () => join(scratchDir("lepons-store-"), "store.json");

// The line an operator pastes on a node names this port. If it moved between
// launches, that configuration would go quietly stale.
test("a node's share port is stable and in the ephemeral range", () => {
  const id = "192.0.2.10:22:dev";
  const port = preferredSharePort(id);

  assert.equal(port, preferredSharePort(id));
  assert.ok(port >= 40000 && port < 60000, `out of range: ${port}`);
  assert.notEqual(port, preferredSharePort("198.51.100.10:22:admin"));
});

// Same reason: a token that changed every launch would break the node's
// configuration without saying so.
test("a node's token survives a restart", () => {
  const path = scratch();
  const first = new TokenStore(path).for("node-c");
  const afterRestart = new TokenStore(path).for("node-c");

  assert.equal(afterRestart, first);
  assert.ok(first.length >= 40);
});

test("each node gets its own token", () => {
  const store = new TokenStore(scratch());
  assert.notEqual(store.for("node-b"), store.for("node-c"));
});

test("revoking a token issues a new one next time", () => {
  const store = new TokenStore(scratch());
  const before = store.for("node-c");
  store.revoke("node-c");

  assert.notEqual(store.for("node-c"), before);
});

// A moved salt would report every masked value as changed, which is the same
// as reporting nothing.
test("a repository's masking salt survives a restart and is unique", () => {
  const path = scratch();
  const first = new SaltStore(path).for("node-c /srv/api");
  const afterRestart = new SaltStore(path).for("node-c /srv/api");

  assert.equal(afterRestart, first);
  assert.notEqual(new SaltStore(path).for("node-c /srv/other"), first);
  assert.ok(first.length >= 40);
});

test("a remembered id survives a restart and is forgotten when cleared", () => {
  const path = scratch();
  new IdSetStore(path).set("pc-b", true);
  const reread = new IdSetStore(path);
  assert.equal(reread.has("pc-b"), true);
  reread.set("pc-b", false);
  assert.equal(new IdSetStore(path).has("pc-b"), false);
});

test("ids can be dropped by what they start with", () => {
  const path = scratch();
  const store = new IdSetStore(path);
  store.set("pc-a SHA256:x", true);
  store.set("pc-a SHA256:y", true);
  store.set("pc-b SHA256:x", true);
  store.dropPrefix("pc-a ");
  const reread = new IdSetStore(path);
  assert.equal(reread.has("pc-a SHA256:x"), false);
  assert.equal(reread.has("pc-a SHA256:y"), false);
  assert.equal(reread.has("pc-b SHA256:x"), true);
});

test("grants to a PC that is gone, or of something no longer offered, are dropped", () => {
  const path = scratch();
  const store = new GrantStore(path);
  store.set("pc-a", "r-folder", true);
  store.set("pc-a", "r-gone-data", true);
  store.set("pc-gone", "r-folder", true);
  store.prune(new Set(["pc-a", "pc-b"]), new Set(["r-folder"]));
  const reread = new GrantStore(path);
  assert.deepEqual([...reread.for("pc-a")], ["r-folder"]);
  assert.equal(reread.for("pc-gone").size, 0);
});

test("a relay key is sealed by the OS where it can be, and opens only there", () => {
  const raw = Buffer.alloc(32, 7);
  const box = (available: boolean, mask = 0x5a): SecretBox => ({
    isEncryptionAvailable: () => available,
    encryptString: (text) => Buffer.from(Buffer.from(text).map((byte) => byte ^ mask)),
    decryptString: (data) => {
      const text = Buffer.from(data.map((byte) => byte ^ mask)).toString();
      if (!/^[A-Za-z0-9+/=]+$/.test(text)) throw new Error("not ours");
      return text;
    },
  });
  const sealed = sealSecret(raw, box(true));
  assert.match(sealed, /^safe:/);
  assert.ok(!sealed.includes(raw.toString("base64")));
  assert.deepEqual(openSecret(sealed, box(true)), raw);
  assert.equal(openSecret(sealed, box(true, 0x33)), undefined);
  const plain = sealSecret(raw, box(false));
  assert.equal(plain, `plain:${raw.toString("base64")}`);
  assert.deepEqual(openSecret(plain, box(false)), raw);
  assert.equal(openSecret("other", box(true)), undefined);
});

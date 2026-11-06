import { test, before, after } from "node:test";
import assert from "node:assert/strict";

import { MemoryKnownHosts, hostId } from "./known-hosts.ts";
import { generateHostKey, startFakeNode, fakeHome, type FakeNode } from "./fake-node.ts";
import { listDirectory } from "./browse.ts";
import type { ConnectOptions } from "./connect.ts";

const hostKey = generateHostKey();
let node: FakeNode;
let trusted: MemoryKnownHosts;

before(async () => {
  node = await startFakeNode(hostKey);
  trusted = new MemoryKnownHosts();
  // Learn the fingerprint once, the same way the cockpit does on first approval.
  await listDirectory({ ...options(trusted), trustNewHost: async () => true }, fakeHome);
});

after(async () => {
  await node.close();
});

function options(store: MemoryKnownHosts): ConnectOptions {
  return {
    host: "127.0.0.1",
    port: node.port,
    username: "operator",
    auth: { kind: "password", password: "unused-by-fake-node" },
    knownHosts: store,
    readyTimeoutMs: 4000,
  };
}

test("lists a directory with directories first", async () => {
  const result = await listDirectory(options(trusted), fakeHome);

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.path, fakeHome);
  assert.deepEqual(
    result.entries.map((entry) => entry.name),
    [".config", "projects", "zeta-notes.txt"],
  );
  assert.deepEqual(
    result.entries.map((entry) => entry.isDirectory),
    [true, true, false],
  );
});

test("descends into a subdirectory", async () => {
  const result = await listDirectory(options(trusted), `${fakeHome}/projects`);

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(
    result.entries.map((entry) => entry.name),
    ["api", "README.md"],
  );
});

// An empty path must land in the account's home rather than guessing at "/",
// so the operator starts inside the tree they actually own.
test("an empty path resolves to the account home", async () => {
  const result = await listDirectory(options(trusted), "");

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.path, fakeHome);
});

test("a directory that does not exist fails without pretending it is empty", async () => {
  const result = await listDirectory(options(trusted), `${fakeHome}/absent`);

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "listing_failed");
});

// Browsing is a connection like any other: it must refuse an unverified host
// before it reaches the filesystem.
test("browsing an unknown host is refused", async () => {
  const result = await listDirectory(options(new MemoryKnownHosts()), fakeHome);

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "host_key_unknown");
});

test("browsing a host whose key changed is refused", async () => {
  const store = new MemoryKnownHosts();
  store.remember(hostId("127.0.0.1", node.port), "SHA256:AAAAdefinitelynotthiskey");

  const result = await listDirectory(
    { ...options(store), trustNewHost: async () => true },
    fakeHome,
  );

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "host_key_changed");
});

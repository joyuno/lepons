import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";

import { connect } from "./connect.ts";
import { MemoryKnownHosts } from "./known-hosts.ts";
import { generateHostKey, startFakeNode } from "./fake-node.ts";

const base = {
  username: "nobody",
  auth: { kind: "password", password: "unused" } as const,
  knownHosts: new MemoryKnownHosts(),
  readyTimeoutMs: 1500,
};

// The operator's next move differs per cause, so these must not collapse
// into one another: a closed port means start sshd, a silent drop means
// open the firewall, an unresolvable name means fix the address.
test("a port with nothing behind it is refused, not merely unreachable", async () => {
  // Port 1 on loopback: bound by nothing, and the kernel answers at once.
  const result = await connect({ ...base, host: "127.0.0.1", port: 1 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "refused");
  assert.match(result.detail, /ECONNREFUSED/, "the errno survives for the operator to search");
});

test("a name that does not resolve is named as such", async () => {
  const result = await connect({
    ...base,
    // Not the shared 1500ms: that raced the resolver against the handshake
    // timer and the timer kept winning, so this reported connect_timeout and
    // the suite failed at whatever rate the machine's negative DNS cache
    // happened to be cold -- measured at ~9.5s for getaddrinfo to answer
    // ENOTFOUND here, against 1.5s of patience. A timeout shorter than the
    // lookup does not test how a failed lookup is reported, it tests the
    // timeout. The other two cases keep the short value: they want it.
    readyTimeoutMs: 30_000,
    host: "no-such-host.invalid",
    port: 22,
  });
  assert.equal(result.ok, false);
  assert.ok(
    result.reason === "dns_failed" || result.reason === "no_route",
    `expected a lookup failure, got ${result.reason}`,
  );
});

test("a port that accepts and then says nothing times out", async () => {
  // A firewall that drops looks like this from here: the handshake never
  // arrives, and only the timeout ends it.
  const silent = createServer(() => {});
  await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
  const { port } = silent.address() as { port: number };

  const result = await connect({ ...base, host: "127.0.0.1", port });
  silent.close();

  assert.equal(result.ok, false);
  assert.equal(result.reason, "connect_timeout");
});

// Stock Linux sshd asks for a password by keyboard-interactive, not by the
// "password" method; a first sign-in that only tried the latter was refused.
test("a password signs in where the server asks by keyboard-interactive", async () => {
  const node = await startFakeNode(generateHostKey());
  node.faults.keyboardPassword = "s3cret";
  try {
    const wrong = await connect({ ...node.options, auth: { kind: "password", password: "nope" } });
    assert.equal(wrong.ok, false);
    const right = await connect({ ...node.options, auth: { kind: "password", password: "s3cret" } });
    assert.equal(right.ok, true);
    if (right.ok) right.connection.client.end();
    assert.ok(node.authAttempts.includes("keyboard-interactive"));
  } finally {
    await node.close();
  }
});

// The handshake timeout once kept running under the trust prompt, so an
// operator who took longer than it to read the fingerprint got "firewall".
test("time spent on the trust prompt does not count against the handshake", async () => {
  const node = await startFakeNode(generateHostKey());
  try {
    const result = await connect({
      ...node.options,
      readyTimeoutMs: 300,
      trustNewHost: () => new Promise((resolve) => setTimeout(() => resolve(true), 900)),
    });
    assert.equal(result.ok, true, result.ok ? "" : result.reason);
    if (result.ok) result.connection.client.end();
  } finally {
    await node.close();
  }
});

// A changed key is refused unless the operator says the PC was reinstalled;
// then the new key is saved and this same connection goes through.
test("a changed host key connects only when the operator trusts the new one", async () => {
  const node = await startFakeNode(generateHostKey());
  try {
    const knownHosts = new MemoryKnownHosts();
    const id = `${node.options.host}:${node.options.port}`;
    knownHosts.remember(id, "SHA256:old");
    const asked: string[] = [];

    const refused = await connect({ ...node.options, knownHosts, trustChangedHost: async (known) => (asked.push(known), false) });
    assert.equal(refused.ok ? "" : refused.reason, "host_key_changed");
    assert.equal(knownHosts.lookup(id), "SHA256:old");

    const trusted = await connect({ ...node.options, knownHosts, trustChangedHost: async () => true });
    assert.equal(trusted.ok, true, trusted.ok ? "" : trusted.reason);
    if (trusted.ok) trusted.connection.client.end();
    assert.notEqual(knownHosts.lookup(id), "SHA256:old");
    assert.deepEqual(asked, ["SHA256:old"]);
  } finally {
    await node.close();
  }
});

/** Connects once with a yes to the key, to learn the fingerprint the node shows. */
async function keyOf(node: Awaited<ReturnType<typeof startFakeNode>>): Promise<string> {
  const seen = new MemoryKnownHosts();
  const result = await connect({ ...node.options, knownHosts: seen, trustNewHost: async () => true });
  if (result.ok) result.connection.client.end();
  return seen.lookup(`${node.options.host}:${node.options.port}`)!;
}

// One PC, a home address and an outside one: the next is tried when the first
// does not answer, and any address that answers with another machine's key
// (a home LAN address seen from the office) is passed over without asking.
test("a PC's next address is tried when one does not answer or is another machine", async () => {
  const pc = await startFakeNode(generateHostKey());
  const stranger = await startFakeNode(generateHostKey());
  try {
    const key = await keyOf(pc);
    const knownHosts = new MemoryKnownHosts();
    const strangerId = `${stranger.options.host}:${stranger.options.port}`;
    // Both were this PC's addresses before: the stranger now sits at one of them.
    knownHosts.remember("127.0.0.1:1", key);
    knownHosts.remember(strangerId, key);
    const asked: string[] = [];
    const ask = async (fingerprint: string) => (asked.push(fingerprint), true);
    const at = (node: typeof pc) => ({ host: node.options.host, port: node.options.port, username: node.options.username, auth: node.options.auth });

    const dead = await connect({ ...pc.options, knownHosts, host: "127.0.0.1", port: 1, alternates: [at(pc)], trustNewHost: ask, trustChangedHost: ask });
    assert.equal(dead.ok, true, dead.ok ? "" : dead.reason);
    if (dead.ok) dead.connection.client.end();
    assert.equal(knownHosts.lookup(`${pc.options.host}:${pc.options.port}`), key, "the new address is remembered as this PC's");

    const other = await connect({ ...stranger.options, knownHosts, alternates: [at(pc)], trustNewHost: ask, trustChangedHost: ask });
    assert.equal(other.ok, true, other.ok ? "" : other.reason);
    if (other.ok) other.connection.client.end();
    assert.equal(knownHosts.lookup(strangerId), key, "the stranger's key was not taken for this PC");

    const none = await connect({ ...stranger.options, knownHosts, alternates: [{ ...at(pc), port: 1 }], trustNewHost: ask, trustChangedHost: ask });
    assert.equal(none.ok ? "" : none.reason, "other_pc");
    assert.deepEqual(asked, [], "nothing was asked: another machine is never trusted for this one");
  } finally {
    await pc.close();
    await stranger.close();
  }
});

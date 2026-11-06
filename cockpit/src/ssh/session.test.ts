import { test, before, after } from "node:test";
import assert from "node:assert/strict";

import { MemoryKnownHosts, hostId } from "./known-hosts.ts";
import { generateHostKey, startFakeNode, type FakeNode } from "./fake-node.ts";
import { NodeSession, type SessionState } from "./session.ts";

const hostKey = generateHostKey();
let node: FakeNode;

before(async () => {
  node = await startFakeNode(hostKey);
});

after(async () => {
  await node.close();
});

function sessionTo(
  overrides: Partial<ConstructorParameters<typeof NodeSession>[0]> = {},
  port = node.port,
) {
  return new NodeSession({
    host: "127.0.0.1",
    port,
    username: "operator",
    auth: { kind: "password", password: "unused-by-fake-node" },
    knownHosts: new MemoryKnownHosts(),
    term: { name: "xterm-256color", cols: 100, rows: 30 },
    readyTimeoutMs: 4000,
    ...overrides,
  });
}

/** A store that already trusts whatever key this node presents. */
async function trustingStore(port = node.port): Promise<MemoryKnownHosts> {
  const store = new MemoryKnownHosts();
  const session = sessionTo({ knownHosts: store, trustNewHost: async () => true }, port);
  await session.open();
  session.close();
  return store;
}

test("opens a PTY shell on a trusted host and streams node output", async () => {
  const session = sessionTo({ knownHosts: await trustingStore() });
  const chunks: string[] = [];
  session.on("data", (chunk: Buffer) => chunks.push(chunk.toString("utf8")));

  const state = await session.open();
  node.send("node says hello\n");
  await waitFor(() => chunks.join("").includes("node says hello"));
  session.close();

  assert.equal(state.kind, "ready");
});

test("requests the terminal size the cockpit asked for", async () => {
  const session = sessionTo({
    knownHosts: await trustingStore(),
    term: { name: "xterm-256color", cols: 123, rows: 45 },
  });

  await session.open();
  session.close();

  const request = node.ptyRequests.at(-1);
  assert.equal(request?.term, "xterm-256color");
  assert.equal(request?.cols, 123);
  assert.equal(request?.rows, 45);
});

test("keystrokes reach the node and resize sends a window change", async () => {
  const session = sessionTo({ knownHosts: await trustingStore() });

  await session.open();
  session.write("claude\r");
  session.resize(200, 60);
  await waitFor(() => node.received().includes("claude\r"));
  await waitFor(() => node.windowChanges.some((c) => c.cols === 200 && c.rows === 60));
  session.close();
});

// Fail closed: without an explicit approval hook an unfamiliar host is refused,
// and the refusal happens during the handshake so no credential is ever offered.
test("an unknown host is refused and no credential is sent", async () => {
  const before = node.authAttempts.length;
  const session = sessionTo();

  const state = await session.open();

  assert.equal(state.kind, "closed");
  assert.equal(state.kind === "closed" && state.reason, "host_key_unknown");
  assert.equal(node.authAttempts.length, before, "credential offered to an unverified host");
});

test("approving an unknown host remembers its fingerprint", async () => {
  const store = new MemoryKnownHosts();
  const seen: string[] = [];
  const session = sessionTo({
    knownHosts: store,
    trustNewHost: async (fingerprint: string) => {
      seen.push(fingerprint);
      return true;
    },
  });

  const state = await session.open();
  session.close();

  assert.equal(state.kind, "ready");
  assert.equal(seen.length, 1);
  assert.match(seen[0] ?? "", /^SHA256:/);
  assert.equal(store.lookup(hostId("127.0.0.1", node.port)), seen[0]);
});

test("declining an unknown host refuses the connection", async () => {
  const session = sessionTo({ trustNewHost: async () => false });

  const state = await session.open();

  assert.equal(state.kind === "closed" && state.reason, "host_key_unknown");
});

// A changed key is never a prompt. It is a refusal.
test("a changed host key is refused even when an approval hook exists", async () => {
  const store = new MemoryKnownHosts();
  store.remember(hostId("127.0.0.1", node.port), "SHA256:AAAAdefinitelynotthiskey");
  let asked = false;
  const session = sessionTo({
    knownHosts: store,
    trustNewHost: async () => {
      asked = true;
      return true;
    },
  });

  const state = await session.open();

  assert.equal(state.kind === "closed" && state.reason, "host_key_changed");
  assert.equal(asked, false, "a changed key must not be offered as a trust prompt");
});

test("the node ending the stream closes the session with a stated reason", async () => {
  const session = sessionTo({ knownHosts: await trustingStore() });
  const states: SessionState[] = [];
  session.on("state", (state: SessionState) => states.push(state));

  await session.open();
  node.endStream();
  await waitFor(() => session.state.kind === "closed");

  assert.equal(session.state.kind === "closed" && session.state.reason, "node_ended");
  assert.ok(
    states.some((s) => s.kind === "closed"),
    "a closing session must announce itself rather than going quiet",
  );
});

test("an unreachable node closes quickly instead of hanging", async () => {
  const unusedPort = 1;
  const session = sessionTo({ readyTimeoutMs: 2000 }, unusedPort);

  const started = Date.now();
  const state = await session.open();
  const elapsed = Date.now() - started;

  assert.equal(state.kind, "closed");
  assert.ok(
    state.kind === "closed" &&
      // "refused" is the honest answer for a port nothing listens on; the
      // others stay accepted because a sandbox may drop instead of refuse.
      ["refused", "unreachable", "connect_timeout", "no_route"].includes(state.reason),
    `unexpected reason: ${JSON.stringify(state)}`,
  );
  assert.ok(elapsed < 10_000, `took ${elapsed}ms to report an unreachable node`);
});

async function waitFor(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition not met within " + timeoutMs + "ms");
}

import { test } from "node:test";
import assert from "node:assert/strict";

import { generateHostKey, startFakeNode } from "./fake-node.ts";
import { ProbePool } from "./pool.ts";

/**
 * A transport close reaches the server after the client's `end()` returns,
 * so a leak assertion has to wait for it rather than read it at once. Ten
 * milliseconds at a time, up to two seconds: fast when the close arrives,
 * and still a failure -- not a hang -- when it never does.
 */
async function eventually(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(check(), what);
}

test("two probes on one node share one connection", async () => {
  const node = await startFakeNode(generateHostKey());
  const pool = new ProbePool();
  pool.start();
  try {
    await pool.run("n1", node.options, "echo one");
    await pool.run("n1", node.options, "echo two");

    assert.equal(node.execCommands.length, 2, "both commands ran");
    assert.equal(node.connectionCount, 1, "on a single connection");
  } finally {
    pool.stop();
    await node.close();
  }
});

test("stop closes the connection, and a later run opens a new one", async () => {
  const node = await startFakeNode(generateHostKey());
  const pool = new ProbePool();
  pool.start();
  try {
    await pool.run("n1", node.options, "echo one");
    pool.stop();
    // Without this the test passes while leaking: clearing the map alone
    // leaves connectionCount just as it would be after a real close.
    await eventually(() => node.disconnectCount === 1, "stop ended the transport rather than forgetting it");

    pool.start();
    await pool.run("n1", node.options, "echo two");
    assert.equal(node.connectionCount, 2);
  } finally {
    pool.stop();
    await node.close();
  }
});

test("stop mid-handshake ends the late connection instead of caching it", async () => {
  const node = await startFakeNode(generateHostKey());
  const pool = new ProbePool();
  pool.start();
  try {
    const first = pool.run("n1", node.options, "echo one");
    pool.stop(); // fires while the first connect() is still in flight
    const firstResult = await first;
    assert.equal(firstResult, undefined, "the abandoned connection never execs");
    await eventually(() => node.disconnectCount === 1, "the abandoned handshake was ended, not left open");

    pool.start();
    const secondResult = await pool.run("n1", node.options, "echo two");
    assert.equal(secondResult, "");
    assert.deepEqual(node.execCommands, ["echo two"], "only the fresh connection ran a command");
    assert.equal(node.connectionCount, 2, "the abandoned handshake and the fresh run are separate connections");
  } finally {
    pool.stop();
    await node.close();
  }
});

test("a run after stop opens nothing at all", async () => {
  const node = await startFakeNode(generateHostKey());
  const pool = new ProbePool();
  pool.start();
  try {
    await pool.run("n1", node.options, "echo one");
    pool.stop();
    await eventually(() => node.disconnectCount === 1, "the held connection was closed");

    // The map is empty now, so nothing stops clientFor from dialling except
    // knowing that nobody holds the pool. A connection opened here would
    // have no owner and no closer -- this is the delegation-check leak.
    const late = await pool.run("n1", node.options, "echo two");

    assert.equal(late, undefined, "the caller is told nothing, so it falls back to a per-operation connection");
    assert.equal(node.connectionCount, 1, "no second transport was opened");
  } finally {
    pool.stop();
    await node.close();
  }
});

test("a pool nobody has started never dials", async () => {
  const node = await startFakeNode(generateHostKey());
  const pool = new ProbePool();
  try {
    // check_delegation reaches transcriptFor with no view open, and so no
    // start(): before this guard that call pooled a connection and held it
    // until an unrelated view happened to close.
    const result = await pool.run("n1", node.options, "echo one");

    assert.equal(result, undefined);
    assert.equal(node.connectionCount, 0, "nothing is held while nobody is looking");
  } finally {
    pool.stop();
    await node.close();
  }
});

test("two concurrent probes on an uncached node share one connection", async () => {
  const node = await startFakeNode(generateHostKey());
  const pool = new ProbePool();
  pool.start();
  try {
    const [a, b] = await Promise.all([
      pool.run("n1", node.options, "echo one"),
      pool.run("n1", node.options, "echo two"),
    ]);

    assert.equal(a, "");
    assert.equal(b, "");
    assert.equal(node.execCommands.length, 2, "both commands ran");
    assert.equal(node.connectionCount, 1, "the concurrent calls shared one connection");
  } finally {
    pool.stop();
    await node.close();
  }
});

test("a connect failure does not poison the node; a later run retries", async () => {
  const node = await startFakeNode(generateHostKey());
  const pool = new ProbePool();
  pool.start();
  try {
    node.faults.refuseConnections = true;
    const first = await pool.run("n1", node.options, "echo one");
    assert.equal(first, undefined, "the refused connection resolves undefined");
    assert.equal(node.connectionCount, 1, "one connection attempt was made and refused");

    node.faults.refuseConnections = false;
    const second = await pool.run("n1", node.options, "echo two");
    assert.equal(second, "", "the pool retried once the node became reachable");
    assert.equal(node.connectionCount, 2, "a second connection attempt was made, not reused from the failed promise");
    assert.deepEqual(node.execCommands, ["echo two"]);
  } finally {
    pool.stop();
    await node.close();
  }
});

test("an unreachable node yields undefined rather than throwing", async () => {
  const pool = new ProbePool();
  pool.start();
  try {
    const result = await pool.run(
      "dead",
      {
        host: "127.0.0.1",
        port: 1,
        username: "x",
        auth: { kind: "agent", agent: "" },
        knownHosts: { lookup: () => undefined, remember: () => {} },
      } as never,
      "echo hi",
    );

    assert.equal(result, undefined);
  } finally {
    pool.stop();
  }
});

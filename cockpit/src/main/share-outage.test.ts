import { test } from "node:test";
import assert from "node:assert/strict";

import { failedTry, joinRunning, olderThanTunnel, tellAfterMs, type Outage } from "./share-outage.ts";

test("a machine that is away is retried, and the operator hears once it lasts", () => {
  const outage: Outage = { since: 0, attempts: 0, told: false };
  assert.deepEqual(failedTry(outage, "connect_timeout", 10_000, true), { retry: true, tell: false }, "a hiccup is not worth a popup");
  assert.deepEqual(failedTry(outage, "no_route", tellAfterMs, true), { retry: true, tell: true });
  assert.deepEqual(failedTry(outage, "no_route", tellAfterMs * 3, true), { retry: true, tell: false }, "once per outage");
  assert.equal(outage.attempts, 3);
  assert.equal(outage.reason, "no_route");
});

// A machine that is off is not an MCP problem: nothing is said about it until
// a session there connects -- and the telling it would have had is kept for then.
test("with no session connected there, the outage is retried quietly", () => {
  const outage: Outage = { since: 0, attempts: 0, told: false };
  assert.deepEqual(failedTry(outage, "connect_timeout", tellAfterMs * 10, false), { retry: true, tell: false });
  assert.deepEqual(failedTry(outage, "auth_failed", 1, false), { retry: false, tell: false });
  assert.equal(outage.told, false);
  assert.deepEqual(failedTry(outage, "auth_failed", 2, true), { retry: false, tell: true });
});

// Failed logins repeated every minute get an address banned, and waiting
// cannot fix a key the node does not accept -- so this stops and says so.
test("a refusal that retrying cannot fix stops the retries and is told at once", () => {
  for (const reason of ["auth_failed", "host_key_unknown", "host_key_changed", "forward_denied"]) {
    const outage: Outage = { since: 0, attempts: 0, told: false };
    assert.deepEqual(failedTry(outage, reason, 1, true), { retry: false, tell: true }, reason);
  }
});

test("a failure with no reason keeps the last one it had", () => {
  const outage: Outage = { since: 0, attempts: 0, told: false };
  failedTry(outage, "refused", 1, true);
  failedTry(outage, undefined, 2, true);
  assert.equal(outage.reason, "refused");
});

test("only an agent older than the tunnel is offered the reconnect", () => {
  const listing = [
    "lepons-api-1a2b3c4d 1000", // started 1000s before the machine's now
    "lepons-web-5e6f7a8b 1990", // started 10s ago, after the tunnel came back
    "other-work 500",
    "Welcome to the node", // login noise the shell may print
    "@now 2000",
  ].join("\n");
  assert.deepEqual(olderThanTunnel(listing, ["lepons-api-1a2b3c4d", "lepons-web-5e6f7a8b", "lepons-gone-00000000"], 60), ["lepons-api-1a2b3c4d"]);
  assert.deepEqual(olderThanTunnel(listing.replace("@now 2000", ""), ["lepons-api-1a2b3c4d"], 60), [], "no clock reading, no claim");
});

test("a share asked for while one is opening joins it rather than opening a second", async () => {
  const running = new Map<string, Promise<number>>();
  let opened = 0;
  let finish!: (value: number) => void;
  const open = () => { opened += 1; return new Promise<number>((resolve) => { finish = resolve; }); };
  const first = joinRunning(running, "pc-b", open);
  const second = joinRunning(running, "pc-b", open);
  assert.equal(second, first);
  assert.equal(opened, 1);
  finish(1);
  assert.equal(await second, 1);
  // Settled, so the next ask is a new attempt -- a retry after a failure must still run.
  await joinRunning(running, "pc-b", async () => { opened += 1; return 2; });
  assert.equal(opened, 2);
});

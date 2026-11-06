import { test } from "node:test";
import assert from "node:assert/strict";

import type { RelayView } from "../shared/ipc.ts";
import { relayLamp, relayRow, relayStopped } from "./relay-state.ts";

const view = (status: RelayView["status"]): RelayView => ({ status, paired: true, server: "wss://relay.lepons.app" });

test("the paired phone's row says one of four things", () => {
  assert.equal(relayRow(view("connected")), "connected");
  assert.equal(relayRow(view("connecting")), "waiting");
  assert.equal(relayRow(view("waiting")), "waiting");
  assert.equal(relayRow(view("confirm")), "waiting");
  assert.equal(relayRow(view("replaced")), "replaced");
  assert.equal(relayRow(view("error")), "stopped");
  assert.equal(relayRow(view("off")), "stopped");
});

test("only a 4000 or an error offers 다시 연결", () => {
  assert.deepEqual((["off", "connecting", "waiting", "confirm", "connected", "replaced", "error"] as const).filter((s) => relayStopped(view(s))), ["replaced", "error"]);
});

test("the rail icon is green when connected, red when stopped by the server, muted when off", () => {
  assert.equal(relayLamp(view("connected")), "signedIn");
  assert.equal(relayLamp(view("waiting")), "waiting");
  assert.equal(relayLamp(view("connecting")), "waiting");
  assert.equal(relayLamp(view("replaced")), "failed");
  assert.equal(relayLamp(view("error")), "failed");
  assert.equal(relayLamp(view("off")), "off");
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { reconnectNoteKey, reconnectProminent } from "./pc-reconnect.ts";

test("the note after asking a PC to reconnect: asked, too soon, or not reached", () => {
  assert.equal(reconnectNoteKey(200), "reconnectAsked");
  assert.equal(reconnectNoteKey(429), "reconnectBusy");
  assert.equal(reconnectNoteKey(500), "reconnectFailed");
  assert.equal(reconnectNoteKey(404), "reconnectFailed");
  assert.equal(reconnectNoteKey(undefined), "reconnectFailed");
});

test("the refresh button stands out for a PC that is down or off, and is quiet for one that is connected", () => {
  assert.equal(reconnectProminent("failed"), true);
  assert.equal(reconnectProminent("off"), true);
  assert.equal(reconnectProminent("live"), false);
  assert.equal(reconnectProminent("connecting"), false);
  assert.equal(reconnectProminent(undefined), false);
});

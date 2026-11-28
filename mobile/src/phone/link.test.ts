import { test } from "node:test";
import assert from "node:assert/strict";
import { canAskOf, linkButton, linkWord, savedAtWords, saysBack, stillLoading } from "./link.ts";

test("connecting dial under 10s says connecting", () => {
  assert.equal(linkWord({ kind: "connecting", phase: "dial" }, 9_999), "linkConnecting");
});

test("connecting dial at 10s says server", () => {
  assert.equal(linkWord({ kind: "connecting", phase: "dial" }, 10_000), "linkServer");
});

test("handshake never says server", () => {
  assert.equal(linkWord({ kind: "connecting", phase: "handshake" }, 60_000), "linkConnecting");
});

test("waiting says pc gone", () => {
  assert.equal(linkWord({ kind: "waiting" }, 0), "linkPcGone");
});

test("confirm and connected say nothing", () => {
  assert.equal(linkWord({ kind: "confirm", code: "1234" }, 0), undefined);
  assert.equal(linkWord({ kind: "connected" }, 0), undefined);
});

test("canAsk follows status", () => {
  assert.equal(canAskOf({ kind: "connected" }, true, false), true);
  assert.equal(canAskOf({ kind: "waiting" }, true, false), false);
  assert.equal(canAskOf({ kind: "connected" }, false, false), false);
  assert.equal(canAskOf({ kind: "off" }, false, true), true);
});

test("savedAtWords shows time today", () => {
  const words = savedAtWords(new Date(2026, 10, 26, 14, 2).getTime(), new Date(2026, 10, 26, 18, 0));
  assert.ok(words.includes("14:02"));
  assert.ok(!words.includes("/"));
});

test("savedAtWords shows date when not today", () => {
  const words = savedAtWords(new Date(2026, 10, 25, 14, 2).getTime(), new Date(2026, 10, 26, 9, 0));
  assert.ok(words.includes("11/25 14:02"));
});

test("buttons per word", () => {
  assert.equal(linkButton("replaced"), "reconnectHere");
  assert.equal(linkButton("refused"), "pairAgain");
  assert.equal(linkButton("error"), "openStore");
  assert.equal(linkButton("linkConnecting"), undefined);
  assert.equal(linkButton("linkServer"), "reconnect");
});

test("the link is only said to be back after a notice said it was gone, never as the app opens", () => {
  assert.equal(saysBack(true, "connected", true), true);
  assert.equal(saysBack(false, "connected", true), false, "a blip nobody was told about");
  assert.equal(saysBack(true, "connected", false), false, "a slow first connection");
  assert.equal(saysBack(true, "confirm", true), false, "a pairing, not the link back");
});

test("loading ends with the dial, never runs on", () => {
  assert.equal(stillLoading(true, 0, 9_999), true);
  assert.equal(stillLoading(true, 0, 10_000), false);
  assert.equal(stillLoading(false, 0, 0), false);
});

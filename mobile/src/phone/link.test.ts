import { test } from "node:test";
import assert from "node:assert/strict";
import { linkWords, saysBack } from "./link.ts";

test("a PC gone from the room and a link being redialled are told apart; a good link says nothing", () => {
  assert.equal(linkWords("waiting"), "linkPcGone");
  assert.equal(linkWords("connecting"), "linkLost");
  assert.equal(linkWords("replaced"), "replaced");
  assert.equal(linkWords("connected"), undefined);
  assert.equal(linkWords("confirm"), undefined);
});

test("the link is only said to be back after a notice said it was gone, never as the app opens", () => {
  assert.equal(saysBack(true, "connected", true), true);
  assert.equal(saysBack(false, "connected", true), false, "a blip nobody was told about");
  assert.equal(saysBack(true, "connected", false), false, "a slow first connection");
  assert.equal(saysBack(true, "confirm", true), false, "a pairing, not the link back");
});

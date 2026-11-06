import { test } from "node:test";
import assert from "node:assert/strict";

import { OutputRing, reflow } from "./screen.ts";

test("the ring keeps the newest bytes up to its limit", () => {
  const ring = new OutputRing(8);
  ring.push(Buffer.from("abc"));
  ring.push(Buffer.from("defg"));
  assert.equal(ring.bytes().toString(), "abcdefg");
  ring.push(Buffer.from("hij"));
  assert.equal(ring.bytes().toString(), "cdefghij");
  ring.push(Buffer.from("0123456789"));
  assert.equal(ring.bytes().toString(), "23456789");
});

test("reading mode glues wrapped rows and drops the blank tail", () => {
  assert.deepEqual(
    reflow([
      { text: "line one is lo", wrapped: false },
      { text: "ng   ", wrapped: true },
      { text: "", wrapped: false },
      { text: "❯ 1. Yes", wrapped: false },
      { text: "", wrapped: false },
      { text: "   ", wrapped: false },
    ]),
    ["line one is long", "", "❯ 1. Yes"],
  );
  assert.deepEqual(reflow([{ text: "x", wrapped: true }]), ["x"]);
});

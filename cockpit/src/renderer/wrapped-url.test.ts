import assert from "node:assert/strict";
import { test } from "node:test";

import { urlsAt, type UrlRow } from "./wrapped-url.ts";

const rows = (...lines: Array<string | [string, true]>): ((row: number) => UrlRow | undefined) =>
  (row) => {
    const line = lines[row];
    if (line === undefined) return undefined;
    return typeof line === "string" ? { text: line, wrapped: false } : { text: line[0], wrapped: true };
  };

test("an address on one line is found as it is, without the sentence's closing mark", () => {
  const found = urlsAt(rows("open http://localhost:5173/ now (https://x.dev/a)."), 0, 80);
  assert.deepEqual(found.map((one) => one.url), ["http://localhost:5173/", "https://x.dev/a"]);
  assert.deepEqual(found[0]!.parts, [{ row: 0, index: 5, length: 22 }]);
});

test("one the terminal wrapped is joined, from either row", () => {
  const at = rows("see https://example.com/aaaa", ["bbbb/cc?x=1 done", true]);
  for (const row of [0, 1]) assert.deepEqual(urlsAt(at, row, 28).map((one) => one.url), ["https://example.com/aaaabbbb/cc?x=1"]);
  assert.deepEqual(urlsAt(at, 1, 28)[0]!.parts, [{ row: 0, index: 4, length: 24 }, { row: 1, index: 0, length: 11 }]);
});

test("one a program broke at the terminal's edge carries on past the next line's indent", () => {
  const first = "  https://accounts.example.com/o/oauth2/auth?client";
  const at = rows(first, "  _id=abc&scope=read%20write", "", "Press Enter");
  assert.deepEqual(urlsAt(at, 1, first.length).map((one) => one.url), ["https://accounts.example.com/o/oauth2/auth?client_id=abc&scope=read%20write"]);
});

test("one broken over three rows inside a box is joined to the end, from its middle row", () => {
  const at = rows(
    "┃ https://claude.ai/oauth/authorize?code=true&cl ┃",
    "┃ ient_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&r ┃",
    "┃ esponse_type=code                              ┃",
    "┃ Paste the code here                            ┃",
  );
  const found = urlsAt(at, 1, 120);
  assert.deepEqual(found.map((one) => one.url), ["https://claude.ai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code"]);
  assert.equal(found[0]!.parts.length, 3);
});

test("a row with Korean before the address is measured in cells, not letters", () => {
  const first = "자세한 내용은 https://example.com/very/long/pa";
  // 7 Korean letters are 14 cells: the row fills 54 cells in 47 letters.
  const at = (row: number): UrlRow | undefined => [{ text: first, wrapped: false, cells: first.length + 7 }, { text: "th/to/page", wrapped: false }][row];
  assert.deepEqual(urlsAt(at, 0, first.length + 7).map((one) => one.url), ["https://example.com/very/long/path/to/page"]);
});

test("closing marks that reach back over a row leave no part of them in the link", () => {
  const found = urlsAt(rows("x https://a.com/abcdef.", [")", true]), 0, 23);
  assert.deepEqual(found.map((one) => one.url), ["https://a.com/abcdef"]);
  assert.deepEqual(found[0]!.parts, [{ row: 0, index: 2, length: 20 }]);
});

test("an address a space ended one cell before the edge is not joined to a wrapped word", () => {
  assert.deepEqual(urlsAt(rows("go https://x.com/abc ", ["words here", true]), 0, 21).map((one) => one.url), ["https://x.com/abc"]);
});

test("a line that just ends early, or a short address in a wide box, is not joined to the next", () => {
  assert.deepEqual(urlsAt(rows("visit https://a.com", "next line"), 0, 80).map((one) => one.url), ["https://a.com"]);
  assert.deepEqual(urlsAt(rows("visit https://a.com", "next line"), 1, 80), []);
  const box = rows("┃ https://a.com                ┃", "┃ Next sentence                ┃");
  assert.deepEqual(urlsAt(box, 0, 120).map((one) => one.url), ["https://a.com"]);
});

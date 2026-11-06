import { test } from "node:test";
import assert from "node:assert/strict";

import { authorize, bearerFrom, newToken, tokenMatches } from "./auth.ts";

test("a token is long and unguessable", () => {
  const token = newToken();
  assert.ok(token.length >= 40, `token too short: ${token.length}`);
  assert.notEqual(token, newToken());
  assert.match(token, /^[A-Za-z0-9_-]+$/, "must survive a header without quoting");
});

test("extracts a bearer credential", () => {
  assert.equal(bearerFrom("Bearer abc123"), "abc123");
  assert.equal(bearerFrom("  Bearer   abc123  "), "abc123");
});

test("anything that is not a bearer credential yields nothing", () => {
  for (const header of [
    undefined,
    "",
    "abc123",
    "Basic abc123",
    "Bearer",
    "Bearer ",
    "Bearerabc123",
  ]) {
    assert.equal(bearerFrom(header), undefined, `accepted ${JSON.stringify(header)}`);
  }
});

test("only the exact token matches", () => {
  const token = newToken();
  assert.equal(tokenMatches(token, token), true);
  assert.equal(tokenMatches(token + "x", token), false);
  assert.equal(tokenMatches(token.slice(0, -1), token), false);
  assert.equal(tokenMatches("", token), false);
  assert.equal(tokenMatches(undefined, token), false);
});

// The endpoint sits on the node's loopback, so an unauthenticated request is
// not hypothetical: any process on that node can send one.
test("authorize refuses every request without the exact bearer token", () => {
  const token = newToken();
  assert.equal(authorize(`Bearer ${token}`, token), true);
  for (const header of [undefined, "", "Bearer wrong", `Basic ${token}`, token]) {
    assert.equal(authorize(header, token), false, `accepted ${JSON.stringify(header)}`);
  }
});

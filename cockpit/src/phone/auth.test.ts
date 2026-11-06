import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { hashPassword, passwordMatches, PhoneAuth } from "./auth.ts";

const minute = 60_000;

test("a password is kept as a salted scrypt hash and checked against it", async () => {
  const stored = await hashPassword("지하철 비밀번호");
  assert.match(stored, /^scrypt\$[\w-]+\$[\w-]+$/);
  assert.equal(stored.includes("지하철"), false);
  assert.notEqual(stored, await hashPassword("지하철 비밀번호"), "a fresh salt each time");
  assert.equal(await passwordMatches("지하철 비밀번호", stored), true);
  assert.equal(await passwordMatches("wrong", stored), false);
  assert.equal(await passwordMatches("x", "plain"), false);
});

test("five failures lock sign-in for fifteen minutes", () => {
  const auth = new PhoneAuth();
  for (let i = 0; i < 4; i++) auth.failed(0);
  assert.equal(auth.locked(0), false);
  auth.failed(0);
  assert.equal(auth.locked(0), true);
  assert.equal(auth.locked(15 * minute - 1), true);
  assert.equal(auth.locked(15 * minute), false);
});

test("a success clears the failure count", () => {
  const auth = new PhoneAuth();
  for (let i = 0; i < 4; i++) auth.failed(0);
  auth.open(0, 1);
  auth.failed(0);
  assert.equal(auth.locked(0), false);
});

test("a TOTP step is spent once used", () => {
  const auth = new PhoneAuth();
  assert.equal(auth.freshStep(10), true);
  auth.open(0, 10);
  assert.equal(auth.freshStep(10), false);
  assert.equal(auth.freshStep(9), false);
  assert.equal(auth.freshStep(11), true);
});

test("a sign-in lasts a day and has no idle limit", () => {
  const auth = new PhoneAuth();
  const token = auth.open(0, 1);
  // Untouched for nine hours: still signed in.
  assert.equal(auth.check(token, 9 * 60 * minute), true);
  assert.equal(auth.check(token, 24 * 60 * minute - 1), true);
  assert.equal(auth.check(token, 24 * 60 * minute), false);
  assert.equal(auth.check(token, 24 * 60 * minute), false, "and stays ended");
});

test("the server keeps only the cookie's hash", () => {
  const auth = new PhoneAuth();
  const token = auth.open(0, 1);
  assert.equal(Buffer.from(token, "base64url").length, 32);
  assert.deepEqual(auth.storedKeys(), [createHash("sha256").update(token).digest("hex")]);
  assert.equal(auth.storedKeys().includes(token), false);
});

test("closing all signs every phone out; an unknown token is refused", () => {
  const auth = new PhoneAuth();
  const a = auth.open(0, 1);
  const b = auth.open(0, 2);
  assert.equal(auth.count(0), 2);
  assert.equal(auth.check("made-up", 0), false);
  assert.equal(auth.check(undefined, 0), false);
  auth.closeAll();
  assert.equal(auth.check(a, 0), false);
  assert.equal(auth.check(b, 0), false);
  assert.equal(auth.count(0), 0);
});

test("a sign-in survives a restart as its hash only, and still expires", () => {
  let disk: Record<string, number> = {};
  const before = new PhoneAuth({}, (sessions) => { disk = sessions; });
  const token = before.open(1_000, 1);
  assert.equal(Object.keys(disk).length, 1);
  assert.ok(!Object.keys(disk).includes(token), "the cookie itself is never kept");
  const after = new PhoneAuth(disk, (sessions) => { disk = sessions; });
  assert.equal(after.check(token, 2_000), true);
  assert.equal(after.check(token, 1_000 + 24 * 60 * 60 * 1000), false);
  after.closeAll();
  assert.deepEqual(disk, {});
});

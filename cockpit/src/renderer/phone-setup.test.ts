import assert from "node:assert/strict";
import { test } from "node:test";

import { base32Decode } from "../phone/totp.ts";
import { cleanCode, codeShaped, firstUnfinished, keyInGroups, passwordProblem, progressShare, progressText, stepAfter, stepBefore, stepForward, type SetupFacts } from "./phone-setup.ts";

const nothing: SetupFacts = { hasPassword: false, totpReady: false, appSeen: false, paired: false };

test("the bar fills with the walk, and a step reads forward or back by its place in it", () => {
  assert.deepEqual((["password", "totp", "app", "pair", "done"] as const).map(progressShare), [0.25, 0.5, 0.75, 1, 1]);
  assert.equal(stepForward("password", "totp"), true);
  assert.equal(stepForward("pair", "done"), true);
  assert.equal(stepForward("app", "totp"), false);
});

test("the walk opens at the first step not done, so closing midway resumes there", () => {
  assert.equal(firstUnfinished(nothing), "password");
  assert.equal(firstUnfinished({ ...nothing, hasPassword: true }), "totp");
  assert.equal(firstUnfinished({ ...nothing, hasPassword: true, totpReady: true }), "app");
  assert.equal(firstUnfinished({ ...nothing, hasPassword: true, totpReady: true, appSeen: true }), "pair");
  assert.equal(firstUnfinished({ hasPassword: true, totpReady: true, appSeen: true, paired: true }), "done");
});

test("a key not yet proved by a code holds the walk there, even with a phone paired", () => {
  assert.equal(firstUnfinished({ hasPassword: true, totpReady: false, appSeen: true, paired: true }), "totp");
});

test("a phone already paired needs no download step", () => {
  assert.equal(firstUnfinished({ hasPassword: true, totpReady: true, appSeen: false, paired: true }), "done");
  assert.equal(stepAfter("totp", { hasPassword: true, totpReady: true, appSeen: false, paired: true }), "done");
});

test("unpairing later sends the walk back to the QR, not the sign-in", () => {
  assert.equal(firstUnfinished({ hasPassword: true, totpReady: true, appSeen: true, paired: false }), "pair");
});

test("forward skips what is done; back walks every step and stops at the ends", () => {
  const ready = { hasPassword: true, totpReady: true, appSeen: true, paired: false };
  assert.equal(stepAfter("password", ready), "pair");
  assert.equal(stepAfter("totp", ready), "pair");
  assert.equal(stepAfter("password", { ...ready, appSeen: false }), "app");
  assert.equal(stepBefore("pair"), "app");
  assert.equal(stepBefore("app"), "totp");
  assert.equal(stepBefore("totp"), "password");
  assert.equal(stepBefore("password"), undefined);
  assert.equal(stepBefore("done"), undefined);
});

test("progress counts the four steps and leaves the closing page out", () => {
  assert.deepEqual((["password", "totp", "app", "pair", "done"] as const).map(progressText), ["1/4", "2/4", "3/4", "4/4", ""]);
});

test("a password needs eight characters and the same again", () => {
  assert.equal(passwordProblem("", ""), "short");
  assert.equal(passwordProblem("1234567", "1234567"), "short");
  assert.equal(passwordProblem("12345678", "1234567"), "mismatch");
  assert.equal(passwordProblem("12345678", "12345678"), undefined);
});

test("a code may come with the app's space, and must be six digits", () => {
  assert.equal(cleanCode(" 123 456 "), "123456");
  assert.equal(codeShaped("123456"), true);
  assert.equal(codeShaped("12345"), false);
  assert.equal(codeShaped("12345a"), false);
  assert.equal(codeShaped("1234567"), false);
});

test("the grouped key is still the same key to an authenticator app", () => {
  const key = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
  assert.equal(keyInGroups(key), "JBSW Y3DP EHPK 3PXP JBSW Y3DP EHPK 3PXP");
  assert.deepEqual(base32Decode(keyInGroups(key)), base32Decode(key));
});

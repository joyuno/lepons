import { test } from "node:test";
import assert from "node:assert/strict";

import { withDenyRule, hasDenyRule } from "./deny.ts";

test("the rule is added to a settings file that has none", () => {
  const merged = withDenyRule(undefined, "Read(./.env)");
  assert.deepEqual(JSON.parse(merged!).permissions.deny, ["Read(./.env)"]);
});

test("existing settings are preserved", () => {
  const before = JSON.stringify({ model: "opus", permissions: { allow: ["Bash(ls:*)"] } });
  const after = JSON.parse(withDenyRule(before, "Read(./.env)")!);

  assert.equal(after.model, "opus");
  assert.deepEqual(after.permissions.allow, ["Bash(ls:*)"]);
  assert.deepEqual(after.permissions.deny, ["Read(./.env)"]);
});

test("an already-present rule is not added twice", () => {
  const before = JSON.stringify({ permissions: { deny: ["Read(./.env)"] } });
  assert.equal(withDenyRule(before, "Read(./.env)"), undefined);
});

test("settings that are not JSON are left alone", () => {
  assert.equal(withDenyRule("{ not json", "Read(./.env)"), undefined);
});

// Parsing is not understanding: `permissions` that is an array or a string
// parses fine and would be spread into `{"0": …}`, quietly replacing the
// operator's settings with a mangled version of them.
test("settings whose permissions is not an object are left alone", () => {
  for (const permissions of [[1, 2], "all", 7, null]) {
    const before = JSON.stringify({ permissions });
    assert.equal(withDenyRule(before, "Read(./.env)"), undefined, before);
    assert.equal(hasDenyRule(before, "Read(./.env)"), false, before);
  }
});

test("hasDenyRule distinguishes already-present from unreadable", () => {
  const before = JSON.stringify({ permissions: { deny: ["Read(./.env)"] } });
  assert.equal(hasDenyRule(before, "Read(./.env)"), true);
  assert.equal(hasDenyRule(before, "Read(./other)"), false);
  assert.equal(hasDenyRule(undefined, "Read(./.env)"), false);
  assert.equal(hasDenyRule("{ not json", "Read(./.env)"), false);
});
